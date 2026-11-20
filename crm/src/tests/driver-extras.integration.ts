/**
 * Pausing ride offers (migration 32), the driver wallet view, and WhatsApp sign-up never changing a
 * registered driver. Runs against a disposable database whose name ends in _test, with migrations up to 32:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/driver-extras.integration.ts
 *
 * WhatsApp sends are simulated when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { setOffersPaused } from '../lib/driver-edits';
import { findEligibleDrivers, failedRules } from '../lib/dispatch-engine';
import { getConversation, processIncomingWhatsAppMessage, resetConversation } from '../lib/whatsapp-bot';
import * as offersRoute from '../app/api/drivers/[id]/offers/route';
import * as walletRoute from '../app/api/drivers/[id]/wallet/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
const CITY = `ExtraTown${RUN}`;
let seq = 0;
const adminIds: number[] = [];
const driverIds: number[] = [];
const phones: string[] = [];
let opsId = 0;
let opsToken = '';
let financeToken = '';

const future = () => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const phone = () => {
  const p = `9163${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  phones.push(p);
  return p;
};

async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Extras Tester', $4, true) RETURNING id`,
    [`extras-${RUN}-${adminIds.length}@example.test`, hash, salt, role]
  );
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}

async function driver(name = 'Extras Driver', status = 'APPROVED_ACTIVE') {
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, license_expiry, rating)
     VALUES ($1, $1, $2, $3, $4, true, $5, 4.9) RETURNING id, phone`,
    [phone(), name, CITY, status, future()]
  );
  const id = Number(r.rows[0].id);
  driverIds.push(id);
  await query(
    `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, insurance_expiry, fitness_expiry, permit_expiry, is_verified)
     VALUES ($1, 'sedan', $2, 'Dzire', $3, $3, $3, true)`,
    [id, `BR01XT${RUN}${seq++}`.toUpperCase(), future()]
  );
  return { id, phone: r.rows[0].phone as string };
}

const eligibleIds = async () => (await findEligibleDrivers(CITY, 'sedan', { pickupAt: new Date() })).map((e) => Number(e.driver_id));

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
  await query(`DELETE FROM crm_payments_ledger WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_driver_edits WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_drivers WHERE id = ANY($1)`, [driverIds]);
  await query(`DELETE FROM crm_whatsapp_conversations WHERE phone = ANY($1)`, [phones]);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('pausing ride offers', () => {
  it('takes the driver out of dispatch with a clear reason, without changing status, until resumed', async () => {
    const d = await driver();
    assert.ok((await eligibleIds()).includes(d.id));

    await setOffersPaused(d.id, true, 'On leave until Monday', opsId);
    assert.ok(!(await eligibleIds()).includes(d.id));
    const row = (await query(`SELECT onboarding_status, offers_paused, offers_paused_reason, offers_paused_by FROM crm_drivers WHERE id = $1`, [d.id])).rows[0];
    assert.strictEqual(row.onboarding_status, 'APPROVED_ACTIVE');
    assert.strictEqual(row.offers_paused, true);
    assert.strictEqual(row.offers_paused_reason, 'On leave until Monday');
    assert.strictEqual(Number(row.offers_paused_by), opsId);
    assert.ok(failedRules({ status_ok: true, available_ok: true, offers_ok: false, rating_ok: true, licence_ok: true, vehicle_ok: true, credit_ok: true, schedule_ok: true })
      .includes('ride offers are paused by staff'));

    // Settlement, dues payments and incentives set is_available back to true; that must not lift a pause.
    await query(`UPDATE crm_drivers SET is_available = true WHERE id = $1`, [d.id]);
    assert.ok(!(await eligibleIds()).includes(d.id), 'still paused after is_available is reset');

    await assert.rejects(setOffersPaused(d.id, true, 'Again', opsId), (e: any) => e.status === 409);
    await setOffersPaused(d.id, false, 'Back from leave', opsId);
    assert.ok((await eligibleIds()).includes(d.id));
    const edits = (await query(`SELECT action, reason FROM crm_driver_edits WHERE driver_id = $1 ORDER BY id`, [d.id])).rows;
    assert.deepStrictEqual(edits, [
      { action: 'OFFERS_PAUSE', reason: 'On leave until Monday' },
      { action: 'OFFERS_RESUME', reason: 'Back from leave' },
    ]);
  });

  it('API needs drivers.manage, a boolean and a reason', async () => {
    const d = await driver();
    const ctx = { params: { id: String(d.id) } };
    assert.strictEqual((await offersRoute.POST(req('POST', financeToken, { paused: true, reason: 'Leave' }), ctx)).status, 403);
    assert.strictEqual((await offersRoute.POST(req('POST', opsToken, { paused: 'yes', reason: 'Leave days' }), ctx)).status, 400);
    assert.strictEqual((await offersRoute.POST(req('POST', opsToken, { paused: true, reason: '' }), ctx)).status, 400);
    assert.strictEqual((await offersRoute.POST(req('POST', opsToken, { paused: false, reason: 'Not paused' }), ctx)).status, 409);
    assert.strictEqual((await offersRoute.POST(req('POST', opsToken, { paused: true, reason: 'Car in garage' }), ctx)).status, 200);
  });
});

describe('driver wallet view', () => {
  it("shows the driver's balances and only their own entries, newest first, to finance only", async () => {
    const d = await driver();
    const other = await driver();
    await query(`UPDATE crm_drivers SET wallet_balance = -150.50, security_reserve_balance = 200 WHERE id = $1`, [d.id]);
    await query(
      `INSERT INTO crm_payments_ledger (driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes, recorded_by, created_at)
       VALUES ($1, 'DRIVER_DUES_PAYMENT', 'CREDIT', 'UPI', 100, $2, 'first', $3, now() - interval '1 hour'),
              ($1, 'DRIVER_COMMISSION_DEDUCTION', 'DEBIT', 'WALLET', 250.50, $4, 'second', NULL, now()),
              ($5, 'DRIVER_PAYOUT_SENT', 'DEBIT', 'UPI', 999, $6, 'other driver', NULL, now())`,
      [d.id, `UTRX${RUN}1`, opsId, `SETTLE-X${RUN}`, other.id, `UTRX${RUN}2`]
    );
    const ctx = { params: { id: String(d.id) } };
    assert.strictEqual((await walletRoute.GET(req('GET', opsToken), ctx)).status, 403);
    const res = await walletRoute.GET(req('GET', financeToken), ctx);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.driver.wallet_balance, -150.5);
    assert.strictEqual(data.driver.security_reserve_balance, 200);
    assert.deepStrictEqual(data.entries.map((e: any) => [e.notes, e.amount]), [['second', 250.5], ['first', 100]]);
    assert.strictEqual(data.entries[1].recorded_by_name, 'Extras Tester');
    assert.strictEqual(data.totalEntries, 2);
    assert.strictEqual((await walletRoute.GET(req('GET', financeToken), { params: { id: '999999999' } })).status, 404);
  });
});

describe('WhatsApp sign-up by a registered driver', () => {
  it('changes nothing and says they are already registered, at JOIN', async () => {
    const d = await driver('Original Name', 'SUSPENDED_MANUAL');
    await resetConversation(d.phone);
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, text: 'JOIN' });
    assert.strictEqual((await getConversation(d.phone)).state, 'IDLE');
    const row = (await query(`SELECT full_name, base_city, onboarding_status FROM crm_drivers WHERE id = $1`, [d.id])).rows[0];
    assert.deepStrictEqual(row, { full_name: 'Original Name', base_city: CITY, onboarding_status: 'SUSPENDED_MANUAL' });
  });

  it('changes nothing if the number was registered while the sign-up was in progress', async () => {
    const p = phone();
    await resetConversation(p);
    await processIncomingWhatsAppMessage({ fromPhone: p, text: 'JOIN' });
    await processIncomingWhatsAppMessage({ fromPhone: p, text: 'Late Joiner' });
    await processIncomingWhatsAppMessage({ fromPhone: p, buttonId: 'city_patna', buttonText: 'Patna' });
    await processIncomingWhatsAppMessage({ fromPhone: p, buttonId: 'v_sedan', buttonText: 'Sedan (Dzire/Etios)' });
    assert.strictEqual((await getConversation(p)).state, 'DRIVER_ONBOARD_REG');

    // Staff onboard the same number in the CRM meanwhile.
    const r = await query(
      `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status) VALUES ($1, $1, 'Staff Entered', $2, 'APPROVED_ACTIVE') RETURNING id`,
      [p, CITY]
    );
    driverIds.push(Number(r.rows[0].id));
    const reg = `BR01LJ${RUN}`.toUpperCase();
    await processIncomingWhatsAppMessage({ fromPhone: p, text: reg });

    assert.strictEqual((await getConversation(p)).state, 'IDLE');
    const row = (await query(`SELECT full_name, onboarding_status FROM crm_drivers WHERE id = $1`, [r.rows[0].id])).rows[0];
    assert.deepStrictEqual(row, { full_name: 'Staff Entered', onboarding_status: 'APPROVED_ACTIVE' });
    assert.strictEqual((await query(`SELECT 1 FROM crm_driver_vehicles WHERE registration_no = $1`, [reg])).rows.length, 0);
  });
});
