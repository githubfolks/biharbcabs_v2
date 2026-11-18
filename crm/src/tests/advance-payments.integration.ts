/**
 * Customer advance via Razorpay Payment Links: which rides need it, the booking waiting for it,
 * the signed webhook that confirms it, and that unpaid bookings never reach drivers.
 * Runs against a disposable database whose name ends in _test (schema, crm_settings, migrations 08 to 11):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/advance-payments.integration.ts
 *
 * Razorpay's HTTP API is simulated in this test only (global fetch is replaced); WhatsApp sends are
 * simulated when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { updateSetting, getAdvanceCollectionPolicy, getAllSettings } from '../lib/settings';
import { isAdvanceRequired } from '../lib/advance-payments';
import { broadcastRideToDrivers } from '../lib/dispatch-engine';
import { completeTripAndSettle } from '../lib/billing';
import { processIncomingWhatsAppMessage, updateConversation } from '../lib/whatsapp-bot';
import { POST as razorpayWebhookPOST } from '../app/api/payments/razorpay/webhook/route';
import { POST as bookingsPOST } from '../app/api/bookings/route';
import * as advanceRoute from '../app/api/bookings/[id]/advance/route';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { WAIVABLE_STATUSES as WAIVABLE } from '../lib/advance-rules';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const WEBHOOK_SECRET = 'test-razorpay-webhook-secret-not-real';
process.env.RAZORPAY_KEY_ID = 'rzp_test_notreal';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN = String(Date.now()).slice(-6);
let seq = 0;
const phone = () => `9177${RUN}${String(seq++).padStart(2, '0')}`;

// ---- Razorpay simulation (test only) ----
type RzpMode = 'ok' | 'fail';
let rzpMode: RzpMode = 'ok';
/** How a cancel call behaves: succeed, or fail with the link already paid / expired, or Razorpay down. */
let rzpCancelMode: 'ok' | 'paid' | 'expired' | 'down' = 'ok';
const rzpLinks = new Map<string, string>();
const rzpCalls: any[] = [];
const realFetch = globalThis.fetch;
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('https://api.razorpay.com/')) {
    const body = init.body ? JSON.parse(init.body) : undefined;
    rzpCalls.push({ url: u, method: init.method, auth: init.headers.Authorization, body });
    const m = u.match(/\/payment_links\/(plink_[A-Za-z0-9]+)(\/cancel)?$/);
    if (m) {
      if (rzpCancelMode === 'down') return json({ error: { description: 'simulated outage' } }, 500);
      if (m[2]) {
        if (rzpCancelMode === 'paid') { rzpLinks.set(m[1], 'paid'); return json({ error: { description: 'already paid' } }, 400); }
        if (rzpCancelMode === 'expired') { rzpLinks.set(m[1], 'expired'); return json({ error: { description: 'cannot cancel or expire an expired link' } }, 400); }
        rzpLinks.set(m[1], 'cancelled');
        return json({ id: m[1], status: 'cancelled' });
      }
      return json({ id: m[1], status: rzpLinks.get(m[1]) || 'created' });
    }
    if (rzpMode === 'fail') return json({ error: { description: 'simulated outage' } }, 500);
    const id = `plink_${crypto.randomBytes(7).toString('hex')}`;
    rzpLinks.set(id, 'created');
    return json({ id, short_url: `https://rzp.io/i/${id.slice(6, 14)}`, status: 'created', amount: body.amount });
  }
  return realFetch(url, init);
}) as typeof fetch;

const sign = (body: string, secret = WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
async function postWebhook(event: any, opts: { eventId?: string; signature?: string | null } = {}) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-razorpay-event-id': opts.eventId || `evt_${crypto.randomBytes(6).toString('hex')}` };
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers['x-razorpay-signature'] = signature;
  const res = await razorpayWebhookPOST(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', { method: 'POST', body, headers }));
  return { status: res.status, json: await res.json() };
}
const paidEvent = (linkId: string, paise: number, over: { paidPaise?: number; currency?: string } = {}) => ({
  entity: 'event',
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: linkId, amount: paise, amount_paid: over.paidPaise ?? paise, status: 'paid' } },
    payment: { entity: { id: `pay_${crypto.randomBytes(6).toString('hex')}`, amount: over.paidPaise ?? paise, currency: over.currency || 'INR', status: 'captured' } },
  },
});
const closedEvent = (linkId: string, event = 'payment_link.expired') => ({
  entity: 'event',
  event,
  payload: { payment_link: { entity: { id: linkId, status: event === 'payment_link.expired' ? 'expired' : 'cancelled' } } },
});

const bookingFor = async (customerPhone: string) =>
  (await query(
    `SELECT b.* FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE c.phone = $1 ORDER BY b.id DESC LIMIT 1`,
    [customerPhone]
  )).rows[0];
const linkFor = async (bookingId: number) => (await query(`SELECT * FROM crm_payment_links WHERE booking_id = $1 ORDER BY id DESC LIMIT 1`, [bookingId])).rows[0];
const advanceLedger = async (bookingId: number) =>
  (await query(`SELECT * FROM crm_payments_ledger WHERE booking_id = $1 AND transaction_type = 'CUSTOMER_ADVANCE'`, [bookingId])).rows;
const offersFor = async (bookingId: number) => Number((await query(`SELECT COUNT(*) FROM crm_dispatch_offers WHERE booking_id = $1`, [bookingId])).rows[0].count);
const lastMessageTo = async (to: string) =>
  (await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [to])).rows[0]?.payload;

const TRIP = (over: Record<string, any> = {}) => ({
  trip_type: 'oneway',
  origin: 'Patna',
  destination: 'Gaya',
  selected_vehicle: 'sedan',
  total_fare: 2500,
  distance_km: 110,
  pickup_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  pickup_time: '10:00',
  pickup_at: new Date(Date.now() + 86400000).toISOString(),
  ...over,
});

/** Walk the bot from the pickup-landmark step. The landmark text avoids words the bot reads as a route. */
async function bookViaBot(customerPhone: string, ctx: Record<string, any>) {
  await updateConversation(customerPhone, 'AWAITING_LANDMARK', ctx, 'CUSTOMER');
  await processIncomingWhatsAppMessage({ fromPhone: customerPhone, customerName: 'Advance Tester', text: 'Gandhi Maidan Gate 2' });
}

let driverId = 0;
let originalPolicy: any;

before(async () => {
  originalPolicy = (await getAllSettings(true)).advance_collection_policy;
  await updateSetting('advance_collection_policy', { required_trip_types: ['oneway', 'roundtrip'], required_above_fare: 3000, payment_window_minutes: 30 });
  const p = phone();
  const d = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, wallet_balance)
     VALUES ($1, $1, 'Advance Test Driver', 'Patna', 'APPROVED_ACTIVE', true, 4.9, 0) RETURNING id`,
    [p]
  );
  driverId = Number(d.rows[0].id);
  await query(
    `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`,
    [driverId, `BR01ADV${RUN}`]
  );
});

after(async () => {
  if (originalPolicy !== undefined) await updateSetting('advance_collection_policy', originalPolicy);
  await query(`UPDATE crm_drivers SET is_available = false WHERE id = $1`, [driverId]);
  globalThis.fetch = realFetch;
  await getDbPool().end();
});

describe('which rides need the advance online', () => {
  it('applies trip type and fare rules', () => {
    const policy = { required_trip_types: ['oneway', 'roundtrip'], required_above_fare: 3000, payment_window_minutes: 30 };
    assert.strictEqual(isAdvanceRequired(policy, 'oneway', 500), true, 'outstation trip type');
    assert.strictEqual(isAdvanceRequired(policy, 'ROUNDTRIP', 500), true, 'case does not matter');
    assert.strictEqual(isAdvanceRequired(policy, 'airport', 2999), false, 'below fare threshold');
    assert.strictEqual(isAdvanceRequired(policy, 'airport', 3000), true, 'at the threshold');
    assert.strictEqual(isAdvanceRequired({ ...policy, required_above_fare: null }, 'airport', 99999), false, 'no fare rule');
  });

  it('fails safe: invalid settings require the advance for every ride', async () => {
    await updateSetting('advance_collection_policy', { required_trip_types: 'oneway', payment_window_minutes: 5 });
    const policy = await getAdvanceCollectionPolicy();
    assert.strictEqual(isAdvanceRequired(policy, 'airport', 100), true);
    await updateSetting('advance_collection_policy', { required_trip_types: ['oneway', 'roundtrip'], required_above_fare: 3000, payment_window_minutes: 30 });
  });
});

describe('WhatsApp booking', () => {
  it('optional ride: customer chooses full cash, booking goes to drivers with no advance recorded', async () => {
    const cust = phone();
    await bookViaBot(cust, TRIP({ trip_type: 'airport', destination: 'Patna Airport', total_fare: 1500 }));
    assert.strictEqual(await bookingFor(cust), undefined, 'no booking until the customer chooses');
    const conv = (await query(`SELECT state FROM crm_whatsapp_conversations WHERE phone = $1`, [cust])).rows[0];
    assert.strictEqual(conv.state, 'AWAITING_PAYMENT_CHOICE');

    await processIncomingWhatsAppMessage({ fromPhone: cust, customerName: 'Advance Tester', buttonId: 'pay_mode_cash', buttonText: 'Full cash to driver' });
    const b = await bookingFor(cust);
    assert.strictEqual(b.payment_mode, 'FULL_CASH');
    assert.strictEqual(b.advance_status, 'NOT_REQUIRED');
    assert.strictEqual(Number(b.advance_paid), 0);
    assert.strictEqual(Number(b.advance_due_amount), 0);
    assert.strictEqual(Number(b.balance_cash_due_from_customer), Number(b.customer_total_fare));
    assert.notStrictEqual(b.booking_status, 'AWAITING_ADVANCE');
    assert.strictEqual(await linkFor(Number(b.id)), undefined, 'no payment link for a cash ride');
    assert.ok((await offersFor(Number(b.id))) > 0, 'drivers were offered the ride');
  });

  it('required ride: booking waits for the advance with a Razorpay link and is not sent to drivers', async () => {
    const cust = phone();
    rzpCalls.length = 0;
    await bookViaBot(cust, TRIP());
    const b = await bookingFor(cust);
    assert.strictEqual(b.booking_status, 'AWAITING_ADVANCE');
    assert.strictEqual(b.payment_mode, 'ADVANCE_ONLINE');
    assert.strictEqual(Number(b.advance_paid), 0, 'nothing recorded as paid before the webhook');
    assert.ok(Number(b.advance_due_amount) >= 200);
    assert.strictEqual(await offersFor(Number(b.id)), 0, 'drivers do not see an unpaid booking');

    const link = await linkFor(Number(b.id));
    assert.strictEqual(link.status, 'CREATED');
    assert.strictEqual(link.amount_paise, Math.round(Number(b.advance_due_amount) * 100));
    const call = rzpCalls[0];
    assert.strictEqual(call.url, 'https://api.razorpay.com/v1/payment_links');
    assert.strictEqual(call.body.amount, link.amount_paise);
    assert.strictEqual(call.body.currency, 'INR');
    assert.ok(call.body.reference_id.length <= 40);
    assert.ok(call.body.expire_by >= Math.floor(Date.now() / 1000) + 15 * 60, 'expiry at least 15 minutes ahead');
    assert.ok(call.auth.startsWith('Basic '));
    const msg = await lastMessageTo(cust);
    assert.ok(JSON.stringify(msg).includes(link.short_url), 'customer got the payment link');
  });

  it('server decides: a cash choice on a ride that needs the advance still gets a payment link', async () => {
    const cust = phone();
    await updateConversation(cust, 'AWAITING_PAYMENT_CHOICE', { ...TRIP(), pickup_address: 'Gandhi Maidan Gate 2' }, 'CUSTOMER');
    await processIncomingWhatsAppMessage({ fromPhone: cust, customerName: 'Advance Tester', buttonId: 'pay_mode_cash', buttonText: 'Full cash to driver' });
    const b = await bookingFor(cust);
    assert.strictEqual(b.payment_mode, 'ADVANCE_ONLINE');
    assert.strictEqual(b.booking_status, 'AWAITING_ADVANCE');
  });

  it('Razorpay failure: booking is marked ADVANCE_LINK_FAILED and the customer is told it is not confirmed', async () => {
    const cust = phone();
    rzpMode = 'fail';
    try {
      await bookViaBot(cust, TRIP());
    } finally {
      rzpMode = 'ok';
    }
    const b = await bookingFor(cust);
    assert.strictEqual(b.booking_status, 'ADVANCE_LINK_FAILED');
    assert.strictEqual(await offersFor(Number(b.id)), 0);
    assert.ok(JSON.stringify(await lastMessageTo(cust)).includes('not confirmed'));
  });
});

describe('Razorpay webhook', () => {
  let cust = '';
  let bookingId = 0;
  let linkId = '';
  let paise = 0;

  before(async () => {
    cust = phone();
    await bookViaBot(cust, TRIP());
    const b = await bookingFor(cust);
    bookingId = Number(b.id);
    const link = await linkFor(bookingId);
    linkId = link.provider_link_id;
    paise = link.amount_paise;
  });

  it('rejects a bad or missing signature and changes nothing', async () => {
    assert.strictEqual((await postWebhook(paidEvent(linkId, paise), { signature: sign('{}') })).status, 401);
    assert.strictEqual((await postWebhook(paidEvent(linkId, paise), { signature: null })).status, 401);
    assert.strictEqual((await postWebhook(paidEvent(linkId, paise), { signature: sign(JSON.stringify(paidEvent(linkId, paise)), 'wrong-secret') })).status, 401);
    assert.strictEqual((await bookingFor(cust)).booking_status, 'AWAITING_ADVANCE');
  });

  it('rejects an event without an event id', async () => {
    const body = JSON.stringify(paidEvent(linkId, paise));
    const res = await razorpayWebhookPOST(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
    }));
    assert.strictEqual(res.status, 400);
  });

  it('confirms the exact captured amount, records it once, then sends the ride to drivers', async () => {
    const eventId = `evt_paid_${RUN}`;
    const res = await postWebhook(paidEvent(linkId, paise), { eventId });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'advance_confirmed');

    const b = await bookingFor(cust);
    assert.strictEqual(Number(b.advance_paid), paise / 100);
    assert.strictEqual(b.advance_status, 'PAID');
    assert.strictEqual(Number(b.balance_cash_due_from_customer), Number(b.customer_total_fare) - paise / 100);
    assert.ok(!['AWAITING_ADVANCE', 'ADVANCE_EXPIRED'].includes(b.booking_status));
    assert.strictEqual((await linkFor(bookingId)).status, 'PAID');
    const ledger = await advanceLedger(bookingId);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(Number(ledger[0].amount), paise / 100);
    assert.strictEqual(ledger[0].payment_channel, 'RAZORPAY');
    assert.ok((await offersFor(bookingId)) > 0, 'drivers were offered the ride after payment');

    // Same event delivered again, and a different event for the same paid link: no second credit.
    assert.strictEqual((await postWebhook(paidEvent(linkId, paise), { eventId })).json.status, 'duplicate_ignored');
    assert.strictEqual((await postWebhook(paidEvent(linkId, paise))).json.status, 'already_paid');
    assert.strictEqual((await advanceLedger(bookingId)).length, 1);
  });

  it('settlement uses the advance actually received', async () => {
    await query(`UPDATE crm_bookings SET assigned_driver_id = $1, booking_status = 'TRIP_IN_PROGRESS' WHERE id = $2`, [driverId, bookingId]);
    const b = await bookingFor(cust);
    const cash = Number(b.customer_total_fare) - Number(b.advance_paid);
    const result = await completeTripAndSettle({ bookingId, cashCollectedByDriver: cash });
    // BiharCabs holds the advance; the driver is owed advance minus BiharCabs' dues.
    const expected = parseFloat((Number(b.advance_paid) - Number(b.commission_amount)).toFixed(2));
    assert.strictEqual(result.advancePaid, Number(b.advance_paid));
    assert.ok(Math.abs(result.driverNetSettlement - expected) <= Number(result.securityReserveDeducted || 0) + Number(result.streakBonusAwarded || 0) + 0.01);
    assert.strictEqual(result.balanceCustomerDue, 0);
  });

  it('does not confirm a payment that differs from the expected amount or currency', async () => {
    for (const over of [{ paidPaise: paise - 100 }, { currency: 'USD' }]) {
      const c = phone();
      await bookViaBot(c, TRIP());
      const b = await bookingFor(c);
      const link = await linkFor(Number(b.id));
      const res = await postWebhook(paidEvent(link.provider_link_id, link.amount_paise, over));
      assert.strictEqual(res.json.status, 'amount_mismatch_review');
      assert.strictEqual((await bookingFor(c)).booking_status, 'AWAITING_ADVANCE');
      assert.strictEqual(Number((await bookingFor(c)).advance_paid), 0);
      assert.strictEqual((await linkFor(Number(b.id))).status, 'REVIEW_REQUIRED');
      assert.strictEqual((await advanceLedger(Number(b.id))).length, 0);
    }
  });

  it('expiry closes the booking, which can then never be dispatched', async () => {
    const c = phone();
    await bookViaBot(c, TRIP());
    const b = await bookingFor(c);
    const link = await linkFor(Number(b.id));
    const res = await postWebhook(closedEvent(link.provider_link_id));
    assert.strictEqual(res.json.status, 'booking_expired');
    assert.strictEqual((await bookingFor(c)).booking_status, 'ADVANCE_EXPIRED');
    await assert.rejects(() => broadcastRideToDrivers(Number(b.id)), /advance not paid/);
    assert.strictEqual(await offersFor(Number(b.id)), 0);

    // Paid after it closed: money is recorded for staff to reinstate or refund; booking is not dispatched.
    const late = await postWebhook(paidEvent(link.provider_link_id, link.amount_paise));
    assert.strictEqual(late.json.status, 'paid_after_close_review');
    const afterLate = await bookingFor(c);
    assert.strictEqual(afterLate.booking_status, 'ADVANCE_EXPIRED');
    assert.strictEqual(afterLate.advance_status, 'PAID_AFTER_CLOSE');
    assert.strictEqual((await advanceLedger(Number(b.id))).length, 1, 'the money received is on the ledger');
    assert.strictEqual(await offersFor(Number(b.id)), 0);
  });

  it('refuses to dispatch a booking still waiting for its advance', async () => {
    const c = phone();
    await bookViaBot(c, TRIP());
    const b = await bookingFor(c);
    await assert.rejects(() => broadcastRideToDrivers(Number(b.id)), /advance not paid/);
  });

  it('ignores events for links it did not create', async () => {
    const res = await postWebhook(paidEvent('plink_unknown000000', 20000));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'unknown_link_ignored');
  });
});

describe('admin booking route', () => {
  it('refuses requests without a valid admin session', async () => {
    const res = await bookingsPOST(new NextRequest('http://localhost:3001/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ customer_phone: phone(), origin_city: 'Patna', pickup_date: '2026-12-01', pickup_time: '10:00', wp_vehicle_code: 'sedan', customer_total_fare: 2500, advance_mode: 'WAIVED', advance_waiver_reason: 'x' }),
      headers: { 'content-type': 'application/json', cookie: 'biharcabs_crm_session=forged-token' },
    }));
    assert.strictEqual(res.status, 401);
  });
});

describe('waiving the advance on a pending booking', () => {
  let financeId = 0;
  let financeToken = '';
  let dispatcherToken = '';
  const adminIds: number[] = [];

  async function admin(role: string) {
    const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
    const r = await query(
      `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Waiver Tester', $4, true) RETURNING id`,
      [`waiver-${RUN}-${adminIds.length}@example.test`, hash, salt, role]
    );
    adminIds.push(Number(r.rows[0].id));
    return Number(r.rows[0].id);
  }
  const waive = (bookingId: number, token: string, reason = 'Customer has no UPI; confirmed by phone') =>
    advanceRoute.POST(
      new NextRequest(`http://localhost:3001/api/bookings/${bookingId}/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: JSON.stringify({ action: 'waive', reason }),
      }),
      { params: { id: String(bookingId) } }
    );
  async function pendingBooking() {
    const c = phone();
    await bookViaBot(c, TRIP());
    const b = await bookingFor(c);
    return { cust: c, b, link: await linkFor(Number(b.id)) };
  }

  before(async () => {
    financeId = await admin('FINANCE_MANAGER');
    financeToken = (await createAdminSession(financeId)).token;
    dispatcherToken = (await createAdminSession(await admin('DISPATCHER'))).token;
  });
  after(async () => {
    rzpCancelMode = 'ok';
    await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
    await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  });

  it('finance waives: the link is cancelled at Razorpay, the ride becomes full cash and goes to drivers', async () => {
    const { cust, b, link } = await pendingBooking();
    rzpCalls.length = 0;
    const res = await waive(Number(b.id), financeToken);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.dispatched, true);
    assert.ok(rzpCalls.some((c) => c.method === 'POST' && c.url.endsWith(`/payment_links/${link.provider_link_id}/cancel`)), 'link cancelled at Razorpay');

    const w = await bookingFor(cust);
    assert.strictEqual(w.payment_mode, 'FULL_CASH');
    assert.strictEqual(w.advance_status, 'WAIVED');
    assert.strictEqual(Number(w.advance_waived_by), financeId);
    assert.ok(w.advance_waiver_reason.includes('no UPI'));
    assert.strictEqual(Number(w.advance_due_amount), 0);
    assert.strictEqual(Number(w.balance_cash_due_from_customer), Number(w.customer_total_fare));
    assert.ok(!WAIVABLE.includes(w.booking_status), `left the pending statuses (now ${w.booking_status})`);
    assert.strictEqual((await linkFor(Number(b.id))).status, 'CANCELLED');
    assert.ok((await offersFor(Number(b.id))) > 0, 'drivers were offered the ride');
    assert.ok(JSON.stringify(await lastMessageTo(cust)).includes('in cash'), 'customer told to pay cash');

    // Razorpay's own "cancelled" webhook arriving afterwards changes nothing.
    const late = await postWebhook(closedEvent(link.provider_link_id, 'payment_link.cancelled'));
    assert.strictEqual(late.json.status, 'link_already_closed');
    assert.strictEqual((await bookingFor(cust)).advance_status, 'WAIVED');
  });

  it('refuses when the customer has already paid the link, and changes nothing', async () => {
    const { cust, b } = await pendingBooking();
    rzpCancelMode = 'paid';
    try {
      const res = await waive(Number(b.id), financeToken);
      assert.strictEqual(res.status, 409);
      assert.ok((await res.json()).error.includes('already paid'));
    } finally {
      rzpCancelMode = 'ok';
    }
    const after = await bookingFor(cust);
    assert.strictEqual(after.booking_status, 'AWAITING_ADVANCE');
    assert.strictEqual(after.advance_status, 'PENDING');
    assert.strictEqual((await linkFor(Number(b.id))).status, 'CREATED');
  });

  it('proceeds when Razorpay says the link already expired (webhook not here yet)', async () => {
    const { cust, b } = await pendingBooking();
    rzpCancelMode = 'expired';
    try {
      assert.strictEqual((await waive(Number(b.id), financeToken)).status, 200);
    } finally {
      rzpCancelMode = 'ok';
    }
    assert.strictEqual((await bookingFor(cust)).advance_status, 'WAIVED');
  });

  it('refuses when Razorpay cannot be reached, and changes nothing', async () => {
    const { cust, b } = await pendingBooking();
    rzpCancelMode = 'down';
    try {
      const res = await waive(Number(b.id), financeToken);
      assert.strictEqual(res.status, 502);
    } finally {
      rzpCancelMode = 'ok';
    }
    assert.strictEqual((await bookingFor(cust)).booking_status, 'AWAITING_ADVANCE');
    assert.strictEqual(await offersFor(Number(b.id)), 0);
  });

  it('waives a booking whose link failed or expired, without calling Razorpay for a closed link', async () => {
    rzpMode = 'fail';
    const failed = await pendingBooking().finally(() => { rzpMode = 'ok'; });
    assert.strictEqual(failed.b.booking_status, 'ADVANCE_LINK_FAILED');
    rzpCalls.length = 0;
    assert.strictEqual((await waive(Number(failed.b.id), financeToken)).status, 200);
    assert.strictEqual(rzpCalls.length, 0, 'no link, no Razorpay call');

    const expired = await pendingBooking();
    await postWebhook(closedEvent(expired.link.provider_link_id));
    assert.strictEqual((await bookingFor(expired.cust)).booking_status, 'ADVANCE_EXPIRED');
    rzpCalls.length = 0;
    assert.strictEqual((await waive(Number(expired.b.id), financeToken)).status, 200);
    assert.strictEqual(rzpCalls.length, 0, 'link already closed');
    assert.strictEqual((await bookingFor(expired.cust)).advance_status, 'WAIVED');
  });

  it('refuses bookings that are not pending, already paid after closing, past pickup, or a short reason', async () => {
    const paid = await pendingBooking();
    await postWebhook(paidEvent(paid.link.provider_link_id, paid.link.amount_paise));
    assert.strictEqual((await waive(Number(paid.b.id), financeToken)).status, 409, 'advance already paid and confirmed');

    const late = await pendingBooking();
    await postWebhook(closedEvent(late.link.provider_link_id));
    await postWebhook(paidEvent(late.link.provider_link_id, late.link.amount_paise));
    assert.strictEqual((await bookingFor(late.cust)).advance_status, 'PAID_AFTER_CLOSE');
    const lateRes = await waive(Number(late.b.id), financeToken);
    assert.strictEqual(lateRes.status, 409);
    assert.ok((await lateRes.json()).error.includes('Reinstate or refund'));

    const past = await pendingBooking();
    await query(`UPDATE crm_bookings SET pickup_date = CURRENT_DATE - 1 WHERE id = $1`, [past.b.id]);
    assert.strictEqual((await waive(Number(past.b.id), financeToken)).status, 409, 'pickup already passed');

    const short = await pendingBooking();
    assert.strictEqual((await waive(Number(short.b.id), financeToken, 'too short')).status, 400);
    assert.strictEqual((await bookingFor(short.cust)).booking_status, 'AWAITING_ADVANCE');
  });

  it('a dispatcher cannot waive', async () => {
    const { cust, b } = await pendingBooking();
    assert.strictEqual((await waive(Number(b.id), dispatcherToken)).status, 403);
    assert.strictEqual((await bookingFor(cust)).booking_status, 'AWAITING_ADVANCE');
  });
});
