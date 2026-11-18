/**
 * Cancellations and advance refunds (agreed policy): customer cancels 2+ hours before pickup -> full refund;
 * later -> no refund (BiharCabs keeps it); BiharCabs cancels -> full refund at any time.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 18):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/cancellations.integration.ts
 *
 * Razorpay's HTTP API is simulated in this test only; WhatsApp sends are simulated without a Meta token.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { calculateRideSplitWithTaxes, broadcastRideToDrivers } from '../lib/dispatch-engine';
import { decideRefund, getFreeCancellationHours } from '../lib/cancellations';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';
import { POST as razorpayWebhookPOST } from '../app/api/payments/razorpay/webhook/route';
import * as cancelRoute from '../app/api/bookings/[id]/cancel/route';
import * as refundsRoute from '../app/api/finance/refunds/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const WEBHOOK_SECRET = 'test-razorpay-secret-cancel';
process.env.RAZORPAY_KEY_ID = 'rzp_test_notreal';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;

// ---- Razorpay simulation (test only) ----
let refundMode: 'pending' | 'processed' | 'fail' = 'pending';
const refundCalls: any[] = [];
const linkCancels: string[] = [];
const realFetch = globalThis.fetch;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const refund = u.match(/\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/);
  if (refund) {
    refundCalls.push({ paymentId: refund[1], body: JSON.parse(init.body) });
    if (refundMode === 'fail') return json({ error: { description: 'simulated refund failure' } }, 400);
    return json({ id: `rfnd_${crypto.randomBytes(6).toString('hex')}`, status: refundMode, amount: JSON.parse(init.body).amount });
  }
  const cancel = u.match(/\/v1\/payment_links\/(plink_[A-Za-z0-9]+)\/cancel$/);
  if (cancel) {
    linkCancels.push(cancel[1]);
    return json({ id: cancel[1], status: 'cancelled' });
  }
  return realFetch(url, init);
}) as typeof fetch;

const sign = (body: string) => crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
async function webhook(event: any, eventId = `evt_${crypto.randomBytes(6).toString('hex')}`) {
  const body = JSON.stringify(event);
  const res = await razorpayWebhookPOST(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': eventId },
  }));
  return (await res.json()).status;
}
const refundEvent = (event: string, refund: any, over: any = {}) => ({
  event, payload: { refund: { entity: { id: refund.provider_refund_id, payment_id: refund.provider_payment_id, amount: refund.amount_paise, receipt: `refund-${refund.id}`, status: event === 'refund.processed' ? 'processed' : 'failed', ...over } } },
});

/** IST date and time `hoursFromNow` ahead, as stored on bookings. */
function pickupIn(hoursFromNow: number) {
  const ist = new Date(Date.now() + hoursFromNow * 3600e3 + 5.5 * 3600e3).toISOString();
  return { pickup_date: ist.slice(0, 10), pickup_time: ist.slice(11, 16) };
}

let financeToken = '';
let dispatcherToken = '';
const adminIds: number[] = [];
async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(`INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Cancel Tester', $4, true) RETURNING id`,
    [`cancel-${RUN}-${adminIds.length}@example.test`, hash, salt, role]);
  adminIds.push(Number(r.rows[0].id));
  return (await createAdminSession(Number(r.rows[0].id))).token;
}

/** A booking for a fresh customer; with an advance, a PAID Razorpay link like the webhook leaves. */
async function booking(opts: { hours: number; advance?: number; status?: string; driverId?: number }) {
  const cust = `9133${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const c = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Cancel Customer') RETURNING id`, [cust]);
  const s = await calculateRideSplitWithTaxes(2500);
  const advance = opts.advance ?? 0;
  const { pickup_date, pickup_time } = pickupIn(opts.hours);
  const b = (await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, advance_paid, advance_status, payment_mode, balance_cash_due_from_customer, booking_status, start_otp_hash)
     VALUES ($1, $2, $3, 'oneway', 'Patna', 'Gaya', 'Main Road', $4, $5, 'sedan', 2500, $6, $7, $8, $9, $10, $11, $12, 'hash') RETURNING *`,
    [`BC-C${RUN}${seq++}`, c.rows[0].id, opts.driverId ?? null, pickup_date, pickup_time, s.driverGrossEarnings, s.totalCompanyDuesZ,
     advance, advance > 0 ? 'PAID' : 'NOT_REQUIRED', advance > 0 ? 'ADVANCE_ONLINE' : 'FULL_CASH', 2500 - advance, opts.status || 'AWAITING_DRIVER']
  )).rows[0];
  if (advance > 0) {
    await query(
      `INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, short_url, status, provider_payment_id, expire_by, paid_at)
       VALUES ($1, $2, $3, $4, 'https://rzp.io/i/x', 'PAID', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [b.id, `plink_${crypto.randomBytes(7).toString('hex')}`, `ref-${RUN}-${seq++}`, advance * 100, `pay_${crypto.randomBytes(7).toString('hex')}`]
    );
  }
  return { ...b, cust };
}
const row = async (id: number) => (await query(`SELECT * FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const refundFor = async (bookingId: number) => (await query(`SELECT * FROM crm_refunds WHERE booking_id = $1`, [bookingId])).rows[0];
const refundLedger = async (bookingId: number) => (await query(`SELECT * FROM crm_payments_ledger WHERE booking_id = $1 AND transaction_type = 'CUSTOMER_ADVANCE_REFUND'`, [bookingId])).rows;
const lastTo = async (p: string) => JSON.stringify((await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0]?.payload || '');
const staffCancel = async (token: string, bookingId: number, fault: string, reason = 'Customer phoned to cancel') => {
  const res = await cancelRoute.POST(new NextRequest(`http://localhost:3001/api/bookings/${bookingId}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` }, body: JSON.stringify({ fault, reason }),
  }), { params: { id: String(bookingId) } });
  return { status: res.status, json: await res.json() };
};

let freeHours = 0;
before(async () => {
  financeToken = await admin('FINANCE_MANAGER');
  dispatcherToken = await admin('DISPATCHER');
  freeHours = await getFreeCancellationHours();
});
after(async () => {
  globalThis.fetch = realFetch;
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('refund policy', () => {
  it('2+ hours before pickup: full refund; later: none; BiharCabs at fault: always full', () => {
    const now = new Date('2026-12-01T10:00:00+05:30');
    const at = (h: number) => new Date(now.getTime() + h * 3600e3);
    assert.deepStrictEqual([decideRefund(250, at(5), now, 'CUSTOMER', 2).refund, decideRefund(250, at(5), now, 'CUSTOMER', 2).forfeit], [250, 0]);
    assert.strictEqual(decideRefund(250, at(2), now, 'CUSTOMER', 2).refund, 250, 'exactly 2 hours still counts');
    assert.deepStrictEqual([decideRefund(250, at(1.99), now, 'CUSTOMER', 2).refund, decideRefund(250, at(1.99), now, 'CUSTOMER', 2).forfeit], [0, 250]);
    assert.strictEqual(decideRefund(250, at(0.5), now, 'BIHARCABS', 2).refund, 250);
    assert.strictEqual(decideRefund(250, at(-1), now, 'BIHARCABS', 2).refund, 250, 'even after pickup time');
    assert.deepStrictEqual(decideRefund(0, at(5), now, 'CUSTOMER', 2), { refund: 0, forfeit: 0, explanation: 'No advance was paid, so there is nothing to refund.' });
  });
});

describe('customer cancels on WhatsApp', () => {
  it('2+ hours ahead: sees the full refund, confirms, booking cancelled and refunded to the original payment', async () => {
    const d = (await query(`INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating) VALUES ($1, $1, 'Cancel Driver', 'Patna', 'APPROVED_ACTIVE', 4.5) RETURNING id, phone`,
      [`9144${String(Date.now()).slice(-6)}${seq++}`])).rows[0];
    const b = await booking({ hours: freeHours + 5, advance: 250, status: 'DRIVER_ASSIGNED', driverId: Number(d.id) });
    await query(`INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, 1, 'PENDING')`, [b.id, d.id]);

    await processIncomingWhatsAppMessage({ fromPhone: b.cust, text: 'CANCEL' });
    const prompt = await lastTo(b.cust);
    assert.ok(prompt.includes(`cancel_confirm_${b.id}`) && prompt.includes('refunded in full'), 'customer sees the outcome before confirming');
    assert.strictEqual((await row(b.id)).booking_status, 'DRIVER_ASSIGNED', 'nothing happens until they confirm');

    refundMode = 'pending';
    refundCalls.length = 0;
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, buttonId: `cancel_confirm_${b.id}` });
    const r = await row(b.id);
    assert.strictEqual(r.booking_status, 'CANCELLED');
    assert.strictEqual(r.cancelled_by, 'CUSTOMER');
    assert.strictEqual(Number(r.refund_due_amount), 250);
    assert.strictEqual(Number(r.forfeited_amount), 0);
    assert.strictEqual(r.start_otp_hash, null);
    assert.strictEqual(refundCalls.length, 1);
    const paidLink = (await query(`SELECT provider_payment_id FROM crm_payment_links WHERE booking_id = $1`, [b.id])).rows[0];
    assert.strictEqual(refundCalls[0].paymentId, paidLink.provider_payment_id, 'refunded to the original payment');
    assert.strictEqual(refundCalls[0].body.amount, 25000);
    const refund = await refundFor(b.id);
    assert.strictEqual(refund.status, 'PENDING');
    assert.ok(refund.provider_refund_id.startsWith('rfnd_'));
    assert.strictEqual((await refundLedger(b.id)).length, 0, 'booked only once Razorpay processes it');
    assert.strictEqual((await query(`SELECT offer_status FROM crm_dispatch_offers WHERE booking_id = $1`, [b.id])).rows[0].offer_status, 'EXPIRED');
    assert.ok((await lastTo(d.phone)).includes('cancelled'), 'assigned driver told');
    assert.ok((await lastTo(b.cust)).includes('250'), 'customer told about the refund');
  });

  it('less than 2 hours ahead: no refund; BiharCabs keeps the advance', async () => {
    const b = await booking({ hours: freeHours - 1, advance: 250 });
    refundCalls.length = 0;
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, text: 'cancel' });
    assert.ok((await lastTo(b.cust)).includes('not refundable'));
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, buttonId: `cancel_confirm_${b.id}` });
    const r = await row(b.id);
    assert.strictEqual(r.booking_status, 'CANCELLED');
    assert.strictEqual(Number(r.refund_due_amount), 0);
    assert.strictEqual(Number(r.forfeited_amount), 250);
    assert.strictEqual(refundCalls.length, 0);
    assert.strictEqual(await refundFor(b.id), undefined);
  });

  it('Keep booking changes nothing; another number cannot cancel it; a started trip is not cancellable here', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, buttonId: `cancel_keep_${b.id}` });
    assert.strictEqual((await row(b.id)).booking_status, 'AWAITING_DRIVER');
    const other = await booking({ hours: 10 });
    await processIncomingWhatsAppMessage({ fromPhone: other.cust, buttonId: `cancel_confirm_${b.id}` });
    assert.strictEqual((await row(b.id)).booking_status, 'AWAITING_DRIVER');
    assert.ok((await lastTo(other.cust)).includes('not linked to your number'));

    const started = await booking({ hours: 0, status: 'TRIP_IN_PROGRESS' });
    await processIncomingWhatsAppMessage({ fromPhone: started.cust, text: 'CANCEL' });
    assert.ok((await lastTo(started.cust)).includes('already started'));
    assert.strictEqual((await row(started.id)).booking_status, 'TRIP_IN_PROGRESS');
  });

  it('a booking still waiting for its advance: the payment link is closed at Razorpay, nothing to refund', async () => {
    const b = await booking({ hours: 10, status: 'AWAITING_ADVANCE' });
    const linkId = `plink_${crypto.randomBytes(7).toString('hex')}`;
    await query(`INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, short_url, status, expire_by)
                 VALUES ($1, $2, $3, 25000, 'https://rzp.io/i/y', 'CREATED', CURRENT_TIMESTAMP + INTERVAL '30 minutes')`, [b.id, linkId, `ref-${RUN}-${seq++}`]);
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, text: 'CANCEL' });
    await processIncomingWhatsAppMessage({ fromPhone: b.cust, buttonId: `cancel_confirm_${b.id}` });
    assert.ok(linkCancels.includes(linkId));
    assert.strictEqual((await query(`SELECT status FROM crm_payment_links WHERE provider_link_id = $1`, [linkId])).rows[0].status, 'CANCELLED');
    assert.strictEqual((await row(b.id)).booking_status, 'CANCELLED');
    assert.strictEqual(await refundFor(b.id), undefined);
  });
});

describe('staff cancel', () => {
  it('BiharCabs at fault, even 30 minutes before pickup: full refund', async () => {
    const b = await booking({ hours: 0.5, advance: 250 });
    const r = await staffCancel(dispatcherToken, b.id, 'BIHARCABS', 'No driver available');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.refundAmount, 250);
    const saved = await row(b.id);
    assert.strictEqual(saved.cancellation_fault, 'BIHARCABS');
    assert.ok(saved.cancelled_by_admin, 'who cancelled is recorded');
  });

  it('refuses a trip in progress or completed, a missing reason, and a bad fault', async () => {
    for (const status of ['TRIP_IN_PROGRESS', 'COMPLETED_SETTLED']) {
      const b = await booking({ hours: 10, status });
      assert.strictEqual((await staffCancel(dispatcherToken, b.id, 'CUSTOMER')).status, 409, status);
    }
    const b = await booking({ hours: 10 });
    assert.strictEqual((await staffCancel(dispatcherToken, b.id, 'CUSTOMER', 'x')).status, 400);
    assert.strictEqual((await staffCancel(dispatcherToken, b.id, 'DRIVER', 'Valid reason')).status, 400);
    assert.strictEqual((await row(b.id)).booking_status, 'AWAITING_DRIVER');
  });

  it('a cancelled booking cannot be broadcast back to life', async () => {
    const b = await booking({ hours: 10 });
    await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    await assert.rejects(() => broadcastRideToDrivers(b.id), /cannot be broadcast/);
    assert.strictEqual((await row(b.id)).booking_status, 'CANCELLED');
  });
});

describe('refund outcome', () => {
  it('Razorpay processed (webhook): booked to the ledger once, even if reported again', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    refundMode = 'pending';
    await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    const refund = await refundFor(b.id);
    const eventId = `evt_rf_${RUN}${seq++}`;
    assert.strictEqual(await webhook(refundEvent('refund.processed', refund), eventId), 'refund_processed');
    assert.strictEqual((await refundFor(b.id)).status, 'PROCESSED');
    assert.strictEqual(await webhook(refundEvent('refund.processed', refund), eventId), 'duplicate_ignored');
    assert.strictEqual(await webhook(refundEvent('refund.processed', refund)), 'refund_already_processed');
    const ledger = await refundLedger(b.id);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(Number(ledger[0].amount), 250);
    assert.strictEqual(ledger[0].direction, 'DEBIT');
  });

  it('a refund processed at once is booked immediately', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    refundMode = 'processed';
    const r = await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    refundMode = 'pending';
    assert.strictEqual(r.json.refundStatus, 'PROCESSED');
    assert.strictEqual((await refundLedger(b.id)).length, 1);
  });

  it('the webhook can arrive before our request stored the refund id: matched on our receipt', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    const refund = await refundFor(b.id);
    await query(`UPDATE crm_refunds SET provider_refund_id = NULL, status = 'SUBMITTING' WHERE id = $1`, [refund.id]);
    const earlyId = `rfnd_early${RUN}${seq++}`;
    assert.strictEqual(await webhook(refundEvent('refund.processed', { ...refund, provider_refund_id: earlyId })), 'refund_processed');
    assert.strictEqual((await refundFor(b.id)).provider_refund_id, earlyId);
  });

  it('a refund event that does not match what we asked for is not accepted', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    const refund = await refundFor(b.id);
    assert.strictEqual(await webhook(refundEvent('refund.processed', refund, { amount: 99900 })), 'refund_mismatch_review');
    assert.strictEqual((await refundFor(b.id)).status, 'PENDING');
    assert.strictEqual((await refundLedger(b.id)).length, 0);
  });

  it('a failed refund is shown to finance and retried exactly once, even if retried twice at the same moment', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    refundMode = 'fail';
    const r = await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    assert.strictEqual(r.json.refundStatus, 'FAILED');
    const failed = await refundFor(b.id);
    assert.match(failed.last_error, /simulated refund failure/);

    const list = await (await refundsRoute.GET(new NextRequest('http://localhost:3001/api/finance/refunds', { headers: { cookie: `${SESSION_COOKIE_NAME}=${financeToken}` } }))).json();
    assert.ok(list.refunds.some((x: any) => Number(x.id) === Number(failed.id) && x.status === 'FAILED'));

    const retry = (token: string) => refundsRoute.POST(new NextRequest('http://localhost:3001/api/finance/refunds', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` }, body: JSON.stringify({ refundId: failed.id }),
    }));
    assert.strictEqual((await retry(dispatcherToken)).status, 403, 'only finance retries refunds');
    refundMode = 'pending';
    refundCalls.length = 0;
    await Promise.all([retry(financeToken), retry(financeToken)]);
    assert.strictEqual(refundCalls.length, 1, 'never refunded twice');
    assert.strictEqual((await refundFor(b.id)).status, 'PENDING');
  });

  it('Razorpay reports a refund failed: marked FAILED for retry', async () => {
    const b = await booking({ hours: 10, advance: 250 });
    refundMode = 'pending';
    await staffCancel(dispatcherToken, b.id, 'CUSTOMER');
    const refund = await refundFor(b.id);
    assert.strictEqual(await webhook(refundEvent('refund.failed', refund)), 'refund_failed');
    assert.strictEqual((await refundFor(b.id)).status, 'FAILED');
  });
});
