/**
 * Driver payouts: recording money BiharCabs paid to a driver it owed.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 12):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/payouts.integration.ts
 *
 * WhatsApp sends are simulated when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { recordDriverPayout, PayoutError } from '../lib/payouts';
import * as payoutsRoute from '../app/api/finance/payouts/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
const ref = () => `UTR${RUN}${String(seq++).padStart(4, '0')}`;
let adminId = 0;
let financeToken = '';
let dispatcherToken = '';
const adminIds: number[] = [];

async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Payout Tester', $4, true) RETURNING id`,
    [`payout-${RUN}-${adminIds.length}@example.test`, hash, salt, role]
  );
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}
async function driver(wallet: number) {
  const phone = `9188${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, wallet_balance)
     VALUES ($1, $1, 'Payout Driver', 'Patna', 'APPROVED_ACTIVE', false, 4.9, $2) RETURNING id`,
    [phone, wallet]
  );
  return { id: Number(r.rows[0].id), phone };
}
const wallet = async (id: number) => Number((await query(`SELECT wallet_balance FROM crm_drivers WHERE id = $1`, [id])).rows[0].wallet_balance);
const payoutRows = async (id: number) =>
  (await query(`SELECT * FROM crm_payments_ledger WHERE driver_id = $1 AND transaction_type = 'DRIVER_PAYOUT_SENT' ORDER BY id`, [id])).rows;

before(async () => {
  adminId = await admin('FINANCE_MANAGER');
  financeToken = (await createAdminSession(adminId)).token;
  dispatcherToken = (await createAdminSession(await admin('DISPATCHER'))).token;
});

after(async () => {
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('recording a driver payout', () => {
  it('lowers what BiharCabs owes, writes an audited ledger entry and tells the driver', async () => {
    const d = await driver(500);
    const reference = ref();
    const result = await recordDriverPayout({ driverId: d.id, amount: 200, channel: 'UPI', reference, notes: 'Weekly payout', adminId });
    assert.strictEqual(result.newWalletBalance, 300);
    assert.strictEqual(await wallet(d.id), 300);
    const rows = await payoutRows(d.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].direction, 'DEBIT');
    assert.strictEqual(rows[0].payment_channel, 'UPI');
    assert.strictEqual(Number(rows[0].amount), 200);
    assert.strictEqual(rows[0].reference_id, reference);
    assert.strictEqual(Number(rows[0].recorded_by), adminId);
    const msg = (await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [d.phone])).rows[0];
    assert.ok(JSON.stringify(msg?.payload).includes(reference), 'driver was told about the payout');
  });

  it('can pay the full amount owed, but never more', async () => {
    const d = await driver(150.5);
    await assert.rejects(
      () => recordDriverPayout({ driverId: d.id, amount: 150.51, channel: 'UPI', reference: ref(), adminId }),
      (e: any) => e instanceof PayoutError && e.status === 400 && /owes this driver ₹150.50/.test(e.message)
    );
    assert.strictEqual(await wallet(d.id), 150.5);
    assert.strictEqual((await payoutRows(d.id)).length, 0);
    const ok = await recordDriverPayout({ driverId: d.id, amount: 150.5, channel: 'BANK_TRANSFER', reference: ref(), adminId });
    assert.strictEqual(ok.newWalletBalance, 0);
  });

  it('refuses a payout to a driver who owes BiharCabs, or is owed nothing', async () => {
    for (const balance of [-300, 0]) {
      const d = await driver(balance);
      await assert.rejects(
        () => recordDriverPayout({ driverId: d.id, amount: 1, channel: 'UPI', reference: ref(), adminId }),
        (e: any) => e instanceof PayoutError && /owes this driver nothing/.test(e.message)
      );
      assert.strictEqual(await wallet(d.id), balance);
    }
  });

  it('records a reference only once per channel', async () => {
    const d = await driver(1000);
    const reference = ref();
    await recordDriverPayout({ driverId: d.id, amount: 100, channel: 'UPI', reference, adminId });
    await assert.rejects(
      () => recordDriverPayout({ driverId: d.id, amount: 100, channel: 'UPI', reference, adminId }),
      (e: any) => e instanceof PayoutError && e.status === 409
    );
    assert.strictEqual(await wallet(d.id), 900, 'the duplicate did not lower the wallet');
    assert.strictEqual((await payoutRows(d.id)).length, 1);
  });

  it('validates amount, channel and reference', async () => {
    const d = await driver(1000);
    const bad = [
      { amount: 0, channel: 'UPI', reference: ref() },
      { amount: -5, channel: 'UPI', reference: ref() },
      { amount: 10.005, channel: 'UPI', reference: ref() },
      { amount: NaN, channel: 'UPI', reference: ref() },
      { amount: 10, channel: 'PAYTM_WALLET', reference: ref() },
      { amount: 10, channel: 'UPI', reference: '12345' },
      { amount: 10, channel: 'CASH', reference: '   ' },
    ];
    for (const b of bad) {
      await assert.rejects(() => recordDriverPayout({ driverId: d.id, ...b, adminId }), (e: any) => e instanceof PayoutError && e.status === 400, JSON.stringify(b));
    }
    assert.strictEqual(await wallet(d.id), 1000);
    await assert.rejects(() => recordDriverPayout({ driverId: -1, amount: 1, channel: 'UPI', reference: ref(), adminId }), (e: any) => e.status === 404);
  });

  it('two payouts at the same moment cannot together exceed what is owed', async () => {
    const d = await driver(300);
    const results = await Promise.allSettled([
      recordDriverPayout({ driverId: d.id, amount: 200, channel: 'UPI', reference: ref(), adminId }),
      recordDriverPayout({ driverId: d.id, amount: 200, channel: 'UPI', reference: ref(), adminId }),
    ]);
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(await wallet(d.id), 100);
    assert.strictEqual((await payoutRows(d.id)).length, 1);
  });
});

describe('payouts API', () => {
  const call = (method: 'GET' | 'POST', token: string, body?: any) =>
    (method === 'GET' ? payoutsRoute.GET : payoutsRoute.POST)(new NextRequest('http://localhost:3001/api/finance/payouts', {
      method,
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  it('lists only drivers BiharCabs owes money to', async () => {
    const owed = await driver(750);
    const owing = await driver(-750);
    const res = await call('GET', financeToken);
    assert.strictEqual(res.status, 200);
    const ids = (await res.json()).drivers.map((d: any) => Number(d.id));
    assert.ok(ids.includes(owed.id));
    assert.ok(!ids.includes(owing.id));
  });

  it('finance can record a payout; a dispatcher cannot', async () => {
    const d = await driver(400);
    const body = { driverId: d.id, amount: 400, channel: 'UPI', reference: ref() };
    assert.strictEqual((await call('POST', dispatcherToken, body)).status, 403);
    assert.strictEqual(await wallet(d.id), 400);
    const res = await call('POST', financeToken, body);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).newWalletBalance, 0);
    const dup = await call('POST', financeToken, { ...body, amount: 1 });
    assert.ok([400, 409].includes(dup.status), 'nothing left to pay, and the reference is taken');
  });
});
