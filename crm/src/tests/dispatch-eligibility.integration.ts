/**
 * Dispatch rules applied at broadcast, at acceptance and at staff assignment, from one definition;
 * the credit check counts this ride's shortfall and the driver's other open rides.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 17):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/dispatch-eligibility.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { getRevenueProtectionPolicy } from '../lib/settings';
import { acceptRideOffer, bookingPickupAt, calculateRideSplitWithTaxes, checkDriverEligibility, findEligibleDrivers, rideShortfall } from '../lib/dispatch-engine';
import * as dispatchRoute from '../app/api/bookings/[id]/dispatch/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let token = '';
const adminIds: number[] = [];
let probationLimit = 0;
let share2500 = 0;

const city = () => `EligCity${RUN}${seq++}`;
async function driver(c: string, over: Record<string, any> = {}, vehicle: Record<string, any> | null = {}) {
  const phone = `9166${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const cols = { phone, whatsapp_phone: phone, full_name: 'Elig Driver', base_city: c, onboarding_status: 'APPROVED_ACTIVE', is_available: true, rating: 4.15, total_trips_completed: 3, wallet_balance: 0, ...over };
  const keys = Object.keys(cols);
  const r = await query(`INSERT INTO crm_drivers (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols));
  const id = Number(r.rows[0].id);
  if (vehicle) {
    const v = { driver_id: id, wp_vehicle_code: 'sedan', registration_no: `BR01E${RUN}${seq++}`, model_name: 'Dzire', is_verified: true, ...vehicle };
    const vk = Object.keys(v);
    await query(`INSERT INTO crm_driver_vehicles (${vk.join(', ')}) VALUES (${vk.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(v));
  }
  return { id, phone };
}
async function booking(c: string, over: Record<string, any> = {}) {
  const cust = `9177${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Elig Customer') RETURNING id`, [cust]);
  const s = await calculateRideSplitWithTaxes(2500);
  const cols = {
    booking_code: `BC-E${RUN}${seq++}`, customer_id: cu.rows[0].id, trip_type: 'oneway', origin_city: c, destination_city: 'Gaya',
    pickup_address: 'Main Road', pickup_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), pickup_time: '10:00',
    wp_vehicle_code: 'sedan', customer_total_fare: 2500, driver_payout_amount: s.driverGrossEarnings, commission_amount: s.totalCompanyDuesZ,
    advance_paid: 0, payment_mode: 'FULL_CASH', advance_status: 'NOT_REQUIRED', balance_cash_due_from_customer: 2500,
    booking_status: 'AWAITING_DRIVER', ...over,
  };
  const keys = Object.keys(cols);
  const r = await query(`INSERT INTO crm_bookings (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(cols));
  return r.rows[0];
}
const ids = (cands: any[]) => cands.map((c) => Number(c.driver_id)).sort();
const offer = (bookingId: number, driverId: number) =>
  query(`INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, 1, 'PENDING')`, [bookingId, driverId]);
const forceAssign = async (bookingId: number, driverId: number) => {
  const res = await dispatchRoute.POST(new NextRequest('http://localhost:3001/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: JSON.stringify({ action: 'force_assign', driver_id: driverId }),
  }), { params: { id: String(bookingId) } });
  return { status: res.status, json: await res.json() };
};
const bookingRow = async (id: number) => (await query(`SELECT * FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

before(async () => {
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  const a = await query(`INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Elig Tester', 'DISPATCHER', true) RETURNING id`,
    [`elig-${RUN}@example.test`, hash, salt]);
  adminIds.push(Number(a.rows[0].id));
  token = (await createAdminSession(adminIds[0])).token;
  probationLimit = (await getRevenueProtectionPolicy()).dynamic_credit_limits.probation_or_new;
  share2500 = (await calculateRideSplitWithTaxes(2500)).totalCompanyDuesZ;
});
after(async () => {
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_drivers SET is_available = false WHERE full_name = 'Elig Driver'`);
  await getDbPool().end();
});

describe('one set of rules', () => {
  it('broadcast leaves out every driver who fails a rule, and only them', async () => {
    const c = city();
    const ok = await driver(c);
    const failing = [
      await driver(c, { onboarding_status: 'SUSPENDED_DOC_EXPIRED' }),
      await driver(c, { is_available: false }),
      await driver(c, { rating: 2.0 }),
      await driver(c, { license_expiry: yesterday() }),
      await driver(c, {}, { is_verified: false }),
      await driver(c, {}, { insurance_expiry: yesterday() }),
      await driver(c, {}, { wp_vehicle_code: 'innova' }),
      await driver(c, {}, null),
    ];
    const b = await booking(c);
    assert.deepStrictEqual(ids(await findEligibleDrivers(c, 'sedan', { bookingId: b.id, pickupAt: bookingPickupAt(b) })), [ok.id]);
    for (const f of failing) {
      const check = await checkDriverEligibility({ query }, f.id, b);
      assert.strictEqual(check.eligible, false, `driver ${f.id} should fail`);
      assert.ok(check.reasons.length > 0);
    }
    assert.strictEqual((await checkDriverEligibility({ query }, ok.id, b)).eligible, true);
  });

  it('a driver with two verified cabs of the type gets one offer, not two', async () => {
    const c = city();
    const d = await driver(c);
    await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Amaze', true)`, [d.id, `BR01X${RUN}${seq++}`]);
    assert.deepStrictEqual(ids(await findEligibleDrivers(c, 'sedan', { pickupAt: new Date() })), [d.id]);
  });

  it('broadcast selection and the single-driver check always agree', async () => {
    const c = city();
    const drivers = [
      await driver(c), await driver(c, { wallet_balance: -probationLimit + 50 }), await driver(c, { wallet_balance: -probationLimit - 1 }),
      await driver(c, { onboarding_status: 'RESTRICTED_DIGITAL_ONLY', wallet_balance: -500 }), await driver(c, { rating: 3.0 }),
      await driver(c, {}, { permit_expiry: yesterday() }),
    ];
    for (const over of [{}]) {
      const b = await booking(c, over);
      const broadcast = ids(await findEligibleDrivers(c, 'sedan', { rideShortfall: rideShortfall(b), bookingId: b.id, pickupAt: bookingPickupAt(b) }));
      const single: number[] = [];
      for (const d of drivers) if ((await checkDriverEligibility({ query }, d.id, b)).eligible) single.push(d.id);
      assert.deepStrictEqual(broadcast, single.sort(), JSON.stringify(over));
    }
  });
});

describe('#9 credit check counts this ride and the driver\'s other open rides', () => {
  it('a full-cash ride that would push the driver past the limit is not offered', async () => {
    const c = city();
    const d = await driver(c, { wallet_balance: -(probationLimit - share2500 + 1) }); // just over once this ride's share is added
    const cash = await booking(c);
    assert.deepStrictEqual(ids(await findEligibleDrivers(c, 'sedan', { rideShortfall: rideShortfall(cash), bookingId: cash.id, pickupAt: bookingPickupAt(cash) })), [], 'cash ride would breach the limit');
  });

  it('rides the driver already holds count toward the limit', async () => {
    const c = city();
    const d = await driver(c, { wallet_balance: 0 });
    const held = Math.floor(probationLimit / share2500); // how many full-cash rides fit within the limit
    for (let i = 0; i < held; i++) await booking(c, { assigned_driver_id: d.id, booking_status: 'DRIVER_ASSIGNED' });
    const next = await booking(c);
    assert.strictEqual((await checkDriverEligibility({ query }, d.id, next)).eligible, false, `holding ${held} cash rides, one more breaches ₹${probationLimit}`);
    assert.ok((await checkDriverEligibility({ query }, d.id, next)).reasons.some((r) => r.includes('credit limit')));
  });
});

describe('#6 the driver is checked again when accepting', () => {
  it('a driver suspended after the offer cannot accept; another eligible driver still can', async () => {
    const c = city();
    const a = await driver(c);
    const other = await driver(c);
    const b = await booking(c);
    await offer(b.id, a.id);
    await offer(b.id, other.id);
    await query(`UPDATE crm_drivers SET onboarding_status = 'SUSPENDED_LOW_RATING' WHERE id = $1`, [a.id]);
    const refused = await acceptRideOffer(b.id, a.id);
    assert.strictEqual(refused.status, 'NOT_ELIGIBLE');
    assert.match(refused.message, /not active/);
    assert.strictEqual((await bookingRow(b.id)).booking_status, 'AWAITING_DRIVER');
    assert.strictEqual((await query(`SELECT offer_status FROM crm_dispatch_offers WHERE booking_id = $1 AND driver_id = $2`, [b.id, a.id])).rows[0].offer_status, 'INELIGIBLE');
    assert.strictEqual((await acceptRideOffer(b.id, other.id)).status, 'ASSIGNED');
  });

  it('documents that expired after the offer block acceptance', async () => {
    const c = city();
    const d = await driver(c);
    const b = await booking(c);
    await offer(b.id, d.id);
    await query(`UPDATE crm_driver_vehicles SET fitness_expiry = $1 WHERE driver_id = $2`, [yesterday(), d.id]);
    const r = await acceptRideOffer(b.id, d.id);
    assert.strictEqual(r.status, 'NOT_ELIGIBLE');
    assert.match(r.message, /verified cab/);
  });

  it('two cash rides accepted at the same moment cannot together breach the limit', async () => {
    const c = city();
    // Room for exactly one more full-cash ride: one brings them to ₹1 under the limit, two would breach it.
    const d = await driver(c, { wallet_balance: -(probationLimit - share2500 - 1) });
    const b1 = await booking(c);
    const b2 = await booking(c);
    await offer(b1.id, d.id);
    await offer(b2.id, d.id);
    const results = await Promise.all([acceptRideOffer(b1.id, d.id), acceptRideOffer(b2.id, d.id)]);
    assert.strictEqual(results.filter((r) => r.status === 'ASSIGNED').length, 1);
    assert.strictEqual(results.filter((r) => r.status === 'NOT_ELIGIBLE').length, 1);
  });
});

describe('#7 force-assign applies the same rules', () => {
  it('refuses a driver who fails a rule, with the reason; assigns an eligible one with their verified cab', async () => {
    const c = city();
    const suspended = await driver(c, { onboarding_status: 'SUSPENDED_DOC_EXPIRED' });
    const noCab = await driver(c, {}, { wp_vehicle_code: 'innova' });
    const ok = await driver(c);
    const b = await booking(c, { booking_status: 'ESCALATED_NO_DRIVER' });
    const r1 = await forceAssign(b.id, suspended.id);
    assert.strictEqual(r1.status, 409);
    assert.match(r1.json.error, /not active/);
    const r2 = await forceAssign(b.id, noCab.id);
    assert.strictEqual(r2.status, 409);
    assert.match(r2.json.error, /verified cab/);
    assert.strictEqual((await bookingRow(b.id)).assigned_driver_id, null);

    const r3 = await forceAssign(b.id, ok.id);
    assert.strictEqual(r3.status, 200);
    const row = await bookingRow(b.id);
    assert.strictEqual(Number(row.assigned_driver_id), ok.id);
    assert.ok(row.assigned_vehicle_id, 'the verified cab is recorded');
    assert.ok(row.start_otp_hash, 'trip OTP issued');
  });

  it('refuses bookings in progress, completed, or still waiting for their advance', async () => {
    const c = city();
    const d = await driver(c);
    for (const status of ['TRIP_IN_PROGRESS', 'COMPLETED_SETTLED']) {
      const b = await booking(c, { booking_status: status });
      const r = await forceAssign(b.id, d.id);
      assert.strictEqual(r.status, 409, status);
      assert.strictEqual((await bookingRow(b.id)).booking_status, status);
    }
    const unpaid = await booking(c, { booking_status: 'AWAITING_ADVANCE' });
    assert.notStrictEqual((await forceAssign(unpaid.id, d.id)).status, 200);
    assert.strictEqual((await bookingRow(unpaid.id)).assigned_driver_id, null);
  });

  it('reassignment: the new driver gets the ride, a new OTP replaces the old, pending offers close, the previous driver is told', async () => {
    const c = city();
    const first = await driver(c);
    const second = await driver(c);
    const waiting = await driver(c);
    const b = await booking(c, { booking_status: 'ESCALATED_NO_DRIVER' });
    await offer(b.id, waiting.id);
    assert.strictEqual((await forceAssign(b.id, first.id)).status, 200);
    const firstOtp = (await bookingRow(b.id)).start_otp_hash;
    assert.strictEqual((await forceAssign(b.id, first.id)).status, 409, 'already assigned to this driver');

    assert.strictEqual((await forceAssign(b.id, second.id)).status, 200);
    const row = await bookingRow(b.id);
    assert.strictEqual(Number(row.assigned_driver_id), second.id);
    assert.notStrictEqual(row.start_otp_hash, firstOtp, 'a new trip OTP');
    assert.strictEqual((await query(`SELECT offer_status FROM crm_dispatch_offers WHERE booking_id = $1 AND driver_id = $2`, [b.id, waiting.id])).rows[0].offer_status, 'EXPIRED');
    const toFirst = (await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [first.phone])).rows[0];
    assert.ok(JSON.stringify(toFirst.payload).includes('reassigned'));
  });
});
