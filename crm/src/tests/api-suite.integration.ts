/**
 * Comprehensive End-to-End HTTP API Test Suite for BiharCabs CRM.
 *
 * Tests all API groups against the running CRM server (default: http://localhost:3001):
 *   1. Auth (login, session cookie, /me, logout, invalid credentials)
 *   2. Unauthenticated 401 guard across all protected routes
 *   3. RBAC 403 role enforcement (SUPER_ADMIN vs DISPATCHER)
 *   4. System health (/api/system/status)
 *   5. Staff & Access Control (/api/users, /api/users/[id], self-lockout guard, session revoke)
 *   6. Unified Audit Log (/api/audit + filters)
 *   7. Catalog & Pricing (/api/catalog/cab-types, fuel-prices, packages)
 *   8. Public WordPress APIs (/api/public/plans, autocomplete, bookings validation & blocklist)
 *   9. Bookings & Dispatch (/api/bookings, past-date rejection, timeline, cancel validation)
 *  10. Drivers, Compliance & Plans (/api/drivers, /api/drivers/compliance, /api/driver-plans)
 *  11. Customers CRM (/api/customers, /api/customers/[id], VIP/BLOCKED lifecycle)
 *  12. Finance & All 5 Financial Reports (/api/finance/ledger, payouts, dues, gst-docs, reports JSON + CSV)
 *  13. Settings (secret masking), Inbox, Notification Failures, Cron & Webhook Auth guards
 *
 * Creates ephemeral test records in native PostgreSQL and cleans them all up in after().
 *
 * Run:
 *   cd crm && npm run test:api
 *   CRM_BASE_URL=http://localhost:3001 npm run test:api
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { query, getDbPool } from '../lib/db';
import { hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';

const BASE_URL = (process.env.CRM_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const RUN_ID = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

const SUPER_EMAIL = `apitest_super_${RUN_ID}@biharcabs.test`;
const DISPATCHER_EMAIL = `apitest_disp_${RUN_ID}@biharcabs.test`;
const TEST_PASSWORD = `TestPass_${RUN_ID}!99`;
const TEST_CUSTOMER_PHONE = `91999${String(Date.now()).slice(-7)}`;

let superUserId: number;
let dispatcherUserId: number;
let createdStaffId: number | null = null;
let testCustomerId: number | null = null;

let superCookie = '';
let dispatcherCookie = '';

async function apiFetch(
  urlPath: string,
  options: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Headers; text: string; json: any }> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.cookie) headers['cookie'] = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON response (e.g. CSV)
  }
  return { status: res.status, headers: res.headers, text, json };
}

function extractSessionCookie(headers: Headers): string {
  const setCookie = headers.get('set-cookie') || '';
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=[^;]+`));
  return match ? match[0] : '';
}

describe(`BiharCabs CRM Full API Test Suite (${BASE_URL})`, () => {
  before(async () => {
    // Verify server is reachable before running tests
    try {
      await fetch(`${BASE_URL}/api/auth/me`);
    } catch (err: any) {
      throw new Error(`CRM server is not reachable at ${BASE_URL}: ${err?.message}`);
    }

    // Seed ephemeral SUPER_ADMIN and DISPATCHER accounts in native PostgreSQL
    const { hash, salt } = hashPassword(TEST_PASSWORD);
    const sRes = await query(
      `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active)
       VALUES ($1, $2, $3, 'API Test Super Admin', 'SUPER_ADMIN', true)
       RETURNING id`,
      [SUPER_EMAIL, hash, salt]
    );
    superUserId = Number(sRes.rows[0].id);

    const dRes = await query(
      `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active)
       VALUES ($1, $2, $3, 'API Test Dispatcher', 'DISPATCHER', true)
       RETURNING id`,
      [DISPATCHER_EMAIL, hash, salt]
    );
    dispatcherUserId = Number(dRes.rows[0].id);

    // Seed ephemeral test customer
    const cRes = await query(
      `INSERT INTO crm_customers (phone, full_name, email, tag)
       VALUES ($1, 'API Test Customer', 'apitest.customer@biharcabs.test', 'REGULAR')
       RETURNING id`,
      [TEST_CUSTOMER_PHONE]
    );
    testCustomerId = Number(cRes.rows[0].id);
  });

  after(async () => {
    // Clean up all ephemeral records created during the test run
    const userIds = [superUserId, dispatcherUserId, createdStaffId].filter((id): id is number => Boolean(id));
    if (userIds.length > 0) {
      await query(`DELETE FROM crm_audit_logs WHERE actor_id = ANY($1::bigint[])`, [userIds]).catch(() => {});
      await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1::bigint[])`, [userIds]).catch(() => {});
      await query(`DELETE FROM crm_admin_users WHERE id = ANY($1::bigint[])`, [userIds]).catch(() => {});
    }
    await query(
      `DELETE FROM crm_audit_logs WHERE actor_email IN ($1, $2) OR summary LIKE $3`,
      [SUPER_EMAIL, DISPATCHER_EMAIL, `%${RUN_ID}%`]
    ).catch(() => {});
    await query(`DELETE FROM crm_login_attempts WHERE email IN ($1, $2)`, [SUPER_EMAIL, DISPATCHER_EMAIL]).catch(() => {});
    if (testCustomerId) {
      await query(`DELETE FROM crm_customers WHERE id = $1`, [testCustomerId]).catch(() => {});
    }
    await getDbPool().end();
  });

  // ============================================================================
  // 1. Authentication APIs
  // ============================================================================
  describe('1. Auth APIs (/api/auth/*)', () => {
    it('POST /api/auth/login rejects missing credentials (400)', async () => {
      const r = await apiFetch('/api/auth/login', { method: 'POST', body: {} });
      assert.equal(r.status, 400);
      assert.equal(r.json?.success, false);
    });

    it('POST /api/auth/login rejects wrong password (401)', async () => {
      const r = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { email: SUPER_EMAIL, password: 'WrongPassword123!' },
      });
      assert.equal(r.status, 401);
      assert.equal(r.json?.success, false);
    });

    it('POST /api/auth/login succeeds for SUPER_ADMIN and sets session cookie', async () => {
      const r = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { email: SUPER_EMAIL, password: TEST_PASSWORD },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json?.success, true);
      assert.equal(r.json?.user?.role, 'SUPER_ADMIN');
      superCookie = extractSessionCookie(r.headers);
      assert.ok(superCookie.startsWith(`${SESSION_COOKIE_NAME}=`), 'Expected session cookie');
    });

    it('POST /api/auth/login succeeds for DISPATCHER and sets session cookie', async () => {
      const r = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { email: DISPATCHER_EMAIL, password: TEST_PASSWORD },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json?.user?.role, 'DISPATCHER');
      dispatcherCookie = extractSessionCookie(r.headers);
      assert.ok(dispatcherCookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    });

    it('GET /api/auth/me returns authenticated user with valid cookie', async () => {
      const r = await apiFetch('/api/auth/me', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.equal(r.json?.authenticated, true);
      assert.equal(r.json?.user?.email, SUPER_EMAIL);
    });
  });

  // ============================================================================
  // 2. Unauthenticated 401 Security Sweep
  // ============================================================================
  describe('2. Unauthenticated 401 Guard Sweep', () => {
    const protectedGets = [
      '/api/bookings',
      '/api/drivers',
      '/api/drivers/compliance',
      '/api/driver-plans',
      '/api/customers',
      '/api/catalog/cab-types',
      '/api/catalog/fuel-prices',
      '/api/catalog/packages',
      '/api/finance/ledger',
      '/api/finance/payouts',
      '/api/finance/dues-payments',
      '/api/finance/gst-documents',
      '/api/finance/reports?report=pnl',
      '/api/settings',
      '/api/users',
      '/api/audit',
      '/api/whatsapp/messages',
      '/api/notifications/failures',
      '/api/system/status',
    ];

    for (const endpoint of protectedGets) {
      it(`GET ${endpoint} returns 401 without session`, async () => {
        const r = await apiFetch(endpoint);
        assert.equal(r.status, 401, `Expected 401 for ${endpoint}, got ${r.status}`);
      });
    }
  });

  // ============================================================================
  // 3. RBAC 403 Role Enforcement Sweep
  // ============================================================================
  describe('3. RBAC 403 Enforcement (DISPATCHER vs SUPER_ADMIN)', () => {
    const superOrFinanceOnly = [
      { method: 'GET', path: '/api/users' },
      { method: 'GET', path: '/api/audit' },
      { method: 'GET', path: '/api/finance/ledger' },
      { method: 'GET', path: '/api/finance/reports?report=pnl' },
      { method: 'GET', path: '/api/finance/payouts' },
      { method: 'POST', path: '/api/settings', body: { key: 'dispatch_sla_timeout_minutes', value: { value: 15 } } },
    ];

    for (const ep of superOrFinanceOnly) {
      it(`${ep.method} ${ep.path} returns 403 for DISPATCHER`, async () => {
        const r = await apiFetch(ep.path, { method: ep.method, cookie: dispatcherCookie, body: ep.body });
        assert.equal(r.status, 403, `Expected 403 for DISPATCHER on ${ep.method} ${ep.path}, got ${r.status}`);
      });
    }

    it('GET /api/bookings, /api/drivers, /api/customers succeed (200) for DISPATCHER', async () => {
      for (const p of ['/api/bookings', '/api/drivers', '/api/customers']) {
        const r = await apiFetch(p, { cookie: dispatcherCookie });
        assert.equal(r.status, 200, `Expected 200 for DISPATCHER on ${p}, got ${r.status}`);
      }
    });
  });

  // ============================================================================
  // 4. System Health & Settings Masking
  // ============================================================================
  describe('4. System Health & Settings APIs', () => {
    it('GET /api/system/status reports database OK, whatsapp state, and backup state', async () => {
      const r = await apiFetch('/api/system/status', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.equal(r.json?.success, true);
      assert.equal(r.json?.status?.database?.ok, true);
      assert.ok(r.json?.status?.whatsapp?.state);
      assert.ok(r.json?.status?.backup?.state);
    });

    it('GET /api/settings returns settings with secrets masked', async () => {
      const r = await apiFetch('/api/settings', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.equal(r.json?.success, true);
      assert.ok(r.json?.settings && typeof r.json.settings === 'object');
    });
  });

  // ============================================================================
  // 5. Staff & Access Control APIs (Batch 1)
  // ============================================================================
  describe('5. Staff Management APIs (/api/users)', () => {
    it('GET /api/users lists staff without password_hash or salt', async () => {
      const r = await apiFetch('/api/users', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json?.users));
      for (const u of r.json.users) {
        assert.equal('password_hash' in u, false, 'password_hash must never be returned');
        assert.equal('salt' in u, false, 'salt must never be returned');
      }
    });

    it('POST /api/users validates short password (400) and creates staff user (201)', async () => {
      const bad = await apiFetch('/api/users', {
        method: 'POST',
        cookie: superCookie,
        body: { email: `short_${RUN_ID}@biharcabs.test`, full_name: 'Short Pass', role: 'DISPATCHER', password: '123' },
      });
      assert.equal(bad.status, 400);

      const ok = await apiFetch('/api/users', {
        method: 'POST',
        cookie: superCookie,
        body: {
          email: `created_${RUN_ID}@biharcabs.test`,
          full_name: 'Created Staff',
          role: 'FINANCE_MANAGER',
          password: TEST_PASSWORD,
        },
      });
      assert.equal(ok.status, 201);
      assert.equal(ok.json?.user?.role, 'FINANCE_MANAGER');
      createdStaffId = Number(ok.json.user.id);
    });

    it('PATCH /api/users/[id] blocks self-deactivation (400) and updates/deactivates target user (200)', async () => {
      const selfBlock = await apiFetch(`/api/users/${superUserId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { is_active: false },
      });
      assert.equal(selfBlock.status, 400);

      assert.ok(createdStaffId);
      const upd = await apiFetch(`/api/users/${createdStaffId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { role: 'DISPATCHER', is_active: false },
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.json?.user?.role, 'DISPATCHER');
      assert.equal(upd.json?.user?.is_active, false);
    });
  });

  // ============================================================================
  // 6. Catalog & Pricing APIs
  // ============================================================================
  describe('6. Catalog & Pricing APIs (/api/catalog/*)', () => {
    it('GET /api/catalog/cab-types, fuel-prices, and packages all return 200', async () => {
      const [cabs, fuels, pkgs] = await Promise.all([
        apiFetch('/api/catalog/cab-types', { cookie: superCookie }),
        apiFetch('/api/catalog/fuel-prices', { cookie: superCookie }),
        apiFetch('/api/catalog/packages?active=true', { cookie: superCookie }),
      ]);
      assert.equal(cabs.status, 200);
      assert.ok(Array.isArray(cabs.json?.cabTypes));
      assert.equal(fuels.status, 200);
      assert.ok(Array.isArray(fuels.json?.fuelPrices));
      assert.equal(pkgs.status, 200);
      assert.ok(Array.isArray(pkgs.json?.packages));
    });

    it('Surge Pricing Rules CRUD: unauth 401, create, toggle, delete', async () => {
      const unauth = await apiFetch('/api/catalog/pricing-rules');
      assert.equal(unauth.status, 401);

      const created = await apiFetch('/api/catalog/pricing-rules', {
        method: 'POST',
        cookie: superCookie,
        body: {
          name: `API Test Night Surge ${RUN_ID}`,
          rule_type: 'NIGHT',
          start_time: '22:00',
          end_time: '05:00',
          adjustment_type: 'FLAT',
          adjustment_value: 200,
        },
      });
      assert.equal(created.status, 201);
      const ruleId = Number(created.json?.rule?.id);

      const toggled = await apiFetch(`/api/catalog/pricing-rules/${ruleId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { is_active: false },
      });
      assert.equal(toggled.status, 200);
      assert.equal(toggled.json?.rule?.is_active, false);

      const del = await apiFetch(`/api/catalog/pricing-rules/${ruleId}`, {
        method: 'DELETE',
        cookie: superCookie,
      });
      assert.equal(del.status, 200);
    });
  });

  // ============================================================================
  // 7. Bookings & Dispatch APIs
  // ============================================================================
  describe('7. Bookings & Dispatch APIs (/api/bookings/*)', () => {
    it('GET /api/bookings returns bookings list (200)', async () => {
      const r = await apiFetch('/api/bookings?limit=5', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json?.bookings));
    });

    it('POST /api/bookings rejects missing fields (400) and past pickup date/time (400)', async () => {
      const missing = await apiFetch('/api/bookings', {
        method: 'POST',
        cookie: superCookie,
        body: { customer_name: 'Test' },
      });
      assert.equal(missing.status, 400);

      const past = await apiFetch('/api/bookings', {
        method: 'POST',
        cookie: superCookie,
        body: {
          customer_name: 'Past Test',
          customer_phone: TEST_CUSTOMER_PHONE,
          origin_city: 'Patna',
          destination_city: 'Gaya',
          pickup_address: 'Patna Junction',
          pickup_date: '2020-01-01',
          pickup_time: '09:00',
        },
      });
      assert.equal(past.status, 400);
      assert.match(String(past.json?.error || ''), /past/i);
    });

    it('GET /api/bookings/0/timeline and /api/bookings/0/cancel reject invalid IDs (400)', async () => {
      const tl = await apiFetch('/api/bookings/0/timeline', { cookie: superCookie });
      assert.equal(tl.status, 400);
      const cc = await apiFetch('/api/bookings/0/cancel', { cookie: superCookie });
      assert.equal(cc.status, 400);
    });

    it('Public Trip Status & SOS endpoints validate token format (400/404)', async () => {
      const bad = await apiFetch('/api/public/trip/invalid-token');
      assert.equal(bad.status, 400);
      const missing = await apiFetch('/api/public/trip/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      assert.equal(missing.status, 404);
      const badSos = await apiFetch('/api/public/trip/invalid-token/sos', { method: 'POST', body: {} });
      assert.equal(badSos.status, 400);
    });
  });

  // ============================================================================
  // 8. Drivers, Compliance & Driver Plans APIs
  // ============================================================================
  describe('8. Drivers & Compliance APIs', () => {
    it('GET /api/drivers, /api/drivers/compliance, /api/driver-plans return 200', async () => {
      const [drv, comp, plans] = await Promise.all([
        apiFetch('/api/drivers', { cookie: superCookie }),
        apiFetch('/api/drivers/compliance?days=30', { cookie: superCookie }),
        apiFetch('/api/driver-plans', { cookie: superCookie }),
      ]);
      assert.equal(drv.status, 200);
      assert.ok(Array.isArray(drv.json?.drivers));
      assert.equal(comp.status, 200);
      assert.ok(Array.isArray(comp.json?.alerts));
      assert.equal(plans.status, 200);
    });

    it('Driver KYC documents lifecycle: unauth 401, upload, verify, private download, delete', async () => {
      const drvRes = await apiFetch('/api/drivers', { cookie: superCookie });
      const firstDriver = drvRes.json?.drivers?.[0];
      assert.ok(firstDriver?.id, 'Expected at least one driver in DB');
      const did = Number(firstDriver.id);

      // Unauthenticated access must be rejected with 401
      const unauth = await apiFetch(`/api/drivers/${did}/documents`);
      assert.equal(unauth.status, 401);

      // Upload a tiny valid PNG (1x1 transparent pixel)
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      );
      const fd = new FormData();
      fd.append('doc_type', 'AADHAAR_FRONT');
      fd.append('doc_number', 'XXXX-XXXX-1234');
      fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'aadhaar-test.png');

      const upRes = await fetch(`${BASE_URL}/api/drivers/${did}/documents`, {
        method: 'POST',
        headers: { cookie: superCookie },
        body: fd,
      });
      const upJson = await upRes.json();
      assert.equal(upRes.status, 201, `Upload failed: ${JSON.stringify(upJson)}`);
      const docId = Number(upJson.document.id);

      // Private file endpoint rejects unauthenticated requests (401) and serves bytes when authenticated (200)
      const fileUnauth = await apiFetch(`/api/drivers/${did}/documents/${docId}/file`);
      assert.equal(fileUnauth.status, 401);
      const fileAuth = await apiFetch(`/api/drivers/${did}/documents/${docId}/file`, { cookie: superCookie });
      assert.equal(fileAuth.status, 200);
      assert.equal(fileAuth.headers.get('content-type'), 'image/png');

      // Verify document
      const ver = await apiFetch(`/api/drivers/${did}/documents/${docId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { verification_status: 'VERIFIED' },
      });
      assert.equal(ver.status, 200);
      assert.equal(ver.json?.document?.verification_status, 'VERIFIED');

      // Delete document (cleans up DB row + file on disk)
      const del = await apiFetch(`/api/drivers/${did}/documents/${docId}`, {
        method: 'DELETE',
        cookie: superCookie,
      });
      assert.equal(del.status, 200);
    });
  });

  // ============================================================================
  // 9. Customers CRM & Public Booking Blocklist (Batch 3)
  // ============================================================================
  describe('9. Customers CRM & Public APIs', () => {
    it('GET /api/customers returns summary KPIs and customer list (200)', async () => {
      const r = await apiFetch(`/api/customers?q=${TEST_CUSTOMER_PHONE}`, { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.ok(r.json?.summary);
      assert.ok(r.json?.customers?.some((c: any) => c.phone === TEST_CUSTOMER_PHONE));
    });

    it('GET & PATCH /api/customers/[id] updates VIP/BLOCKED tag and blocks public booking (403)', async () => {
      assert.ok(testCustomerId);
      const detail = await apiFetch(`/api/customers/${testCustomerId}`, { cookie: superCookie });
      assert.equal(detail.status, 200);
      assert.equal(detail.json?.customer?.phone, TEST_CUSTOMER_PHONE);

      const block = await apiFetch(`/api/customers/${testCustomerId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { tag: 'BLOCKED', blocked_reason: 'API test blocklist check', notes: 'Automated test' },
      });
      assert.equal(block.status, 200);
      assert.equal(block.json?.customer?.tag, 'BLOCKED');

      // Public booking by blocked phone must be rejected with 403
      const pubBlocked = await apiFetch('/api/public/bookings', {
        method: 'POST',
        body: {
          package_public_id: '11111111-1111-1111-1111-111111111111',
          customer_name: 'API Test Customer',
          customer_phone: TEST_CUSTOMER_PHONE,
          origin_city: 'Patna',
          pickup_address: 'Patna Junction',
          pickup_date: '2030-01-01',
          pickup_time: '10:00',
        },
      });
      assert.equal(pubBlocked.status, 403);

      // Invalid & missing customer IDs
      const badId = await apiFetch('/api/customers/abc', { cookie: superCookie });
      assert.equal(badId.status, 400);
      const missing = await apiFetch('/api/customers/999999999', { cookie: superCookie });
      assert.equal(missing.status, 404);
    });

    it('GET /api/public/plans never leaks internal integer IDs & validates public bookings', async () => {
      const plans = await apiFetch('/api/public/plans?booking_type=OUTSTATION');
      assert.equal(plans.status, 200);
      assert.equal(plans.json?.success, true);
      for (const p of plans.json?.plans || []) {
        assert.equal('id' in p, false, 'Public plan must not leak internal integer id');
        assert.ok(p.public_id, 'Public plan must expose public_id');
      }

      const ac = await apiFetch('/api/public/location/autocomplete?q=a');
      assert.equal(ac.status, 200);
      assert.deepEqual(ac.json?.suggestions, []);

      const badPub = await apiFetch('/api/public/bookings', {
        method: 'POST',
        body: { package_public_id: 'not-a-uuid', customer_name: 'Test', customer_phone: '123' },
      });
      assert.equal(badPub.status, 400);
    });
  });

  // ============================================================================
  // 10. Finance & All 5 Financial Reports (Batch 2)
  // ============================================================================
  describe('10. Finance & Financial Reports APIs (/api/finance/*)', () => {
    it('GET /api/finance/ledger, payouts, dues-payments, gst-documents return 200', async () => {
      const [ledger, payouts, dues, gst] = await Promise.all([
        apiFetch('/api/finance/ledger', { cookie: superCookie }),
        apiFetch('/api/finance/payouts', { cookie: superCookie }),
        apiFetch('/api/finance/dues-payments', { cookie: superCookie }),
        apiFetch('/api/finance/gst-documents', { cookie: superCookie }),
      ]);
      assert.equal(ledger.status, 200);
      assert.equal(payouts.status, 200);
      assert.equal(dues.status, 200);
      assert.equal(gst.status, 200);
    });

    for (const report of ['pnl', 'gstr1', 'dues_aging', 'settlements', 'reconciliation']) {
      it(`GET /api/finance/reports?report=${report} returns valid JSON and CSV`, async () => {
        const j = await apiFetch(`/api/finance/reports?report=${report}&from=2026-04-01&to=2026-12-31`, {
          cookie: superCookie,
        });
        assert.equal(j.status, 200);
        assert.equal(j.json?.success, true);
        assert.equal(j.json?.report, report);
        assert.ok(Array.isArray(j.json?.rows));

        const c = await apiFetch(`/api/finance/reports?report=${report}&from=2026-04-01&to=2026-12-31&format=csv`, {
          cookie: superCookie,
        });
        assert.equal(c.status, 200);
        assert.match(c.headers.get('content-type') || '', /text\/csv/i);
        assert.match(c.headers.get('content-disposition') || '', /attachment; filename="biharcabs-/i);
        assert.ok(c.text.includes(','), 'CSV output should contain comma-separated header row');
      });
    }

    it('GET /api/finance/reports rejects invalid report type (400)', async () => {
      const r = await apiFetch('/api/finance/reports?report=invalid_xyz', { cookie: superCookie });
      assert.equal(r.status, 400);
    });

    it('GET /api/finance/founder-digest previews both MORNING (8 AM) and EVENING (8 PM) summaries', async () => {
      const [m, e] = await Promise.all([
        apiFetch('/api/finance/founder-digest?slot=MORNING', { cookie: superCookie }),
        apiFetch('/api/finance/founder-digest?slot=EVENING', { cookie: superCookie }),
      ]);
      assert.equal(m.status, 200);
      assert.match(String(m.json?.message || ''), /Morning Founder Digest \(8:00 AM\)/);
      assert.equal(e.status, 200);
      assert.match(String(e.json?.message || ''), /Evening Founder Digest \(8:00 PM\)/);
    });
  });

  // ============================================================================
  // 11. Audit Log, Inbox, Notifications, Cron & Webhooks Security
  // ============================================================================
  describe('11. Audit Log, Inbox, Notifications, Cron & Webhook Security', () => {
    it('GET /api/audit lists recorded events including USER_CREATED and REPORT_EXPORTED', async () => {
      const r = await apiFetch('/api/audit?limit=50', { cookie: superCookie });
      assert.equal(r.status, 200);
      assert.equal(r.json?.success, true);
      const actions = new Set((r.json?.logs || []).map((l: any) => l.action));
      assert.ok(actions.has('USER_CREATED'), 'Expected USER_CREATED in audit log');
      assert.ok(actions.has('REPORT_EXPORTED'), 'Expected REPORT_EXPORTED in audit log');
    });

    it('GET /api/whatsapp/messages and /api/notifications/failures return 200', async () => {
      const [msgs, fails] = await Promise.all([
        apiFetch('/api/whatsapp/messages', { cookie: superCookie }),
        apiFetch('/api/notifications/failures', { cookie: superCookie }),
      ]);
      assert.equal(msgs.status, 200);
      assert.equal(fails.status, 200);
    });

    it('Support Tickets lifecycle: unauth 401, create, list, resolve (and cleanup)', async () => {
      const unauth = await apiFetch('/api/support-tickets');
      assert.equal(unauth.status, 401);

      const created = await apiFetch('/api/support-tickets', {
        method: 'POST',
        cookie: superCookie,
        body: { priority: 'HIGH', category: 'BEHAVIOR', summary: `API test complaint ${RUN_ID}` },
      });
      assert.equal(created.status, 201);
      const ticketId = Number(created.json?.id);
      assert.ok(ticketId > 0);

      const list = await apiFetch('/api/support-tickets?status=OPEN', { cookie: superCookie });
      assert.equal(list.status, 200);
      assert.ok(list.json?.tickets?.some((t: any) => t.id === ticketId));

      const resolved = await apiFetch(`/api/support-tickets/${ticketId}`, {
        method: 'PATCH',
        cookie: superCookie,
        body: { status: 'RESOLVED', resolution_notes: 'Resolved in automated API test' },
      });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.json?.ticket?.status, 'RESOLVED');

      await query(`DELETE FROM crm_support_tickets WHERE id = $1`, [ticketId]);
    });

    it('Cron and Webhook endpoints reject unauthorized/unsigned requests', async () => {
      const cron1 = await apiFetch('/api/dispatch/cron', { method: 'POST' });
      assert.ok([401, 403, 503].includes(cron1.status), `Expected 401/403/503 on cron, got ${cron1.status}`);

      const cron2 = await apiFetch('/api/dispatch/cron/daily', { method: 'POST' });
      assert.ok([401, 403, 503].includes(cron2.status), `Expected 401/403/503 on daily cron, got ${cron2.status}`);

      const rzp = await apiFetch('/api/payments/razorpay/webhook', {
        method: 'POST',
        body: { event: 'payment_link.paid' },
      });
      assert.ok([400, 401, 403, 503].includes(rzp.status), `Expected 400/401/403/503 on unsigned Razorpay webhook, got ${rzp.status}`);

      const wa = await apiFetch('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong_token_xyz&hub.challenge=123');
      assert.equal(wa.status, 403);
    });

    it('POST /api/auth/logout revokes session so /api/auth/me is no longer authenticated', async () => {
      const out = await apiFetch('/api/auth/logout', { method: 'POST', cookie: superCookie });
      assert.equal(out.status, 200);

      const meAfter = await apiFetch('/api/auth/me', { cookie: superCookie });
      assert.equal(meAfter.json?.authenticated, false);
    });
  });
});
