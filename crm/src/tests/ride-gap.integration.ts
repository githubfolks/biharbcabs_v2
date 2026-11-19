/**
 * A driver cannot hold two rides whose pickups are less than driver_ride_gap_hours (4) apart: not at
 * broadcast, not when accepting, and not by staff assignment. Runs against a disposable database whose
 * name ends in _test (migrations 08 to 25):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/ride-gap.integration.ts
 *
 * WhatsApp sends are simulated (logged to crm_whatsapp_logs) when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { getAllSettings, getDriverRideGapHours, updateSetting } from '../lib/settings';
import {
  acceptRideOffer, bookingPickupAt, broadcastRideToDrivers, calculateRideSplitWithTaxes, checkDriverEligibility, findEligibleDrivers,
} from '../lib/dispatch-engine';
import * as dispatchRoute from '../app/api/bookings/[id]/dispatch/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let token = '';
let adminId = 0;
let originalGap: any;

const city = () => `GapCity${RUN}${seq++}`;
/** A date `days` from today (India time), as stored on bookings. */
const day = (days: number) => new Date(Date.now() + 5.5 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);

async function driver(c: string) {
  const phone = `9165${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, total_trips_completed, wallet_balance)
     VALUES ($1, $1, 'Gap Driver', $2, 'APPROVED_ACTIVE', true, 4.5, 10, 0) RETURNING id`,
    [phone, c]
  );
  const id = Number(r.rows[0].id);
  await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [id, `BR01G${RUN}${seq++}`]);
  return id;
}
/** A fully prepaid ride (so the credit rule never interferes) at `date` `time`. */
async function ride(c: string, date: string, time: string, over: { driverId?: number; status?: string } = {}) {
  const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Gap Customer') RETURNING id`, [`9164${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`]);
  const s = await calculateRideSplitWithTaxes(2500);
  const r = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, advance_paid, payment_status, payment_mode, advance_status,
       balance_cash_due_from_customer, booking_status)
     VALUES ($1, $2, $3, 'oneway', $4, 'Gaya', 'Main Road', $5, $6, 'sedan', 2500, $7, $8, 2500, 'PAID_IN_FULL', 'FULL_CASH', 'NOT_REQUIRED', 0, $9)
     RETURNING *`,
    [`BC-G${RUN}${seq++}`, cu.rows[0].id, over.driverId ?? null, c, date, time, s.driverGrossEarnings, s.totalCompanyDuesZ,
      over.status || (over.driverId ? 'DRIVER_ASSIGNED' : 'AWAITING_DRIVER')]
  );
  return r.rows[0];
}
const eligibleFor = async (b: any) =>
  (await findEligibleDrivers(b.origin_city, 'sedan', { isPrepaidRide: true, bookingId: Number(b.id), pickupAt: bookingPickupAt(b) })).map((d) => Number(d.driver_id));
const offer = (bookingId: number, driverId: number) =>
  query(`INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, 1, 'PENDING')`, [bookingId, driverId]);
const forceAssign = async (bookingId: number, driverId: number) => {
  const res = await dispatchRoute.POST(new NextRequest('http://localhost:3001/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: JSON.stringify({ action: 'force_assign', driver_id: driverId }),
  }), { params: { id: String(bookingId) } });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  originalGap = (await getAllSettings(true)).driver_ride_gap_hours;
  assert.strictEqual(await getDriverRideGapHours(), 4, 'migration 25 sets 4 hours');
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Gap Tester', 'DISPATCHER', true) RETURNING id`,
    [`gap-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
  token = (await createAdminSession(adminId)).token;
});
after(async () => {
  if (originalGap !== undefined) await updateSetting('driver_ride_gap_hours', originalGap);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = $1`, [adminId]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = $1`, [adminId]);
  await query(`UPDATE crm_drivers SET is_available = false WHERE full_name = 'Gap Driver'`);
  await getDbPool().end();
});

describe('who is offered a ride', () => {
  it('a driver holding a ride less than 4 hours before or after is left out; exactly 4 hours is fine', async () => {
    const c = city();
    const busy = await driver(c);
    const free = await driver(c);
    await ride(c, day(1), '10:00', { driverId: busy });
    for (const [time, eligible] of [['13:00', false], ['06:30', false], ['10:00', false], ['14:00', true], ['06:00', true]] as const) {
      const b = await ride(c, day(1), time);
      const ids = await eligibleFor(b);
      assert.strictEqual(ids.includes(busy), eligible, `new pickup at ${time}`);
      assert.ok(ids.includes(free), 'the other driver is unaffected');
    }
  });

  it('pickups are compared as full date and time, across midnight', async () => {
    const c = city();
    const d = await driver(c);
    await ride(c, day(1), '23:00', { driverId: d });
    assert.ok(!(await eligibleFor(await ride(c, day(2), '01:30'))).includes(d), '2.5 hours later, next day');
    assert.ok((await eligibleFor(await ride(c, day(2), '10:00'))).includes(d), 'next morning is fine');
  });

  it('a trip in progress blocks; a completed or cancelled ride does not', async () => {
    const c = city();
    const driving = await driver(c);
    const done = await driver(c);
    const cancelled = await driver(c);
    await ride(c, day(1), '10:00', { driverId: driving, status: 'TRIP_IN_PROGRESS' });
    await ride(c, day(1), '10:00', { driverId: done, status: 'COMPLETED_SETTLED' });
    await ride(c, day(1), '10:00', { driverId: cancelled, status: 'CANCELLED' });
    const ids = await eligibleFor(await ride(c, day(1), '11:00'));
    assert.ok(!ids.includes(driving));
    assert.ok(ids.includes(done) && ids.includes(cancelled));
  });

  it('the broadcast does not offer the ride to a driver with a clash', async () => {
    const c = city();
    const busy = await driver(c);
    const free = await driver(c);
    await ride(c, day(1), '09:00', { driverId: busy });
    const b = await ride(c, day(1), '10:00');
    await broadcastRideToDrivers(Number(b.id));
    const offered = (await query(`SELECT driver_id FROM crm_dispatch_offers WHERE booking_id = $1`, [b.id])).rows.map((r) => Number(r.driver_id));
    assert.deepStrictEqual(offered, [free]);
  });
});

describe('accepting and assigning', () => {
  it('a driver offered two close rides gets the first; accepting the second is refused and names the first', async () => {
    const c = city();
    const d = await driver(c);
    const first = await ride(c, day(1), '10:00');
    const second = await ride(c, day(1), '12:00');
    await offer(first.id, d);
    await offer(second.id, d);
    assert.strictEqual((await acceptRideOffer(Number(first.id), d)).status, 'ASSIGNED');
    const r = await acceptRideOffer(Number(second.id), d);
    assert.strictEqual(r.status, 'NOT_ELIGIBLE');
    assert.ok(r.message.includes(`#${first.booking_code}`) && r.message.includes('less than 4 hours'), r.message);
    const after = (await query(`SELECT booking_status, assigned_driver_id FROM crm_bookings WHERE id = $1`, [second.id])).rows[0];
    assert.strictEqual(after.booking_status, 'AWAITING_DRIVER', 'the second ride stays open for other drivers');
    assert.strictEqual(after.assigned_driver_id, null);
    const o = (await query(`SELECT offer_status FROM crm_dispatch_offers WHERE booking_id = $1 AND driver_id = $2`, [second.id, d])).rows[0];
    assert.strictEqual(o.offer_status, 'INELIGIBLE');
  });

  it('staff cannot assign a driver with a clash; the error names the clashing ride', async () => {
    const c = city();
    const d = await driver(c);
    const held = await ride(c, day(1), '10:00', { driverId: d });
    const b = await ride(c, day(1), '11:30');
    const res = await forceAssign(Number(b.id), d);
    assert.strictEqual(res.status, 409);
    assert.ok(res.json.error.includes(`#${held.booking_code}`), res.json.error);
  });

  it('reassigning a ride to another driver does not count the ride against itself', async () => {
    const c = city();
    const a = await driver(c);
    const b = await driver(c);
    const r = await ride(c, day(1), '10:00', { driverId: a });
    assert.strictEqual((await checkDriverEligibility({ query }, a, r)).eligible, true, "the driver's own ride is not a clash");
    const res = await forceAssign(Number(r.id), b);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  });
});

describe('the setting', () => {
  it('a smaller gap allows closer rides; an invalid setting falls back to 4 hours', async () => {
    const c = city();
    const d = await driver(c);
    await ride(c, day(1), '10:00', { driverId: d });
    const b = await ride(c, day(1), '13:00');
    try {
      await updateSetting('driver_ride_gap_hours', { value: 2 });
      assert.ok((await eligibleFor(b)).includes(d), '3 hours apart with a 2-hour gap');
      for (const bad of [0, -1, 'soon', 48]) {
        await updateSetting('driver_ride_gap_hours', { value: bad });
        assert.strictEqual(await getDriverRideGapHours(), 4, `invalid ${bad}`);
        assert.ok(!(await eligibleFor(b)).includes(d));
      }
    } finally {
      await updateSetting('driver_ride_gap_hours', originalGap);
    }
  });
});
