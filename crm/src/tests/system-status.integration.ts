/**
 * The status pills report the real database and WhatsApp state, never a hard-coded "active", and the
 * status endpoint never returns a credential. Runs against a disposable database whose name ends in _test:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/system-status.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { getSystemStatus, whatsappState } from '../lib/system-status';
import * as statusRoute from '../app/api/system/status/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
const FAKE_TOKEN = `status-test-token-${RUN}`;
let originalMeta: any;
let adminId = 0;
let token = '';

before(async () => {
  originalMeta = (await getAllSettings(true)).meta_whatsapp_config;
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Status Tester', 'DISPATCHER', true) RETURNING id`,
    [`status-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
  token = (await createAdminSession(adminId)).token;
});
after(async () => {
  if (originalMeta !== undefined) await updateSetting('meta_whatsapp_config', originalMeta);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = $1`, [adminId]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = $1`, [adminId]);
  await getDbPool().end();
});

describe('WhatsApp state', () => {
  it('not configured beats everything; failing only when every recent send failed', () => {
    assert.strictEqual(whatsappState(false, 50, 0), 'NOT_CONFIGURED');
    assert.strictEqual(whatsappState(true, 0, 3), 'FAILING');
    assert.strictEqual(whatsappState(true, 10, 1), 'OK', 'one bad number among good sends is not an outage');
    assert.strictEqual(whatsappState(true, 0, 0), 'OK', 'no sends yet');
  });
});

describe('status from the database', () => {
  it('the database is reported reachable', async () => {
    assert.strictEqual((await getSystemStatus()).database.ok, true);
  });

  it('no token or phone number id: NOT_CONFIGURED, since sends are only simulated', async () => {
    try {
      await updateSetting('meta_whatsapp_config', { ...originalMeta, access_token: FAKE_TOKEN, phone_number_id: '' });
      assert.strictEqual((await getSystemStatus()).whatsapp.state, 'NOT_CONFIGURED');
      await updateSetting('meta_whatsapp_config', { ...originalMeta, access_token: '', phone_number_id: '123456789' });
      assert.strictEqual((await getSystemStatus()).whatsapp.state, 'NOT_CONFIGURED');
    } finally {
      await updateSetting('meta_whatsapp_config', originalMeta);
    }
  });

  it('configured: counts recent sends and failures, and reports the last successful send', async () => {
    try {
      await updateSetting('meta_whatsapp_config', { ...originalMeta, access_token: FAKE_TOKEN, phone_number_id: '123456789' });
      const phone = `9155${String(Date.now()).slice(-8)}`;
      await query(`INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status, error_message) VALUES ('OUTBOUND', $1, 'text', '{}'::jsonb, 'FAILED', 'test')`, [phone]);
      await query(`INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status) VALUES ('OUTBOUND', $1, 'text', '{}'::jsonb, 'SENT')`, [phone]);
      const after = await getSystemStatus();
      // Other suites send many messages, so only lower bounds hold: the two just logged are counted.
      assert.ok(after.whatsapp.failedLastHour >= 1 && after.whatsapp.sentLastHour >= 1);
      assert.strictEqual(typeof after.whatsapp.countsCapped, 'boolean');
      if (!after.whatsapp.countsCapped) assert.ok(after.whatsapp.sentLastHour + after.whatsapp.failedLastHour < 1000);
      assert.ok(after.whatsapp.lastSentAt && Date.now() - Date.parse(after.whatsapp.lastSentAt) < 60_000, 'the send just logged');
      assert.strictEqual(after.whatsapp.state, 'OK');
    } finally {
      await updateSetting('meta_whatsapp_config', originalMeta);
    }
  });
});

describe('endpoint', () => {
  it('signed-in staff get the status, and no credential is ever returned', async () => {
    try {
      await updateSetting('meta_whatsapp_config', { ...originalMeta, access_token: FAKE_TOKEN, phone_number_id: '123456789' });
      const res = await statusRoute.GET(new NextRequest('http://localhost:3001/api/system/status', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      const body = JSON.parse(text);
      assert.strictEqual(body.status.database.ok, true);
      assert.ok(['OK', 'FAILING'].includes(body.status.whatsapp.state));
      assert.ok(!text.includes(FAKE_TOKEN) && !text.includes('123456789'), 'no token or id in the response');
    } finally {
      await updateSetting('meta_whatsapp_config', originalMeta);
    }
  });

  it('refused without a session', async () => {
    const res = await statusRoute.GET(new NextRequest('http://localhost:3001/api/system/status'));
    assert.strictEqual(res.status, 401);
  });
});
