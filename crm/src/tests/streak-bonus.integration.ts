/**
 * Ride streak bonus: only trips with a fare of at least streak_min_fare count, on their own counter.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 21):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/streak-bonus.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { getAllSettings, getRevenueProtectionPolicy, updateSetting } from '../lib/settings';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';
import { completeTripAndSettle } from '../lib/billing';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let policy: Awaited<ReturnType<typeof getRevenueProtectionPolicy>>;
let originalPolicy: any;

async function driver() {
  const phone = `9111${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating, wallet_balance, security_reserve_balance)
     VALUES ($1, $1, 'Streak Driver', 'Patna', 'APPROVED_ACTIVE', 4.5, 0, 100000) RETURNING id`,
    [phone]
  );
  return Number(r.rows[0].id);
}
let customerId = 0;
/** Complete one full-cash trip of `fare` for the driver; returns the bonus paid on it. */
async function trip(driverId: number, fare: number) {
  const s = await calculateRideSplitWithTaxes(fare);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status)
     VALUES ($1, $2, $3, 'local', 'Patna', 'Main Road', CURRENT_DATE, '10:00', 'sedan', $4, $5, $6, 'TRIP_IN_PROGRESS') RETURNING id`,
    [`BC-S${RUN}${seq++}`, customerId, driverId, fare, s.driverGrossEarnings, s.totalCompanyDuesZ]
  );
  const result = await completeTripAndSettle({ bookingId: Number(b.rows[0].id), cashCollectedByDriver: fare });
  return Number(result.streakBonusAwarded || 0);
}
const counters = async (id: number) =>
  (await query(`SELECT total_trips_completed, streak_qualifying_trips FROM crm_drivers WHERE id = $1`, [id])).rows[0];

before(async () => {
  originalPolicy = (await getAllSettings(true)).revenue_protection_policy;
  policy = await getRevenueProtectionPolicy();
  assert.strictEqual(policy.streak_min_fare, 700, 'migration 21 sets ₹700');
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Streak Customer') RETURNING id`,
    [`9112${String(Date.now()).slice(-6)}${seq++}`])).rows[0].id);
});
after(async () => {
  await updateSetting('revenue_protection_policy', originalPolicy);
  await getDbPool().end();
});

describe('streak bonus minimum fare', () => {
  it('₹700 is break-even: five qualifying trips earn BiharCabs at least the bonus', async () => {
    const s = await calculateRideSplitWithTaxes(700);
    const keptPerTrip = s.platformCommission + s.techFeeAmount; // what BiharCabs keeps after paying all GST
    assert.ok(keptPerTrip * policy.streak_bonus_target_trips >= policy.streak_bonus_amount, `${keptPerTrip} x ${policy.streak_bonus_target_trips}`);
  });

  it('small trips neither count nor trigger the bonus; it is paid on the 5th qualifying trip', async () => {
    const d = await driver();
    const target = policy.streak_bonus_target_trips;
    let paid = 0;
    for (let i = 0; i < target - 1; i++) {
      paid += await trip(d, 700);
      paid += await trip(d, 500);
    }
    assert.strictEqual(paid, 0, 'no bonus before the 5th qualifying trip, however many small trips');
    assert.deepStrictEqual(await counters(d), { total_trips_completed: 2 * (target - 1), streak_qualifying_trips: target - 1 });
    assert.strictEqual(await trip(d, 500), 0, 'a small trip cannot complete the streak');
    assert.strictEqual(await trip(d, 1500), policy.streak_bonus_amount, 'the 5th qualifying trip pays the bonus');
    const c = await counters(d);
    assert.strictEqual(c.streak_qualifying_trips, target);
    assert.strictEqual(c.total_trips_completed, 2 * (target - 1) + 2, 'every trip still counts toward the tier');
  });

  it('the boundary: ₹699 does not count, ₹700 does', async () => {
    const d = await driver();
    await trip(d, 699);
    assert.strictEqual((await counters(d)).streak_qualifying_trips, 0);
    await trip(d, 700);
    assert.strictEqual((await counters(d)).streak_qualifying_trips, 1);
  });

  it('a farming pattern (many cheap trips) never earns a bonus', async () => {
    const d = await driver();
    let paid = 0;
    for (let i = 0; i < 12; i++) paid += await trip(d, 300);
    assert.strictEqual(paid, 0);
  });

  it('without a valid minimum fare, no bonus is paid', async () => {
    const { streak_min_fare, ...rest } = originalPolicy;
    await updateSetting('revenue_protection_policy', rest);
    try {
      const d = await driver();
      let paid = 0;
      for (let i = 0; i < policy.streak_bonus_target_trips; i++) paid += await trip(d, 2000);
      assert.strictEqual(paid, 0);
      assert.strictEqual((await counters(d)).streak_qualifying_trips, 0);
    } finally {
      await updateSetting('revenue_protection_policy', originalPolicy);
    }
  });
});
