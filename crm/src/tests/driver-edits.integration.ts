/**
 * Editing drivers, payout details and vehicles (migration 31), and removed vehicles being ignored by
 * dispatch and the expiry job. Runs against a disposable database whose name ends in _test, with
 * migrations up to 31:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/driver-edits.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { addVehicle, editVehicle, removeVehicle, updateDriverDetails } from '../lib/driver-edits';
import { findEligibleDrivers } from '../lib/dispatch-engine';
import { runExpiredDocumentSuspensions } from '../lib/cron-service';
import * as detailRoute from '../app/api/drivers/[id]/route';
import * as payoutRoute from '../app/api/drivers/[id]/payout-details/route';
import * as vehiclesRoute from '../app/api/drivers/[id]/vehicles/route';
import * as vehicleRoute from '../app/api/drivers/[id]/vehicles/[vehicleId]/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
const adminIds: number[] = [];
const driverIds: number[] = [];
const bookingIds: number[] = [];
const customerIds: number[] = [];
let opsId = 0;
let opsToken = '';
let financeToken = '';

const future = (days = 365) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const past = () => new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
const phone = () => `9166${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
const regNo = () => `BR01ED${RUN}${seq++}`.toUpperCase();
// A city no other test uses, so dispatch only sees this file's drivers.
const CITY = `EditTown${RUN}`;

async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Edit Tester', $4, true) RETURNING id`,
    [`edit-${RUN}-${adminIds.length}@example.test`, hash, salt, role]
  );
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}

async function driver(status = 'APPROVED_ACTIVE') {
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, license_expiry, rating)
     VALUES ($1, $1, 'Edit Driver', $2, $3, true, $4, 4.9) RETURNING id, phone`,
    [phone(), CITY, status, future()]
  );
  driverIds.push(Number(r.rows[0].id));
  return { id: Number(r.rows[0].id), phone: r.rows[0].phone as string };
}

const vehicle = (over: Record<string, string> = {}) => ({
  registration_no: regNo(), wp_vehicle_code: 'sedan', model_name: 'Dzire',
  insurance_expiry: future(), fitness_expiry: future(), permit_expiry: future(), ...over,
});
const edits = async (id: number) => (await query(`SELECT * FROM crm_driver_edits WHERE driver_id = $1 ORDER BY id`, [id])).rows;

function req(method: string, token: string, body?: any) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest('http://localhost:3001/api/probe', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => {
  opsId = await admin('DISPATCHER');
  opsToken = (await createAdminSession(opsId)).token;
  financeToken = (await createAdminSession(await admin('FINANCE_MANAGER'))).token;
});

after(async () => {
  await query(`DELETE FROM crm_bookings WHERE id = ANY($1)`, [bookingIds]);
  await query(`DELETE FROM crm_customers WHERE id = ANY($1)`, [customerIds]);
  await query(`DELETE FROM crm_driver_edits WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_drivers WHERE id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('driver details', () => {
  it('saves only changed fields and records old and new values', async () => {
    const d = await driver();
    const r = await updateDriverDetails(d.id, { full_name: 'Edit Driver', base_city: 'Gaya', license_expiry: future(700) }, opsId);
    assert.deepStrictEqual(r.changed.sort(), ['base_city', 'license_expiry']);
    const e = await edits(d.id);
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].action, 'DRIVER_EDIT');
    assert.deepStrictEqual(e[0].changes.base_city, { from: CITY, to: 'Gaya' });
    assert.deepStrictEqual(e[0].changes.license_expiry, { from: future(), to: future(700) });
    assert.strictEqual(Number(e[0].changed_by), opsId);
  });

  it('records nothing when nothing changes', async () => {
    const d = await driver();
    const r = await updateDriverDetails(d.id, { base_city: CITY }, opsId);
    assert.deepStrictEqual(r.changed, []);
    assert.strictEqual((await edits(d.id)).length, 0);
  });

  it("refuses another driver's phone with 409 and changes nothing", async () => {
    const a = await driver();
    const b = await driver();
    const res = await detailRoute.PATCH(req('PATCH', opsToken, { phone: a.phone }), { params: { id: String(b.id) } });
    assert.strictEqual(res.status, 409);
    const row = (await query(`SELECT phone FROM crm_drivers WHERE id = $1`, [b.id])).rows[0];
    assert.strictEqual(row.phone, b.phone);
    assert.strictEqual((await edits(b.id)).length, 0);
  });
});

describe('payout details', () => {
  it('finance can change them; dispatchers cannot', async () => {
    const d = await driver();
    const ctx = { params: { id: String(d.id) } };
    const denied = await payoutRoute.PATCH(req('PATCH', opsToken, { bank_upi_id: 'thief@okaxis' }), ctx);
    assert.strictEqual(denied.status, 403);
    const ignored = await detailRoute.PATCH(req('PATCH', opsToken, { bank_upi_id: 'thief@okaxis', base_city: 'Gaya' }), ctx);
    assert.strictEqual(ignored.status, 200);
    let row = (await query(`SELECT bank_upi_id FROM crm_drivers WHERE id = $1`, [d.id])).rows[0];
    assert.strictEqual(row.bank_upi_id, null, 'the details route never touches payout fields');

    const ok = await payoutRoute.PATCH(req('PATCH', financeToken, { bank_upi_id: 'driver@okaxis', bank_account_number: '123456789012', bank_ifsc: 'SBIN0001234' }), ctx);
    assert.strictEqual(ok.status, 200);
    row = (await query(`SELECT bank_upi_id, bank_account_number, bank_ifsc FROM crm_drivers WHERE id = $1`, [d.id])).rows[0];
    assert.deepStrictEqual(row, { bank_upi_id: 'driver@okaxis', bank_account_number: '123456789012', bank_ifsc: 'SBIN0001234' });

    const detail = await (await detailRoute.GET(req('GET', opsToken), ctx)).json();
    const payoutEdit = detail.edits.find((e: any) => e.action === 'PAYOUT_DETAILS_EDIT');
    assert.deepStrictEqual(payoutEdit.changes.bank_account_number, { from: null, to: '****9012' }, 'history masks the account');
  });
});

describe('vehicles', () => {
  it('adds a verified vehicle that dispatch can use', async () => {
    const d = await driver();
    const { vehicleId } = await addVehicle(d.id, vehicle(), opsId);
    const v = (await query(`SELECT is_verified FROM crm_driver_vehicles WHERE id = $1`, [vehicleId])).rows[0];
    assert.strictEqual(v.is_verified, true);
    const eligible = await findEligibleDrivers(CITY, 'sedan', { pickupAt: new Date() });
    assert.ok(eligible.some((e) => Number(e.driver_id) === d.id && Number(e.vehicle_id) === vehicleId));
    assert.strictEqual((await edits(d.id))[0].action, 'VEHICLE_ADD');
  });

  it('refuses a past date, or a registration already on file', async () => {
    const d = await driver();
    await assert.rejects(addVehicle(d.id, vehicle({ permit_expiry: past() }), opsId), (e: any) => e.status === 422 && /permit_expiry/.test(e.message));
    const v = vehicle();
    await addVehicle(d.id, v, opsId);
    const other = await driver();
    await assert.rejects(addVehicle(other.id, { ...vehicle(), registration_no: v.registration_no }, opsId), (e: any) => e.status === 409);
    const owner = (await query(`SELECT driver_id FROM crm_driver_vehicles WHERE registration_no = $1`, [v.registration_no])).rows[0];
    assert.strictEqual(Number(owner.driver_id), d.id);
  });

  it("edits a vehicle's dates and records the change; never another driver's vehicle", async () => {
    const d = await driver();
    const { vehicleId } = await addVehicle(d.id, vehicle(), opsId);
    const r = await editVehicle(d.id, vehicleId, { fitness_expiry: future(30) }, opsId);
    assert.deepStrictEqual(r.changed, ['fitness_expiry']);
    const last = (await edits(d.id)).pop();
    assert.deepStrictEqual(last.changes, { fitness_expiry: { from: future(), to: future(30) } });
    const stranger = await driver();
    await assert.rejects(editVehicle(stranger.id, vehicleId, { fitness_expiry: past() }, opsId), (e: any) => e.status === 404);
  });

  it('removed vehicles are kept, ignored by dispatch and by the expiry suspension', async () => {
    const d = await driver();
    const keep = await addVehicle(d.id, vehicle(), opsId);
    const sold = await addVehicle(d.id, vehicle({ wp_vehicle_code: 'innova' }), opsId);
    const before = await findEligibleDrivers(CITY, 'innova', { pickupAt: new Date() });
    assert.ok(before.some((e) => Number(e.driver_id) === d.id), 'the innova is offered before removal');
    await removeVehicle(d.id, sold.vehicleId, 'Driver sold this car', opsId);

    // Its papers are still valid, so only the removal keeps it out of dispatch.
    const innova = await findEligibleDrivers(CITY, 'innova', { pickupAt: new Date() });
    assert.ok(!innova.some((e) => Number(e.driver_id) === d.id), 'dispatch does not use the removed vehicle');

    // The sold car's papers lapse after it is removed: that must not suspend the driver.
    await query(`UPDATE crm_driver_vehicles SET insurance_expiry = $2 WHERE id = $1`, [sold.vehicleId, past()]);
    await runExpiredDocumentSuspensions();
    assert.strictEqual((await query(`SELECT onboarding_status FROM crm_drivers WHERE id = $1`, [d.id])).rows[0].onboarding_status, 'APPROVED_ACTIVE');

    const detail = await (await detailRoute.GET(req('GET', opsToken), { params: { id: String(d.id) } })).json();
    assert.deepStrictEqual(detail.vehicles.map((v: any) => Number(v.id)), [keep.vehicleId], 'the dialog lists only current vehicles');
    const row = (await query(`SELECT removed_at, removed_reason, removed_by FROM crm_driver_vehicles WHERE id = $1`, [sold.vehicleId])).rows[0];
    assert.ok(row.removed_at);
    assert.strictEqual(row.removed_reason, 'Driver sold this car');
    assert.strictEqual(Number(row.removed_by), opsId);
    await assert.rejects(editVehicle(d.id, sold.vehicleId, { model_name: 'X' }, opsId), (e: any) => e.status === 404);
  });

  it('cannot remove a vehicle on an open ride', async () => {
    const d = await driver();
    const { vehicleId } = await addVehicle(d.id, vehicle(), opsId);
    // Same booking shape as ride-gap.integration.ts: a fully prepaid ride assigned to this vehicle.
    const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Edit Customer') RETURNING id`, [phone()]);
    customerIds.push(Number(cu.rows[0].id));
    const b = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, assigned_vehicle_id, trip_type, origin_city, destination_city,
         pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, advance_paid,
         payment_status, payment_mode, advance_status, balance_cash_due_from_customer, booking_status)
       VALUES ($1, $2, $3, $4, 'oneway', $5, 'Gaya', 'Main Road', CURRENT_DATE + 1, '10:00', 'sedan', 2500, 2000, 500, 2500,
         'PAID_IN_FULL', 'FULL_CASH', 'NOT_REQUIRED', 0, 'DRIVER_ASSIGNED')
       RETURNING id`,
      [`ED${RUN}${seq++}`, cu.rows[0].id, d.id, vehicleId, CITY]
    );
    bookingIds.push(Number(b.rows[0].id));
    const res = await vehicleRoute.DELETE(req('DELETE', opsToken, { reason: 'Sold the car' }), { params: { id: String(d.id), vehicleId: String(vehicleId) } });
    assert.strictEqual(res.status, 409);
    const row = (await query(`SELECT removed_at FROM crm_driver_vehicles WHERE id = $1`, [vehicleId])).rows[0];
    assert.strictEqual(row.removed_at, null);
  });

  it('API: add needs drivers.manage and valid input; remove needs a reason', async () => {
    const d = await driver();
    const ctx = { params: { id: String(d.id) } };
    assert.strictEqual((await vehiclesRoute.POST(req('POST', financeToken, vehicle()), ctx)).status, 403);
    assert.strictEqual((await vehiclesRoute.POST(req('POST', opsToken, { ...vehicle(), model_name: '' }), ctx)).status, 400);
    const added = await (await vehiclesRoute.POST(req('POST', opsToken, vehicle()), ctx)).json();
    assert.ok(added.success);
    const vctx = { params: { id: String(d.id), vehicleId: String(added.vehicleId) } };
    assert.strictEqual((await vehicleRoute.DELETE(req('DELETE', opsToken, { reason: '' }), vctx)).status, 400);
    assert.strictEqual((await vehicleRoute.PATCH(req('PATCH', opsToken, { registration_no: 'BR01NEW1' }), vctx)).status, 400);
    assert.strictEqual((await vehicleRoute.DELETE(req('DELETE', opsToken, { reason: 'Car written off' }), vctx)).status, 200);
  });
});
