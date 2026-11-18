/**
 * Driver dues payments: paid through a Razorpay link from the bot (recorded by the signed webhook) or
 * recorded by finance; the wallet is credited and a dues restriction lifted once within the credit limit.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 17):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/dues-payments.integration.ts
 *
 * Razorpay's HTTP API is simulated in this test only; WhatsApp sends are simulated without a Meta token.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { getRevenueProtectionPolicy } from '../lib/settings';
import { creditLimitFor, recordManualDuesPayment, DuesError } from '../lib/driver-dues';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';
import { POST as razorpayWebhookPOST } from '../app/api/payments/razorpay/webhook/route';
import * as duesRoute from '../app/api/finance/dues-payments/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const WEBHOOK_SECRET = 'test-razorpay-secret-dues';
process.env.RAZORPAY_KEY_ID = 'rzp_test_notreal';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
const ref = () => `UTR${RUN}${String(seq++).padStart(4, '0')}`;

// ---- Razorpay simulation (test only) ----
const rzpCreates: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url) === 'https://api.razorpay.com/v1/payment_links') {
    const body = JSON.parse(init.body);
    rzpCreates.push(body);
    const id = `plink_${crypto.randomBytes(7).toString('hex')}`;
    return new Response(JSON.stringify({ id, short_url: `https://rzp.io/i/${id.slice(6, 14)}`, status: 'created' }), { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

const sign = (body: string) => crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
async function webhook(event: any, eventId = `evt_${crypto.randomBytes(6).toString('hex')}`) {
  const body = JSON.stringify(event);
  const res = await razorpayWebhookPOST(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': eventId },
  }));
  return { status: res.status, json: await res.json() };
}
const paidEvent = (linkId: string, paise: number, paidPaise = paise) => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: linkId, amount: paise, amount_paid: paidPaise, status: 'paid' } },
    payment: { entity: { id: `pay_${crypto.randomBytes(6).toString('hex')}`, amount: paidPaise, currency: 'INR', status: 'captured' } },
  },
});

let financeId = 0;
let financeToken = '';
let dispatcherToken = '';
const adminIds: number[] = [];
async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(`INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Dues Tester', $4, true) RETURNING id`,
    [`dues-${RUN}-${adminIds.length}@example.test`, hash, salt, role]);
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}
/** A probation-tier driver (rating 4.0) unless given; limit comes from settings. */
async function driver(wallet: number, status = 'RESTRICTED_DIGITAL_ONLY', rating = 4.0) {
  const phone = `9199${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, total_trips_completed, wallet_balance)
     VALUES ($1, $1, 'Dues Driver', 'Patna', $2, $3, $4, 3, $5) RETURNING id`,
    [phone, status, status !== 'SUSPENDED_UNPAID_DUES', rating, wallet]
  );
  return { id: Number(r.rows[0].id), phone };
}
const state = async (id: number) => (await query(`SELECT wallet_balance, onboarding_status, is_available FROM crm_drivers WHERE id = $1`, [id])).rows[0];
const duesRows = async (id: number) => (await query(`SELECT * FROM crm_payments_ledger WHERE driver_id = $1 AND transaction_type = 'DRIVER_DUES_PAYMENT'`, [id])).rows;
const lastTo = async (p: string) => JSON.stringify((await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0]?.payload || '');
const duesLink = async (driverId: number) => (await query(`SELECT * FROM crm_payment_links WHERE purpose = 'DRIVER_DUES' AND driver_id = $1 ORDER BY id DESC LIMIT 1`, [driverId])).rows[0];

let probationLimit = 0;
before(async () => {
  financeId = await admin('FINANCE_MANAGER');
  financeToken = (await createAdminSession(financeId)).token;
  dispatcherToken = (await createAdminSession(await admin('DISPATCHER'))).token;
  probationLimit = (await getRevenueProtectionPolicy()).dynamic_credit_limits.probation_or_new;
});
after(async () => {
  globalThis.fetch = realFetch;
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_drivers SET is_available = false WHERE full_name = 'Dues Driver'`);
  await getDbPool().end();
});

describe('credit limit tiers', () => {
  it('match the dues guardrail rule', async () => {
    const p = await getRevenueProtectionPolicy();
    assert.strictEqual(creditLimitFor({ rating: p.elite_min_rating, total_trips_completed: p.elite_min_trips }, p), p.dynamic_credit_limits.elite);
    assert.strictEqual(creditLimitFor({ rating: p.elite_min_rating, total_trips_completed: p.elite_min_trips - 1 }, p), p.dynamic_credit_limits.standard);
    assert.strictEqual(creditLimitFor({ rating: p.standard_min_rating, total_trips_completed: 0 }, p), p.dynamic_credit_limits.standard);
    assert.strictEqual(creditLimitFor({ rating: p.standard_min_rating - 0.01, total_trips_completed: 99 }, p), p.dynamic_credit_limits.probation_or_new);
  });
});

describe('finance records a dues payment', () => {
  it('credits the wallet, audits it, and lifts the restriction once within the limit', async () => {
    const owed = probationLimit + 200;
    const d = await driver(-owed);
    const r = await recordManualDuesPayment({ driverId: d.id, amount: 250, channel: 'UPI', reference: ref(), adminId: financeId });
    assert.strictEqual(r.newWalletBalance, -(owed - 250));
    assert.strictEqual(r.restored, true, `${owed - 250} is within the ${probationLimit} limit`);
    const s = await state(d.id);
    assert.strictEqual(s.onboarding_status, 'APPROVED_ACTIVE');
    assert.strictEqual(s.is_available, true);
    const rows = await duesRows(d.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].direction, 'CREDIT');
    assert.strictEqual(Number(rows[0].recorded_by), financeId);
  });

  it('a partial payment still over the limit keeps the restriction', async () => {
    const d = await driver(-(probationLimit + 200));
    const r = await recordManualDuesPayment({ driverId: d.id, amount: 100, channel: 'CASH', reference: ref(), adminId: financeId });
    assert.strictEqual(r.restored, false);
    assert.strictEqual((await state(d.id)).onboarding_status, 'RESTRICTED_DIGITAL_ONLY');
  });

  it('a hard-suspended driver who clears dues becomes available again', async () => {
    const d = await driver(-800, 'SUSPENDED_UNPAID_DUES');
    assert.strictEqual((await state(d.id)).is_available, false);
    await recordManualDuesPayment({ driverId: d.id, amount: 800, channel: 'BANK_TRANSFER', reference: ref(), adminId: financeId });
    const s = await state(d.id);
    assert.strictEqual(Number(s.wallet_balance), 0);
    assert.strictEqual(s.onboarding_status, 'APPROVED_ACTIVE');
    assert.strictEqual(s.is_available, true);
  });

  it('never lifts a suspension that is not about dues', async () => {
    const d = await driver(-400, 'SUSPENDED_DOC_EXPIRED');
    await recordManualDuesPayment({ driverId: d.id, amount: 400, channel: 'UPI', reference: ref(), adminId: financeId });
    assert.strictEqual((await state(d.id)).onboarding_status, 'SUSPENDED_DOC_EXPIRED');
  });

  it('refuses more than is owed, a driver who owes nothing, a reused reference, and bad input', async () => {
    const d = await driver(-500);
    const isDues = (status: number) => (e: any) => e instanceof DuesError && e.status === status;
    await assert.rejects(() => recordManualDuesPayment({ driverId: d.id, amount: 500.01, channel: 'UPI', reference: ref(), adminId: financeId }), isDues(400));
    const reused = ref();
    await recordManualDuesPayment({ driverId: d.id, amount: 100, channel: 'UPI', reference: reused, adminId: financeId });
    await assert.rejects(() => recordManualDuesPayment({ driverId: d.id, amount: 100, channel: 'UPI', reference: reused, adminId: financeId }), isDues(409));
    assert.strictEqual(Number((await state(d.id)).wallet_balance), -400, 'the duplicate changed nothing');
    for (const bad of [{ amount: 0 }, { amount: 10.001 }, { channel: 'PAYTM' }, { reference: '123' }]) {
      await assert.rejects(() => recordManualDuesPayment({ driverId: d.id, amount: 10, channel: 'UPI', reference: ref(), adminId: financeId, ...bad }), isDues(400), JSON.stringify(bad));
    }
    const clear = await driver(0, 'APPROVED_ACTIVE');
    await assert.rejects(() => recordManualDuesPayment({ driverId: clear.id, amount: 10, channel: 'UPI', reference: ref(), adminId: financeId }), isDues(400));
  });

  it('two payments at the same moment cannot together exceed what is owed', async () => {
    const d = await driver(-500);
    const results = await Promise.allSettled([
      recordManualDuesPayment({ driverId: d.id, amount: 300, channel: 'UPI', reference: ref(), adminId: financeId }),
      recordManualDuesPayment({ driverId: d.id, amount: 300, channel: 'UPI', reference: ref(), adminId: financeId }),
    ]);
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(Number((await state(d.id)).wallet_balance), -200);
  });

  it('API: finance can record; a dispatcher cannot; the owing list shows only drivers who owe', async () => {
    const d = await driver(-600);
    const clear = await driver(50, 'APPROVED_ACTIVE');
    const call = (handler: any, token: string, body?: any) => handler(new NextRequest('http://localhost:3001/api/finance/dues-payments', {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const list = await (await call(duesRoute.GET, financeToken)).json();
    const ids = list.drivers.map((x: any) => Number(x.id));
    assert.ok(ids.includes(d.id) && !ids.includes(clear.id));
    const body = { driverId: d.id, amount: 600, channel: 'UPI', reference: ref() };
    assert.strictEqual((await call(duesRoute.POST, dispatcherToken, body)).status, 403);
    const ok = await call(duesRoute.POST, financeToken, body);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(Number((await state(d.id)).wallet_balance), 0);
    assert.ok((await lastTo(d.phone)).includes('recorded'), 'driver notified');
  });
});

describe('driver pays through the bot (Razorpay)', () => {
  it('"Pay dues" sends a link for exactly what is owed, and reuses it on a second tap', async () => {
    const d = await driver(-450);
    rzpCreates.length = 0;
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `pay_dues_${d.id}` });
    const link = await duesLink(d.id);
    assert.strictEqual(link.amount_paise, 45000);
    assert.strictEqual(link.booking_id, null);
    assert.ok((await lastTo(d.phone)).includes(link.short_url));
    assert.ok(!(await lastTo(d.phone)).includes('UTR'), 'no more "reply with your UTR"');
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `pay_dues_${d.id}` });
    assert.strictEqual(rzpCreates.length, 1, 'second tap reuses the open link');
  });

  it('a driver who owes nothing is told so (no payment link)', async () => {
    const d = await driver(120, 'APPROVED_ACTIVE');
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `pay_dues_${d.id}` });
    assert.ok((await lastTo(d.phone)).includes('no dues'));
    assert.strictEqual(await duesLink(d.id), undefined);
  });

  it('another number cannot get a link for someone else\'s dues', async () => {
    const d = await driver(-300);
    const other = await driver(-300);
    await processIncomingWhatsAppMessage({ fromPhone: other.phone, buttonId: `pay_dues_${d.id}` });
    assert.strictEqual(await duesLink(d.id), undefined);
  });

  it('the signed webhook records the payment once, lifts the restriction, and tells the driver', async () => {
    const d = await driver(-(probationLimit + 150));
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `pay_dues_${d.id}` });
    const link = await duesLink(d.id);
    const eventId = `evt_dues_${RUN}`;
    const res = await webhook(paidEvent(link.provider_link_id, link.amount_paise), eventId);
    assert.strictEqual(res.json.status, 'dues_payment_recorded');
    const s = await state(d.id);
    assert.strictEqual(Number(s.wallet_balance), 0);
    assert.strictEqual(s.onboarding_status, 'APPROVED_ACTIVE');
    const paid = await duesLink(d.id);
    assert.strictEqual(paid.status, 'PAID');
    assert.strictEqual(paid.gst_amount, null, 'no GST: dues settle commission already invoiced');
    assert.strictEqual(paid.receipt_voucher_number, null);
    const rows = await duesRows(d.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].payment_channel, 'RAZORPAY');
    assert.strictEqual(rows[0].reference_id, paid.provider_payment_id);
    assert.ok((await lastTo(d.phone)).includes('received'));

    assert.strictEqual((await webhook(paidEvent(link.provider_link_id, link.amount_paise), eventId)).json.status, 'duplicate_ignored');
    assert.strictEqual((await webhook(paidEvent(link.provider_link_id, link.amount_paise))).json.status, 'already_paid');
    assert.strictEqual((await duesRows(d.id)).length, 1, 'credited once');
  });

  it('a payment that does not match is not credited; an expired link changes nothing', async () => {
    const d = await driver(-500);
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `pay_dues_${d.id}` });
    const link = await duesLink(d.id);
    assert.strictEqual((await webhook(paidEvent(link.provider_link_id, link.amount_paise, link.amount_paise - 100))).json.status, 'amount_mismatch_review');
    assert.strictEqual(Number((await state(d.id)).wallet_balance), -500);
    assert.strictEqual((await duesLink(d.id)).status, 'REVIEW_REQUIRED');

    const d2 = await driver(-500);
    await processIncomingWhatsAppMessage({ fromPhone: d2.phone, buttonId: `pay_dues_${d2.id}` });
    const link2 = await duesLink(d2.id);
    const expired = await webhook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: link2.provider_link_id, status: 'expired' } } } });
    assert.strictEqual(expired.json.status, 'dues_link_expired');
    assert.strictEqual(Number((await state(d2.id)).wallet_balance), -500);
  });
});
