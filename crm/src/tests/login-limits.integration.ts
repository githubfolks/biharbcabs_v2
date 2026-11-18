/**
 * Admin sign-in attempt limits. Runs against a disposable database whose name ends in _test
 * (migration 13 applied):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/login-limits.integration.ts
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import path from 'path';
import { execFileSync } from 'child_process';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { getLoginSecurityPolicy, purgeOldLoginAttempts } from '../lib/login-security';
import { POST as loginPOST } from '../app/api/auth/login/route';

const dbUrl = process.env.DATABASE_URL || 'postgresql://x/none';
if (!new URL(dbUrl).pathname.slice(1).endsWith('_test')) throw new Error('Refusing to run: not a _test database.');

const RUN = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'correct-horse-battery-staple';
const POLICY = { max_failures_per_email: 3, max_failures_per_ip: 5, window_minutes: 15, retention_days: 90 };
let seq = 0;
let originalPolicy: any;
const userIds: number[] = [];

async function adminUser(isActive = true) {
  const email = `login-${RUN}-${seq++}@example.test`;
  const { hash, salt } = hashPassword(PASSWORD);
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Login Tester', 'DISPATCHER', $4) RETURNING id`,
    [email, hash, salt, isActive]
  );
  userIds.push(Number(r.rows[0].id));
  return email;
}
async function login(email: string, password: string, headers: Record<string, string> = {}) {
  const res = await loginPOST(new NextRequest('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  }));
  return { status: res.status, json: await res.json(), retryAfter: res.headers.get('retry-after'), cookie: res.headers.get('set-cookie') };
}
const attempts = async (email: string) =>
  (await query(`SELECT outcome, ip_address FROM crm_login_attempts WHERE email = $1 ORDER BY id`, [email])).rows;

before(async () => {
  originalPolicy = (await getAllSettings(true)).login_security_policy;
  await updateSetting('login_security_policy', POLICY);
});
afterEach(() => {
  delete process.env.CLIENT_IP_HEADER;
});
after(async () => {
  if (originalPolicy !== undefined) await updateSetting('login_security_policy', originalPolicy);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [userIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [userIds]);
  await getDbPool().end();
});

describe('per-email limit', () => {
  it('a correct password signs in and is recorded', async () => {
    const email = await adminUser();
    const res = await login(email, PASSWORD);
    assert.strictEqual(res.status, 200);
    assert.ok(res.cookie?.includes('biharcabs_crm_session='));
    assert.deepStrictEqual((await attempts(email)).map((a) => a.outcome), ['SUCCESS']);
  });

  it('locks after the limit; even the right password is refused until the window passes', async () => {
    const email = await adminUser();
    for (let i = 0; i < POLICY.max_failures_per_email; i++) assert.strictEqual((await login(email, 'wrong')).status, 401);

    const locked = await login(email, PASSWORD);
    assert.strictEqual(locked.status, 429);
    assert.ok(Number(locked.retryAfter) > 0 && Number(locked.retryAfter) <= POLICY.window_minutes * 60);
    assert.match(locked.json.error, /Too many failed sign-in attempts/);
    assert.strictEqual(locked.cookie, null, 'no session while locked');

    // Window passes: failures age out and the right password works again.
    await query(`UPDATE crm_login_attempts SET attempted_at = attempted_at - make_interval(mins => $2) WHERE email = $1`, [email, POLICY.window_minutes + 1]);
    assert.strictEqual((await login(email, PASSWORD)).status, 200);
  });

  it('a successful sign-in resets the count', async () => {
    const email = await adminUser();
    await login(email, 'wrong');
    await login(email, 'wrong');
    assert.strictEqual((await login(email, PASSWORD)).status, 200);
    await login(email, 'wrong');
    await login(email, 'wrong');
    assert.strictEqual((await login(email, 'wrong')).status, 401, 'third failure since the success is still allowed');
    assert.strictEqual((await login(email, PASSWORD)).status, 429, 'then locked');
  });

  it('unknown emails behave exactly like wrong passwords, so lockouts reveal nothing', async () => {
    const known = await adminUser();
    const unknown = `nobody-${RUN}@example.test`;
    const a = await login(known, 'wrong');
    const b = await login(unknown, 'wrong');
    assert.strictEqual(a.status, b.status);
    assert.deepStrictEqual(a.json, b.json);
    for (let i = 1; i < POLICY.max_failures_per_email; i++) await login(unknown, 'wrong');
    assert.strictEqual((await login(unknown, 'wrong')).status, 429);
  });

  it('a deactivated account says so only to someone with the right password', async () => {
    const email = await adminUser(false);
    const wrong = await login(email, 'wrong');
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.json.error, 'Invalid email or password');
    assert.strictEqual((await login(email, PASSWORD)).status, 403);
  });

  it('parallel guesses cannot exceed the limit', async () => {
    const email = await adminUser();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(email, 'wrong')));
    assert.strictEqual(results.filter((r) => r.status === 401).length, POLICY.max_failures_per_email);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 10 - POLICY.max_failures_per_email);
    assert.strictEqual((await attempts(email)).filter((a) => a.outcome === 'FAILURE').length, POLICY.max_failures_per_email);
  });

  it('email case and spaces do not give extra attempts', async () => {
    const email = await adminUser();
    await login(email, 'wrong');
    await login(email.toUpperCase(), 'wrong');
    await login(`  ${email}  `, 'wrong');
    assert.strictEqual((await login(email, PASSWORD)).status, 429);
  });

  it('rejects malformed input', async () => {
    const bad = await loginPOST(new NextRequest('http://localhost:3001/api/auth/login', { method: 'POST', body: '{"email":["x"],"password":1}' }));
    assert.strictEqual(bad.status, 400);
    const notJson = await loginPOST(new NextRequest('http://localhost:3001/api/auth/login', { method: 'POST', body: 'nope' }));
    assert.strictEqual(notJson.status, 400);
    assert.strictEqual((await login('a'.repeat(300) + '@x.test', 'x')).status, 401);
  });
});

describe('per-IP limit', () => {
  it('is off unless CLIENT_IP_HEADER is set: a caller-supplied X-Forwarded-For is ignored', async () => {
    const email = await adminUser();
    await login(email, 'wrong', { 'x-forwarded-for': '203.0.113.9' });
    assert.strictEqual((await attempts(email))[0].ip_address, null);
  });

  it('with a trusted header, too many failures from one IP block it across emails', async () => {
    process.env.CLIENT_IP_HEADER = 'x-forwarded-for';
    // Unique per run (documentation range), so earlier runs inside the window cannot affect this one.
    const ip = `2001:db8::${RUN.slice(0, 4)}:${RUN.slice(4)}`;
    for (let i = 0; i < POLICY.max_failures_per_ip; i++) {
      // Different emails, each under its own limit; the proxy appends the real IP last.
      assert.strictEqual((await login(`spray-${RUN}-${i}@example.test`, 'wrong', { 'x-forwarded-for': `10.9.9.9, ${ip}` })).status, 401);
    }
    const victim = await adminUser();
    assert.strictEqual((await login(victim, PASSWORD, { 'x-forwarded-for': `1.1.1.1, ${ip}` })).status, 429, 'blocked IP');
    assert.strictEqual((await login(victim, PASSWORD, { 'x-forwarded-for': `2001:db8::1:${RUN.slice(0, 4)}` })).status, 200, 'other IPs unaffected');
  });
});

describe('policy and housekeeping', () => {
  it('invalid settings fall back to the default limits', async () => {
    await updateSetting('login_security_policy', { max_failures_per_email: 0, window_minutes: 'x' });
    const p = await getLoginSecurityPolicy();
    assert.deepStrictEqual(p, { max_failures_per_email: 5, max_failures_per_ip: 20, window_minutes: 15, retention_days: 90 });
    await updateSetting('login_security_policy', POLICY);
  });

  it('the daily purge removes attempts older than the retention period', async () => {
    const email = await adminUser();
    await login(email, 'wrong');
    await login(email, 'wrong');
    await query(
      `UPDATE crm_login_attempts SET attempted_at = CURRENT_TIMESTAMP - make_interval(days => $2)
       WHERE id = (SELECT MIN(id) FROM crm_login_attempts WHERE email = $1)`,
      [email, POLICY.retention_days + 1]
    );
    assert.ok((await purgeOldLoginAttempts()) >= 1);
    assert.strictEqual((await attempts(email)).length, 1, 'recent attempt kept');
  });

  it('resetting the password with the admin script lifts the lockout', async () => {
    const email = await adminUser();
    for (let i = 0; i <= POLICY.max_failures_per_email; i++) await login(email, 'wrong');
    assert.strictEqual((await login(email, PASSWORD)).status, 429);
    const newPassword = `reset-${crypto.randomBytes(8).toString('hex')}`;
    const out = execFileSync('node', [path.join(__dirname, '..', '..', 'scripts', 'set-admin-password.mjs')], {
      env: { ...process.env, DATABASE_URL: dbUrl, CRM_ADMIN_EMAIL: email, CRM_ADMIN_PASSWORD: newPassword },
      encoding: 'utf8',
    });
    assert.match(out, /cleared \d+ failed sign-in attempt/);
    assert.strictEqual((await login(email, newPassword)).status, 200);
  });
});
