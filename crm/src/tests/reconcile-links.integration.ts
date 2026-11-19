/**
 * Payment links whose Razorpay expiry webhook never arrived are reconciled by the frequent job.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 22):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/reconcile-links.integration.ts
 *
 * Razorpay's HTTP API is simulated in this test only; WhatsApp sends are simulated without a Meta token.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { reconcileStalePaymentLinks } from '../lib/advance-payments';
import { executeFrequentCronTasks } from '../lib/cron-service';
import { POST as razorpayWebhookPOST } from '../app/api/payments/razorpay/webhook/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const WEBHOOK_SECRET = 'test-razorpay-secret-reconcile';
process.env.RAZORPAY_KEY_ID = 'rzp_test_notreal';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;

// ---- Razorpay simulation (test only): GET /v1/payment_links/{id} answers from this map ----
const razorpayStatus = new Map<string, string | 'DOWN'>();
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const m = String(url).match(/\/v1\/payment_links\/(plink_[A-Za-z0-9]+)$/);
  if (m && (init?.method || 'GET') === 'GET') {
    fetched.push(m[1]);
    const status = razorpayStatus.get(m[1]) ?? 'created';
    if (status === 'DOWN') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ id: m[1], status }), { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

let customerId = 0;
let customerPhone = '';
/** A booking waiting for its advance, with a CREATED link that expired `minutesAgo` minutes ago. */
async function waitingBooking(minutesAgo: number, razorpay: string | 'DOWN') {
  const b = (await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, advance_due_amount, advance_status, payment_mode, booking_status)
     VALUES ($1, $2, 'oneway', 'Patna', 'Gaya', 'Main Road', CURRENT_DATE + 1, '10:00', 'sedan', 2500, 2280, 220, 250, 'PENDING', 'ADVANCE_ONLINE', 'AWAITING_ADVANCE')
     RETURNING id, booking_code`,
    [`BC-R${RUN}${seq++}`, customerId]
  )).rows[0];
  const linkId = `plink_${crypto.randomBytes(7).toString('hex')}`;
  await query(
    `INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, short_url, status, expire_by)
     VALUES ($1, $2, $3, 25000, 'https://rzp.io/i/r', 'CREATED', CURRENT_TIMESTAMP - make_interval(mins => $4))`,
    [b.id, linkId, `rec-${RUN}-${seq++}`, minutesAgo]
  );
  razorpayStatus.set(linkId, razorpay);
  return { bookingId: Number(b.id), bookingCode: b.booking_code, linkId };
}
const link = async (id: string) => (await query(`SELECT * FROM crm_payment_links WHERE provider_link_id = $1`, [id])).rows[0];
const bookingStatus = async (id: number) => (await query(`SELECT booking_status, advance_status FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const adminLogCount = async (text: string) =>
  Number((await query(`SELECT COUNT(*) FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND payload::text LIKE $1`, [`%${text}%`])).rows[0].count);

before(async () => {
  // Close open links left by earlier test runs, so this run's links are the ones the job checks.
  await query(`UPDATE crm_payment_links SET status = 'EXPIRED' WHERE status = 'CREATED' AND expire_by < CURRENT_TIMESTAMP`);
  customerPhone = `9155${String(Date.now()).slice(-6)}${seq++}`;
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Reconcile Customer') RETURNING id`, [customerPhone])).rows[0].id);
});
after(async () => {
  globalThis.fetch = realFetch;
  await getDbPool().end();
});

describe('reconciling links whose expiry webhook never arrived', () => {
  it('expired at Razorpay: closed like the webhook would (booking expired, customer told)', async () => {
    const w = await waitingBooking(30, 'expired');
    const r = await reconcileStalePaymentLinks();
    assert.ok(r.closed >= 1);
    assert.strictEqual((await link(w.linkId)).status, 'EXPIRED');
    assert.deepStrictEqual(await bookingStatus(w.bookingId), { booking_status: 'ADVANCE_EXPIRED', advance_status: 'EXPIRED' });
    const told = (await query(`SELECT payload::text AS p FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [customerPhone])).rows[0];
    assert.ok(told.p.includes(w.bookingCode), 'customer told the booking was not confirmed');
  });

  it('cancelled at Razorpay: closed as cancelled', async () => {
    const w = await waitingBooking(30, 'cancelled');
    await reconcileStalePaymentLinks();
    assert.strictEqual((await link(w.linkId)).status, 'CANCELLED');
    assert.strictEqual((await bookingStatus(w.bookingId)).booking_status, 'ADVANCE_EXPIRED');
  });

  it('paid at Razorpay but no confirmation received: nothing is credited, admins are alerted once', async () => {
    const w = await waitingBooking(30, 'paid');
    const before = await adminLogCount(w.linkId);
    const r1 = await reconcileStalePaymentLinks();
    assert.strictEqual(r1.paidAlerts, 1);
    const l = await link(w.linkId);
    assert.strictEqual(l.status, 'CREATED', 'only the signed webhook confirms money');
    assert.ok(l.reconcile_alerted_at);
    assert.strictEqual((await bookingStatus(w.bookingId)).booking_status, 'AWAITING_ADVANCE');
    assert.strictEqual(await adminLogCount(w.linkId), before + 1);
    fetched.length = 0;
    await reconcileStalePaymentLinks();
    assert.strictEqual(await adminLogCount(w.linkId), before + 1, 'not alerted again on the next run');
    assert.ok(!fetched.includes(w.linkId), 'and not asked about again once flagged');
  });

  it('within the grace period the link is not checked; still open or unreachable at Razorpay, it is left alone', async () => {
    const fresh = await waitingBooking(5, 'expired');
    const open = await waitingBooking(30, 'created');
    const down = await waitingBooking(30, 'DOWN');
    fetched.length = 0;
    await reconcileStalePaymentLinks();
    assert.ok(!fetched.includes(fresh.linkId), 'webhook still has time to arrive');
    assert.strictEqual((await link(fresh.linkId)).status, 'CREATED');
    assert.strictEqual((await link(open.linkId)).status, 'CREATED');
    assert.strictEqual((await link(down.linkId)).status, 'CREATED', 'Razorpay unreachable: try again next run');
    assert.strictEqual((await bookingStatus(down.bookingId)).booking_status, 'AWAITING_ADVANCE');
  });

  it('a driver dues link that expired just closes; the dues stay on the wallet', async () => {
    const phone = `9156${String(Date.now()).slice(-6)}${seq++}`;
    const d = Number((await query(`INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating, wallet_balance) VALUES ($1, $1, 'Reconcile Driver', 'Patna', 'RESTRICTED_DIGITAL_ONLY', 4.5, -400) RETURNING id`, [phone])).rows[0].id);
    const linkId = `plink_${crypto.randomBytes(7).toString('hex')}`;
    await query(`INSERT INTO crm_payment_links (purpose, driver_id, provider_link_id, reference_id, amount_paise, short_url, status, expire_by)
                 VALUES ('DRIVER_DUES', $1, $2, $3, 40000, 'https://rzp.io/i/d', 'CREATED', CURRENT_TIMESTAMP - INTERVAL '30 minutes')`, [d, linkId, `rec-${RUN}-${seq++}`]);
    razorpayStatus.set(linkId, 'expired');
    await reconcileStalePaymentLinks();
    assert.strictEqual((await link(linkId)).status, 'EXPIRED');
    assert.strictEqual(Number((await query(`SELECT wallet_balance FROM crm_drivers WHERE id = $1`, [d])).rows[0].wallet_balance), -400);
  });

  it('if the real webhook arrives later, it changes nothing', async () => {
    const w = await waitingBooking(30, 'expired');
    await reconcileStalePaymentLinks();
    const body = JSON.stringify({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: w.linkId, status: 'expired' } } } });
    const res = await razorpayWebhookPOST(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', {
      method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-razorpay-event-id': `evt_${crypto.randomBytes(6).toString('hex')}`,
        'x-razorpay-signature': crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex'),
      },
    }));
    assert.strictEqual((await res.json()).status, 'link_already_closed');
  });

  it('runs in the frequent job and reports what it did', async () => {
    const w = await waitingBooking(30, 'expired');
    const result = await executeFrequentCronTasks();
    assert.ok(result.paymentLinksClosed >= 1);
    assert.strictEqual((await link(w.linkId)).status, 'EXPIRED');
  });
});
