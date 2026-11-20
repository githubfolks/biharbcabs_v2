/**
 * Driver list search and filters (GET /api/drivers). Runs against a disposable database whose name
 * ends in _test, with migrations up to 31:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/drivers-list.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import * as driversRoute from '../app/api/drivers/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
// A city no other test uses, so every search is narrowed to this file's drivers.
const CITY = `ListTown${RUN}`;
const adminIds: number[] = [];
const driverIds: number[] = [];
let token = '';
const ids: Record<string, number> = {};

async function driver(key: string, name: string, phone: string, status: string, licence: string | null, reg: string | null, removed = false) {
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, license_number)
     VALUES ($1, $1, $2, $3, $4, $5) RETURNING id`,
    [phone, name, CITY, status, licence]
  );
  const id = Number(r.rows[0].id);
  driverIds.push(id);
  ids[key] = id;
  if (reg) {
    await query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified, removed_at)
       VALUES ($1, 'sedan', $2, 'Dzire', true, $3)`,
      [id, reg, removed ? new Date() : null]
    );
  }
}

async function list(params: Record<string, string>) {
  const url = new URL('http://localhost:3001/api/drivers');
  url.searchParams.set('city', CITY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await driversRoute.GET(new NextRequest(url, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  return { found: data.drivers.map((d: any) => Number(d.id)).sort(), cities: data.cities as string[] };
}
const expect = (...keys: string[]) => keys.map((k) => ids[k]).sort();

before(async () => {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const a = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'List Tester', 'FINANCE_MANAGER', true) RETURNING id`,
    [`list-${RUN}@example.test`, hash, salt]
  );
  adminIds.push(Number(a.rows[0].id));
  token = (await createAdminSession(Number(a.rows[0].id))).token;

  const n = String(Date.now()).slice(-5);
  await driver('sunil', 'Sunil Yadav', `91701${n}11`, 'APPROVED_ACTIVE', 'BR-0120220019', `BR-01-PK-${n.slice(-4)}`);
  await driver('mahesh', 'Mahesh 100% Kumar', `91702${n}22`, 'PENDING_DOCS', null, null);
  await driver('ravi', 'Ravi Singh', `91703${n}33`, 'SUSPENDED_MANUAL', null, `BR-06-ZZ-${n.slice(-4)}`, true);
});

after(async () => {
  await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_drivers WHERE id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('driver list search and filters', () => {
  it('finds by part of the name, any case', async () => {
    assert.deepStrictEqual((await list({ q: 'yadav' })).found, expect('sunil'));
  });

  it('finds by phone typed with spaces or dashes', async () => {
    const phone = (await query(`SELECT phone FROM crm_drivers WHERE id = $1`, [ids.mahesh])).rows[0].phone as string;
    const typed = `+${phone.slice(0, 2)} ${phone.slice(2, 7)}-${phone.slice(7)}`;
    assert.deepStrictEqual((await list({ q: typed })).found, expect('mahesh'));
  });

  it('finds by registration number without dashes, but not by a removed vehicle', async () => {
    const reg = (await query(`SELECT registration_no FROM crm_driver_vehicles WHERE driver_id = $1`, [ids.sunil])).rows[0].registration_no as string;
    assert.deepStrictEqual((await list({ q: reg.replace(/-/g, '').toLowerCase() })).found, expect('sunil'));
    const removed = (await query(`SELECT registration_no FROM crm_driver_vehicles WHERE driver_id = $1`, [ids.ravi])).rows[0].registration_no as string;
    assert.deepStrictEqual((await list({ q: removed })).found, []);
  });

  it('finds by licence number', async () => {
    assert.deepStrictEqual((await list({ q: '0120220019' })).found, expect('sunil'));
  });

  it('treats % and _ in the search as plain text', async () => {
    assert.deepStrictEqual((await list({ q: '100%' })).found, expect('mahesh'));
    assert.deepStrictEqual((await list({ q: '%' })).found, expect('mahesh'));
    assert.deepStrictEqual((await list({ q: '_' })).found, []);
  });

  it('combines search with the status filter', async () => {
    assert.deepStrictEqual((await list({ status: 'PENDING_DOCS' })).found, expect('mahesh'));
    assert.deepStrictEqual((await list({ q: 'yadav', status: 'PENDING_DOCS' })).found, []);
    assert.deepStrictEqual((await list({})).found, expect('sunil', 'mahesh', 'ravi'));
  });

  it('returns every city for the city filter', async () => {
    const { cities } = await list({ q: 'nobody-matches-this' });
    assert.ok(cities.includes(CITY));
  });
});
