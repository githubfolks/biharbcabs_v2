/**
 * Manual driver status changes (migration 30) and new drivers starting as PENDING_DOCS.
 * Runs against a disposable database whose name ends in _test, with migrations up to 30:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/driver-status.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { changeDriverStatus, DriverStatusError } from '../lib/driver-status';
import * as statusRoute from '../app/api/drivers/[id]/status/route';
import * as driversRoute from '../app/api/drivers/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
const adminIds: number[] = [];
const driverIds: number[] = [];
let opsId = 0;
let opsToken = '';
let financeToken = '';

const future = (days = 365) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const past = () => new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Status Tester', $4, true) RETURNING id`,
    [`status-${RUN}-${adminIds.length}@example.test`, hash, salt, role]
  );
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}

const phone = () => `9177${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
const regNo = () => `BR01ST${RUN}${seq++}`.toUpperCase();

async function driver(status: string, licence: string | null, vehicles: Array<[string | null, string | null, string | null]>) {
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, license_expiry)
     VALUES ($1, $1, 'Status Driver', 'Patna', $2, false, $3) RETURNING id`,
    [phone(), status, licence]
  );
  const id = Number(r.rows[0].id);
  driverIds.push(id);
  const vIds: number[] = [];
  for (const [ins, fit, per] of vehicles) {
    const v = await query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, insurance_expiry, fitness_expiry, permit_expiry, is_verified)
       VALUES ($1, 'sedan', $2, 'Dzire', $3, $4, $5, false) RETURNING id`,
      [id, regNo(), ins, fit, per]
    );
    vIds.push(Number(v.rows[0].id));
  }
  return { id, vIds };
}

const row = async (id: number) => (await query(`SELECT onboarding_status, is_available, to_char(license_expiry, 'YYYY-MM-DD') AS license_expiry FROM crm_drivers WHERE id = $1`, [id])).rows[0];
const changes = async (id: number) => (await query(`SELECT * FROM crm_driver_status_changes WHERE driver_id = $1 ORDER BY id`, [id])).rows;
const verified = async (id: number) => (await query(`SELECT is_verified FROM crm_driver_vehicles WHERE driver_id = $1 ORDER BY id`, [id])).rows.map((r) => r.is_verified);

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
  await query(`DELETE FROM crm_driver_status_changes WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_drivers WHERE id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('activating a driver', () => {
  it('approves a pending driver once valid dates are entered, verifies vehicles and records who and why', async () => {
    const d = await driver('PENDING_DOCS', null, [[null, null, null]]);
    const result = await changeDriverStatus(
      d.id,
      {
        action: 'ACTIVATE',
        reason: 'Originals checked at office',
        license_expiry: future(),
        vehicles: [{ id: d.vIds[0], insurance_expiry: future(100), fitness_expiry: future(200), permit_expiry: future(300) }],
      },
      opsId
    );
    assert.deepStrictEqual(result, { driverId: d.id, fromStatus: 'PENDING_DOCS', toStatus: 'APPROVED_ACTIVE' });
    const r = await row(d.id);
    assert.strictEqual(r.onboarding_status, 'APPROVED_ACTIVE');
    assert.strictEqual(r.is_available, true);
    assert.strictEqual(r.license_expiry, future());
    assert.deepStrictEqual(await verified(d.id), [true]);
    const c = await changes(d.id);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].action, 'ACTIVATE');
    assert.strictEqual(c[0].reason, 'Originals checked at office');
    assert.strictEqual(Number(c[0].changed_by), opsId);
  });

  it('refuses to reactivate a document suspension while any date is past, and changes nothing', async () => {
    const d = await driver('SUSPENDED_DOC_EXPIRED', future(), [[future(), future(), future()], [future(), past(), future()]]);
    await assert.rejects(
      changeDriverStatus(d.id, { action: 'ACTIVATE', reason: 'Driver says renewed', license_expiry: future(500) }, opsId),
      (e: any) => e instanceof DriverStatusError && e.status === 422 && /fitness expiry is missing or past/.test(e.message)
    );
    const r = await row(d.id);
    assert.strictEqual(r.onboarding_status, 'SUSPENDED_DOC_EXPIRED');
    assert.strictEqual(r.license_expiry, future(), 'the licence date sent with a refused activation is rolled back');
    assert.deepStrictEqual(await verified(d.id), [false, false]);
    assert.strictEqual((await changes(d.id)).length, 0);
  });

  it('reactivates a document suspension once the renewed date is entered', async () => {
    const d = await driver('SUSPENDED_DOC_EXPIRED', future(), [[future(), past(), future()]]);
    await changeDriverStatus(
      d.id,
      { action: 'ACTIVATE', reason: 'Renewed fitness certificate seen', vehicles: [{ id: d.vIds[0], insurance_expiry: future(), fitness_expiry: future(400), permit_expiry: future() }] },
      opsId
    );
    assert.strictEqual((await row(d.id)).onboarding_status, 'APPROVED_ACTIVE');
  });

  it('refuses a driver with no vehicle or no licence date', async () => {
    const noVehicle = await driver('PENDING_DOCS', future(), []);
    await assert.rejects(changeDriverStatus(noVehicle.id, { action: 'ACTIVATE', reason: 'Docs checked' }, opsId), /no vehicle/);
    const noLicence = await driver('SUSPENDED_QUALITY', null, [[future(), future(), future()]]);
    await assert.rejects(changeDriverStatus(noLicence.id, { action: 'ACTIVATE', reason: 'Complaint resolved' }, opsId), /licence expiry/);
  });

  it('never lifts a dues restriction by hand', async () => {
    const d = await driver('SUSPENDED_UNPAID_DUES', future(), [[future(), future(), future()]]);
    await assert.rejects(
      changeDriverStatus(d.id, { action: 'ACTIVATE', reason: 'Promised to pay' }, opsId),
      (e: any) => e.status === 409 && /dues are paid/.test(e.message)
    );
    assert.strictEqual((await row(d.id)).onboarding_status, 'SUSPENDED_UNPAID_DUES');
  });

  it('refuses a vehicle that belongs to another driver', async () => {
    const other = await driver('APPROVED_ACTIVE', future(), [[future(), future(), future()]]);
    const d = await driver('PENDING_DOCS', future(), [[future(), future(), future()]]);
    await assert.rejects(
      changeDriverStatus(d.id, { action: 'ACTIVATE', reason: 'Docs checked', vehicles: [{ id: other.vIds[0], insurance_expiry: past(), fitness_expiry: past(), permit_expiry: past() }] }, opsId),
      (e: any) => e.status === 400
    );
    const v = await query(`SELECT to_char(insurance_expiry, 'YYYY-MM-DD') AS d FROM crm_driver_vehicles WHERE id = $1`, [other.vIds[0]]);
    assert.strictEqual(v.rows[0].d, future());
  });
});

describe('suspending and offboarding', () => {
  it('suspends and then offboards, taking the driver off rides, with each step recorded', async () => {
    const d = await driver('APPROVED_ACTIVE', future(), [[future(), future(), future()]]);
    await query(`UPDATE crm_drivers SET is_available = true WHERE id = $1`, [d.id]);
    await changeDriverStatus(d.id, { action: 'SUSPEND', reason: 'Misconduct complaint' }, opsId);
    let r = await row(d.id);
    assert.strictEqual(r.onboarding_status, 'SUSPENDED_MANUAL');
    assert.strictEqual(r.is_available, false);
    await assert.rejects(changeDriverStatus(d.id, { action: 'SUSPEND', reason: 'Again' }, opsId), (e: any) => e.status === 409);
    await changeDriverStatus(d.id, { action: 'OFFBOARD', reason: 'Left the fleet' }, opsId);
    r = await row(d.id);
    assert.strictEqual(r.onboarding_status, 'OFFBOARDED');
    const c = await changes(d.id);
    assert.deepStrictEqual(c.map((x) => [x.from_status, x.to_status]), [['APPROVED_ACTIVE', 'SUSPENDED_MANUAL'], ['SUSPENDED_MANUAL', 'OFFBOARDED']]);
  });
});

describe('status API', () => {
  it('lets finance view but not change a driver status', async () => {
    const d = await driver('APPROVED_ACTIVE', future(), [[future(), future(), future()]]);
    const ctx = { params: { id: String(d.id) } };
    const view = await statusRoute.GET(req('GET', financeToken), ctx);
    assert.strictEqual(view.status, 200);
    const detail = await view.json();
    assert.strictEqual(detail.license_expiry, future());
    assert.strictEqual(detail.vehicles[0].insurance_expiry, future());
    const change = await statusRoute.POST(req('POST', financeToken, { action: 'SUSPEND', reason: 'Not allowed' }), ctx);
    assert.strictEqual(change.status, 403);
    assert.strictEqual((await row(d.id)).onboarding_status, 'APPROVED_ACTIVE');
  });

  it('suspends through the API and shows it in the history', async () => {
    const d = await driver('APPROVED_ACTIVE', future(), [[future(), future(), future()]]);
    const ctx = { params: { id: String(d.id) } };
    const bad = await statusRoute.POST(req('POST', opsToken, { action: 'SUSPEND', reason: '' }), ctx);
    assert.strictEqual(bad.status, 400);
    const ok = await statusRoute.POST(req('POST', opsToken, { action: 'SUSPEND', reason: 'Vehicle not roadworthy' }), ctx);
    assert.strictEqual(ok.status, 200);
    const detail = await (await statusRoute.GET(req('GET', opsToken), ctx)).json();
    assert.strictEqual(detail.status, 'SUSPENDED_MANUAL');
    assert.strictEqual(detail.history[0].reason, 'Vehicle not roadworthy');
    assert.strictEqual(detail.history[0].changed_by_name, 'Status Tester');
    const missing = await statusRoute.GET(req('GET', opsToken), { params: { id: '999999999' } });
    assert.strictEqual(missing.status, 404);
  });
});

describe('onboarding from the CRM', () => {
  const body = (p: string, reg: string) => ({
    full_name: 'New Driver', phone: p, base_city: 'Patna', license_number: 'DL1', license_expiry: future(),
    vehicle: { wp_vehicle_code: 'sedan', registration_no: reg, model_name: 'Dzire', insurance_expiry: future(), fitness_expiry: future(), permit_expiry: future() },
  });

  it('saves a new driver as pending with an unverified vehicle', async () => {
    const res = await driversRoute.POST(req('POST', opsToken, body(phone(), regNo())));
    const data = await res.json();
    assert.strictEqual(res.status, 200, data.error);
    driverIds.push(Number(data.driver.id));
    assert.strictEqual(data.driver.onboarding_status, 'PENDING_DOCS');
    assert.strictEqual(data.vehicle.is_verified, false);
  });

  it('keeps an existing driver status when the phone is onboarded again', async () => {
    const d = await driver('SUSPENDED_MANUAL', future(), []);
    const p = (await query(`SELECT phone FROM crm_drivers WHERE id = $1`, [d.id])).rows[0].phone;
    const res = await driversRoute.POST(req('POST', opsToken, body(p, regNo())));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await row(d.id)).onboarding_status, 'SUSPENDED_MANUAL');
  });

  it("refuses another driver's registration number and saves nothing", async () => {
    const other = await driver('APPROVED_ACTIVE', future(), [[future(), future(), future()]]);
    const taken = (await query(`SELECT registration_no FROM crm_driver_vehicles WHERE id = $1`, [other.vIds[0]])).rows[0].registration_no;
    const p = phone();
    const res = await driversRoute.POST(req('POST', opsToken, body(p, taken)));
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await query(`SELECT 1 FROM crm_drivers WHERE phone = $1`, [p])).rows.length, 0);
    const v = await query(`SELECT driver_id, is_verified FROM crm_driver_vehicles WHERE id = $1`, [other.vIds[0]]);
    assert.strictEqual(Number(v.rows[0].driver_id), other.id);
  });
});
