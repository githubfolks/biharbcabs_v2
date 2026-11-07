/**
 * Security tests: webhook signature, duplicate deliveries, and who may act on a booking.
 * Runs against a disposable database whose name ends in _test (schema, crm_settings, migrations 08 and 09):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/security.integration.ts
 *
 * WhatsApp sends are simulated when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { verifyMetaSignature } from '../lib/webhook-security';
import { acceptRideOffer } from '../lib/dispatch-engine';
import { completeTripAndSettle } from '../lib/billing';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';
import { POST as webhookPOST } from '../app/api/whatsapp/webhook/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const SECRET = 'test-app-secret-not-real';
const DRIVER_A = '910000000301';
const DRIVER_B = '910000000302';
const CUSTOMER = '910000000401';
const STRANGER = '910000000499';
let driverA = 0, driverB = 0, customerId = 0, seq = 0;

const sign = (body: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
function metaBody(from: string, buttonId: string, messageId = `wamid.test.${Date.now()}.${seq++}`) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Tester' } }], messages: [{ id: messageId, from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'x' } } }] } }] }],
  });
}
async function postWebhook(body: string, signature: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  const res = await webhookPOST(new NextRequest('http://localhost:3001/api/whatsapp/webhook', { method: 'POST', body, headers }));
  return { status: res.status, json: await res.json() };
}
async function booking(status: string, assigned: number | null) {
  const r = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status)
     VALUES ($1, $2, $3, 'oneway', 'Patna', 'Gaya', 'Patna Jn', CURRENT_DATE, '10:00', 'sedan', 2000, 1900, 100, $4) RETURNING id`,
    [`BC-S${seq++}${Date.now() % 10000}`, customerId, assigned, status]
  );
  return Number(r.rows[0].id);
}
const statusOf = async (id: number) => (await query(`SELECT booking_status, assigned_driver_id FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const offer = (bookingId: number, driverId: number, status = 'PENDING') =>
  query(`INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, 1900, $3)`, [bookingId, driverId, status]);

before(async () => {
  const driver = async (phone: string) => Number((await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating) VALUES ($1, $1, 'Driver', 'Patna', 'APPROVED_ACTIVE', true, 4.9) RETURNING id`,
    [phone]
  )).rows[0].id);
  driverA = await driver(DRIVER_A);
  driverB = await driver(DRIVER_B);
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Customer') RETURNING id`, [CUSTOMER])).rows[0].id);
});
after(async () => { await getDbPool().end(); });

describe('webhook signature', () => {
  it('accepts only a correct HMAC-SHA256 of the exact body', () => {
    const body = '{"a":1}';
    assert.strictEqual(verifyMetaSignature(body, sign(body), SECRET), true);
    assert.strictEqual(verifyMetaSignature(body, sign(body).toUpperCase().replace('SHA256=', 'sha256='), SECRET), true, 'hex case does not matter');
    assert.strictEqual(verifyMetaSignature(body, sign(body, 'wrong'), SECRET), false, 'wrong secret');
    assert.strictEqual(verifyMetaSignature('{"a":2}', sign(body), SECRET), false, 'tampered body');
    assert.strictEqual(verifyMetaSignature('{ "a":1}', sign(body), SECRET), false, 'reformatted body');
    assert.strictEqual(verifyMetaSignature(body, null, SECRET), false, 'missing header');
    assert.strictEqual(verifyMetaSignature(body, sign(body).replace('sha256=', ''), SECRET), false, 'missing prefix');
    assert.strictEqual(verifyMetaSignature(body, 'sha256=abc', SECRET), false, 'short signature');
    assert.strictEqual(verifyMetaSignature(body, sign(body), ''), false, 'no secret configured');
  });

  it('rejects every event while the App Secret is not configured', async () => {
    delete process.env.META_APP_SECRET;
    const body = metaBody(STRANGER, 'reached_home');
    assert.strictEqual((await postWebhook(body, sign(body))).status, 503);
  });

  it('rejects unsigned or wrongly signed events, and processes nothing', async () => {
    process.env.META_APP_SECRET = SECRET;
    const id = await booking('DRIVER_ASSIGNED', driverA);
    const body = metaBody(DRIVER_A, `start_trip_${id}`);
    assert.strictEqual((await postWebhook(body, null)).status, 401);
    assert.strictEqual((await postWebhook(body, sign(body, 'attacker-guess'))).status, 401);
    assert.strictEqual((await statusOf(id)).booking_status, 'DRIVER_ASSIGNED', 'forged event had no effect');

    const ok = await postWebhook(body, sign(body));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await statusOf(id)).booking_status, 'TRIP_IN_PROGRESS', 'genuine event processed');
  });

  it('a repeated delivery of the same message is ignored, so a trip is settled once', async () => {
    process.env.META_APP_SECRET = SECRET;
    const id = await booking('TRIP_IN_PROGRESS', driverA);
    const wallet = async () => Number((await query(`SELECT wallet_balance FROM crm_drivers WHERE id = $1`, [driverA])).rows[0].wallet_balance);
    const before = await wallet();
    const body = metaBody(DRIVER_A, `complete_trip_${id}`, `wamid.dup.${Date.now()}`);
    const first = await postWebhook(body, sign(body));
    assert.strictEqual(first.json.status, 'success');
    const afterFirst = await wallet();
    const second = await postWebhook(body, sign(body));
    assert.strictEqual(second.json.status, 'duplicate_ignored');
    assert.strictEqual(await wallet(), afterFirst, 'wallet changed only once');
    assert.notStrictEqual(afterFirst, before, 'first delivery did settle');
    const ledger = (await query(`SELECT count(*)::int n FROM crm_bookings WHERE id = $1 AND booking_status = 'COMPLETED_SETTLED'`, [id])).rows[0].n;
    assert.strictEqual(ledger, 1);
  });
});

describe('accepting rides', () => {
  it('a driver who was not offered the ride cannot take it', async () => {
    const id = await booking('AWAITING_DRIVER', null);
    await offer(id, driverA);
    const res = await acceptRideOffer(id, driverB);
    assert.strictEqual(res.status, 'NOT_OFFERED');
    assert.strictEqual((await statusOf(id)).assigned_driver_id, null);
  });

  it('two offered drivers race: the first wins, the second is told it is taken', async () => {
    const id = await booking('AWAITING_DRIVER', null);
    await offer(id, driverA);
    await offer(id, driverB);
    const [a, b] = await Promise.all([acceptRideOffer(id, driverA), acceptRideOffer(id, driverB)]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, ['ALREADY_ASSIGNED', 'ASSIGNED'].sort());
    const winner = a.status === 'ASSIGNED' ? driverA : driverB;
    assert.strictEqual(Number((await statusOf(id)).assigned_driver_id), winner);
  });

  it('a declined offer cannot be accepted later', async () => {
    const id = await booking('AWAITING_DRIVER', null);
    await offer(id, driverA, 'DECLINED');
    assert.strictEqual((await acceptRideOffer(id, driverA)).status, 'OFFER_EXPIRED');
  });

  it('accepting by text message is checked the same way', async () => {
    const id = await booking('AWAITING_DRIVER', null);
    await offer(id, driverA);
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_B, text: `accept ${id}` });
    assert.strictEqual((await statusOf(id)).assigned_driver_id, null);
  });
});

describe('trip actions belong to the assigned driver', () => {
  it('another driver cannot start or complete the trip', async () => {
    const id = await booking('DRIVER_ASSIGNED', driverA);
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_B, buttonId: `start_trip_${id}` });
    assert.strictEqual((await statusOf(id)).booking_status, 'DRIVER_ASSIGNED');
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_A, buttonId: `start_trip_${id}` });
    assert.strictEqual((await statusOf(id)).booking_status, 'TRIP_IN_PROGRESS');

    await processIncomingWhatsAppMessage({ fromPhone: STRANGER, buttonId: `complete_trip_${id}` });
    assert.strictEqual((await statusOf(id)).booking_status, 'TRIP_IN_PROGRESS');
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_A, buttonId: `complete_trip_${id}` });
    assert.strictEqual((await statusOf(id)).booking_status, 'COMPLETED_SETTLED');
  });

  it('a trip cannot be started before assignment or completed before it starts', async () => {
    const waiting = await booking('AWAITING_DRIVER', driverA);
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_A, buttonId: `start_trip_${waiting}` });
    assert.strictEqual((await statusOf(waiting)).booking_status, 'AWAITING_DRIVER');
    const assigned = await booking('DRIVER_ASSIGNED', driverA);
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_A, buttonId: `complete_trip_${assigned}` });
    assert.strictEqual((await statusOf(assigned)).booking_status, 'DRIVER_ASSIGNED');
  });

  it('settlement refuses a trip that is already settled', async () => {
    const id = await booking('TRIP_IN_PROGRESS', driverA);
    await completeTripAndSettle({ bookingId: id, cashCollectedByDriver: 2000 });
    await assert.rejects(completeTripAndSettle({ bookingId: id, cashCollectedByDriver: 2000 }), /already completed and settled/);
  });

  it("a driver cannot see another driver's dues", async () => {
    const mark = Number((await query(`SELECT COALESCE(MAX(id), 0) id FROM crm_whatsapp_logs`)).rows[0].id);
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_B, buttonId: `pay_dues_${driverA}` });
    const sent = (await query(`SELECT payload::text p FROM crm_whatsapp_logs WHERE id > $1 AND phone = $2`, [mark, DRIVER_B])).rows.map((r) => r.p).join(' ');
    assert.match(sent, /not linked to your number/);
    assert.doesNotMatch(sent, /Amount to Clear/);
  });
});

describe('ratings belong to the customer', () => {
  it('only the customer of a settled trip can rate it', async () => {
    const id = await booking('COMPLETED_SETTLED', driverA);
    const ratings = async () => (await query(`SELECT count(*)::int n FROM crm_driver_ratings WHERE booking_id = $1`, [id])).rows[0].n;
    await processIncomingWhatsAppMessage({ fromPhone: STRANGER, buttonId: `rate_trip_${id}_low` });
    await processIncomingWhatsAppMessage({ fromPhone: DRIVER_B, buttonId: `rate_trip_${id}_5` });
    assert.strictEqual(await ratings(), 0, 'strangers cannot rate');
    await processIncomingWhatsAppMessage({ fromPhone: CUSTOMER, buttonId: `rate_trip_${id}_5` });
    assert.strictEqual(await ratings(), 1, 'the customer can');
  });

  it('a trip cannot be rated before it is settled', async () => {
    const id = await booking('TRIP_IN_PROGRESS', driverA);
    await processIncomingWhatsAppMessage({ fromPhone: CUSTOMER, buttonId: `rate_trip_${id}_5` });
    assert.strictEqual((await query(`SELECT count(*)::int n FROM crm_driver_ratings WHERE booking_id = $1`, [id])).rows[0].n, 0);
  });
});
