/**
 * A driver restricted for dues is restored once back within their tier credit limit (the rule that
 * restricted them), in trip settlement and incentive payments alike. Runs against a disposable database
 * whose name ends in _test (migrations 08 to 23):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/restore-threshold.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { getRevenueProtectionPolicy } from '../lib/settings';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';
import { awardDriverIncentive, completeTripAndSettle } from '../lib/billing';
import { creditLimitFor } from '../lib/driver-dues';
import { runUnpaidDuesGuardrails } from '../lib/cron-service';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let customerId = 0;
let policy: Awaited<ReturnType<typeof getRevenueProtectionPolicy>>;

const TIERS = {
  probation: { rating: 4.0, trips: 3 },
  standard: { rating: 4.5, trips: 3 },
  elite: { rating: 4.9, trips: 40 },
};
async function driver(tier: keyof typeof TIERS, wallet: number, status = 'RESTRICTED_DIGITAL_ONLY') {
  const phone = `9177${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, total_trips_completed, wallet_balance, security_reserve_balance)
     VALUES ($1, $1, 'Restore Driver', 'Patna', $2, $3, $4, $5, $6, 100000) RETURNING id`,
    [phone, status, status !== 'SUSPENDED_UNPAID_DUES', TIERS[tier].rating, TIERS[tier].trips, wallet]
  );
  return Number(r.rows[0].id);
}
const state = async (id: number) => (await query(`SELECT wallet_balance, onboarding_status, is_available FROM crm_drivers WHERE id = $1`, [id])).rows[0];

/** Settle a ₹2,500 trip that credits the driver exactly `credit` (cash collected = gross earnings - credit). */
async function tripCrediting(driverId: number, credit: number) {
  const s = await calculateRideSplitWithTaxes(2500);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status)
     VALUES ($1, $2, $3, 'oneway', 'Patna', 'Main Road', CURRENT_DATE, '10:00', 'sedan', 2500, $4, $5, 'TRIP_IN_PROGRESS') RETURNING id`,
    [`BC-T${RUN}${seq++}`, customerId, driverId, s.driverGrossEarnings, s.totalCompanyDuesZ]
  );
  const r = await completeTripAndSettle({ bookingId: Number(b.rows[0].id), cashCollectedByDriver: Math.round((s.driverGrossEarnings - credit) * 100) / 100 });
  assert.strictEqual(r.securityReserveDeducted, 0, 'reserve already full, so the credit is exact');
  return r;
}

before(async () => {
  policy = await getRevenueProtectionPolicy();
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Restore Customer') RETURNING id`, [`9178${String(Date.now()).slice(-6)}${seq++}`])).rows[0].id);
  // The tiers used here are the ones the settings define.
  assert.strictEqual(creditLimitFor({ rating: TIERS.probation.rating, total_trips_completed: TIERS.probation.trips + 1 }, policy), policy.dynamic_credit_limits.probation_or_new);
  assert.strictEqual(creditLimitFor({ rating: TIERS.standard.rating, total_trips_completed: TIERS.standard.trips + 1 }, policy), policy.dynamic_credit_limits.standard);
  assert.strictEqual(creditLimitFor({ rating: TIERS.elite.rating, total_trips_completed: TIERS.elite.trips + 1 }, policy), policy.dynamic_credit_limits.elite);
});
after(async () => {
  await getDbPool().end();
});

describe('trip settlement restores at the tier limit', () => {
  it('standard tier: restored once within ₹1,000, not held to the old -₹300', async () => {
    const limit = policy.dynamic_credit_limits.standard;
    const d = await driver('standard', -(limit + 500));
    await tripCrediting(d, 700); // ends at -(limit - 200): within the limit, but below -300
    const s = await state(d);
    assert.strictEqual(Number(s.wallet_balance), -(limit - 200));
    assert.strictEqual(s.onboarding_status, 'APPROVED_ACTIVE');
  });

  it('elite tier: restored once within ₹2,500', async () => {
    const limit = policy.dynamic_credit_limits.elite;
    const d = await driver('elite', -(limit + 500));
    await tripCrediting(d, 700);
    assert.strictEqual((await state(d)).onboarding_status, 'APPROVED_ACTIVE');
  });

  it('probation tier: still restricted while over ₹300; restored once within it', async () => {
    const limit = policy.dynamic_credit_limits.probation_or_new;
    const d = await driver('probation', -(limit + 500));
    await tripCrediting(d, 300); // -(limit + 200): still over
    assert.strictEqual((await state(d)).onboarding_status, 'RESTRICTED_DIGITAL_ONLY');
    await tripCrediting(d, 250); // -(limit - 50): within
    assert.strictEqual((await state(d)).onboarding_status, 'APPROVED_ACTIVE');
  });
});

describe('incentive payments restore at the tier limit', () => {
  it('a hard-suspended standard driver brought within the limit is restored and available again', async () => {
    const limit = policy.dynamic_credit_limits.standard;
    const d = await driver('standard', -(limit + 200), 'SUSPENDED_UNPAID_DUES');
    assert.strictEqual((await state(d)).is_available, false);
    await awardDriverIncentive(d, 400, 'Test incentive');
    const s = await state(d);
    assert.strictEqual(s.onboarding_status, 'APPROVED_ACTIVE');
    assert.strictEqual(s.is_available, true, 'restored drivers can be dispatched again');
  });

  it('an incentive that leaves the driver over their limit does not restore them', async () => {
    const limit = policy.dynamic_credit_limits.probation_or_new;
    const d = await driver('probation', -(limit + 300), 'SUSPENDED_UNPAID_DUES');
    await awardDriverIncentive(d, 100, 'Test incentive');
    const s = await state(d);
    assert.strictEqual(s.onboarding_status, 'SUSPENDED_UNPAID_DUES');
    assert.strictEqual(s.is_available, false);
  });
});

describe('consistency with the dues guardrail', () => {
  it('a driver restored at the tier limit is not restricted again by the next dues check', async () => {
    const limit = policy.dynamic_credit_limits.standard;
    const d = await driver('standard', -(limit + 500));
    await tripCrediting(d, 700);
    assert.strictEqual((await state(d)).onboarding_status, 'APPROVED_ACTIVE');
    await runUnpaidDuesGuardrails();
    assert.strictEqual((await state(d)).onboarding_status, 'APPROVED_ACTIVE', 'restore and restrict use the same limit');
  });
});
