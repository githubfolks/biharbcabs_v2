/**
 * The Finance summary cards (facilitation, GST on rides, tech fees) count completed rides only (owner
 * decision): a ride that is only assigned or in progress adds nothing until it is completed. Runs the real
 * ledger route against a disposable database whose name ends in _test:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/finance-summary.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import * as ledgerRoute from '../app/api/finance/ledger/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let adminId = 0;
let token = '';
let customerId = 0;
// Distinctive amounts, so the change in each total is exactly this booking's.
const AMOUNTS = { commission: 123.45, gst: 22.22, rideGst: 61.73, techFee: 10 };

async function summary() {
  const res = await ledgerRoute.GET(new NextRequest('http://localhost:3001/api/finance/ledger', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));
  assert.strictEqual(res.status, 200);
  return (await res.json()).summary;
}
async function booking(status: string) {
  const r = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code,
       customer_total_fare, driver_payout_amount, commission_amount, gst_amount, ride_gst_amount, tech_fee_amount, booking_status)
     VALUES ($1, $2, 'oneway', 'Patna', 'Main Road', CURRENT_DATE, '10:00', 'sedan', 2000, 1800, $3, $4, $5, $6, $7) RETURNING id`,
    [`BC-F${RUN}${seq++}`, customerId, AMOUNTS.commission, AMOUNTS.gst, AMOUNTS.rideGst, AMOUNTS.techFee, status]
  );
  return Number(r.rows[0].id);
}
const delta = (a: any, b: any, k: string) => Math.round((Number(b[k]) - Number(a[k])) * 100) / 100;

before(async () => {
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Summary Tester', 'FINANCE_MANAGER', true) RETURNING id`,
    [`summary-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
  token = (await createAdminSession(adminId)).token;
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Summary Customer') RETURNING id`, [`9154${String(Date.now()).slice(-6)}${seq++}`])).rows[0].id);
});
after(async () => {
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = $1`, [adminId]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = $1`, [adminId]);
  await getDbPool().end();
});

describe('Finance summary cards', () => {
  it('a ride that is only assigned or in progress adds nothing', async () => {
    const before = await summary();
    await booking('DRIVER_ASSIGNED');
    await booking('TRIP_IN_PROGRESS');
    const after = await summary();
    for (const k of ['totalCommissionRevenue', 'totalGstStatutory', 'totalRideGst', 'totalCommissionGst', 'totalTechFees']) {
      assert.strictEqual(delta(before, after, k), 0, k);
    }
  });

  it('a completed ride adds exactly its commission, GST and tech fee', async () => {
    const before = await summary();
    await booking('COMPLETED_SETTLED');
    const after = await summary();
    assert.strictEqual(delta(before, after, 'totalCommissionRevenue'), AMOUNTS.commission);
    assert.strictEqual(delta(before, after, 'totalRideGst'), AMOUNTS.rideGst);
    assert.strictEqual(delta(before, after, 'totalCommissionGst'), AMOUNTS.gst);
    assert.strictEqual(delta(before, after, 'totalGstStatutory'), Math.round((AMOUNTS.rideGst + AMOUNTS.gst) * 100) / 100);
    assert.strictEqual(delta(before, after, 'totalTechFees'), AMOUNTS.techFee);
  });

  it('when an assigned ride is completed, it is counted then', async () => {
    const id = await booking('DRIVER_ASSIGNED');
    const before = await summary();
    await query(`UPDATE crm_bookings SET booking_status = 'COMPLETED_SETTLED' WHERE id = $1`, [id]);
    const after = await summary();
    assert.strictEqual(delta(before, after, 'totalCommissionRevenue'), AMOUNTS.commission);
  });
});
