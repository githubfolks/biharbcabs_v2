/**
 * Admin API authorization: every admin route validates the session itself (the middleware only sees
 * that a cookie exists) and checks the role's permission (src/lib/permissions.ts). Settings secrets
 * are never returned. Runs against a disposable database whose name ends in _test:
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/admin-auth.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { PERMISSIONS, Permission, ROLES, Role, hasPermission } from '../lib/permissions';
import { SECRET_MASK } from '../lib/settings-secrets';
import { getAllSettings, updateSetting } from '../lib/settings';
import { middleware } from '../middleware';

import * as bookings from '../app/api/bookings/route';
import * as bookingDispatch from '../app/api/bookings/[id]/dispatch/route';
import * as bookingCancel from '../app/api/bookings/[id]/cancel/route';
import * as drivers from '../app/api/drivers/route';
import * as driverIncentives from '../app/api/drivers/[id]/incentives/route';
import * as driverRatings from '../app/api/drivers/[id]/ratings/route';
import * as driverStatus from '../app/api/drivers/[id]/status/route';
import * as driverDetail from '../app/api/drivers/[id]/route';
import * as driverWallet from '../app/api/drivers/[id]/wallet/route';
import * as driverOffers from '../app/api/drivers/[id]/offers/route';
import * as driverPayout from '../app/api/drivers/[id]/payout-details/route';
import * as driverVehicles from '../app/api/drivers/[id]/vehicles/route';
import * as driverVehicle from '../app/api/drivers/[id]/vehicles/[vehicleId]/route';
import * as ledger from '../app/api/finance/ledger/route';
import * as payouts from '../app/api/finance/payouts/route';
import * as duesPayments from '../app/api/finance/dues-payments/route';
import * as settings from '../app/api/settings/route';
import * as messages from '../app/api/whatsapp/messages/route';
import * as notificationFailures from '../app/api/notifications/failures/route';
import * as notificationResolve from '../app/api/notifications/failures/[id]/resolve/route';
import * as gstDocuments from '../app/api/finance/gst-documents/route';
import * as systemStatus from '../app/api/system/status/route';
import * as documentsAwaitingPos from '../app/api/finance/gst-documents/place-of-supply/route';
import * as documentPos from '../app/api/finance/gst-documents/[kind]/[id]/place-of-supply/route';
import * as documentPdf from '../app/api/finance/gst-documents/[kind]/[id]/pdf/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const API_DIR = path.join(__dirname, '..', 'app', 'api');

/** Routes that are public on purpose; each authenticates in its own way. */
const PUBLIC_ROUTES = new Set([
  'auth/login',                // sign-in
  'auth/logout',               // ends the caller's own session
  'auth/me',                   // validates the session and reports who is signed in
  'whatsapp/webhook',          // Meta X-Hub-Signature-256
  'payments/razorpay/webhook', // Razorpay X-Razorpay-Signature
  'dispatch/cron',             // Bearer CRON_SECRET
  'dispatch/cron/daily',       // Bearer CRON_SECRET
  'public/plans',              // Public website catalog API (UUID-only, rate-limited)
  'public/bookings',           // Public website booking API (server-priced, rate-limited)
]);

type Handler = (req: NextRequest, ctx?: any) => Promise<Response>;
interface ProtectedRoute { name: string; method: string; handler: Handler; permission: Permission; body?: any; ctx?: any }
// Ids that do not exist, so a permitted call fails on validation or lookup and changes no data.
const NONE = { params: { id: '-1' } };
const PROTECTED: ProtectedRoute[] = [
  { name: 'GET /api/bookings', method: 'GET', handler: bookings.GET, permission: 'bookings.view' },
  { name: 'POST /api/bookings', method: 'POST', handler: bookings.POST, permission: 'bookings.create', body: {} },
  { name: 'POST /api/bookings/[id]/dispatch', method: 'POST', handler: bookingDispatch.POST, permission: 'dispatch.manage', body: { action: 'none' }, ctx: NONE },
  { name: 'GET /api/bookings/[id]/cancel', method: 'GET', handler: bookingCancel.GET, permission: 'bookings.cancel', ctx: NONE },
  { name: 'POST /api/bookings/[id]/cancel', method: 'POST', handler: bookingCancel.POST, permission: 'bookings.cancel', body: {}, ctx: NONE },
  { name: 'GET /api/drivers', method: 'GET', handler: drivers.GET, permission: 'drivers.view' },
  { name: 'POST /api/drivers', method: 'POST', handler: drivers.POST, permission: 'drivers.manage', body: {} },
  { name: 'POST /api/drivers/[id]/incentives', method: 'POST', handler: driverIncentives.POST, permission: 'incentives.award', body: { amount: -1 }, ctx: NONE },
  { name: 'GET /api/drivers/[id]/ratings', method: 'GET', handler: driverRatings.GET, permission: 'ratings.view', ctx: NONE },
  { name: 'POST /api/drivers/[id]/ratings', method: 'POST', handler: driverRatings.POST, permission: 'ratings.dispute', body: { action: 'dispute' }, ctx: NONE },
  { name: 'GET /api/drivers/[id]/status', method: 'GET', handler: driverStatus.GET, permission: 'drivers.view', ctx: NONE },
  { name: 'POST /api/drivers/[id]/status', method: 'POST', handler: driverStatus.POST, permission: 'drivers.manage', body: { action: 'none' }, ctx: NONE },
  { name: 'GET /api/drivers/[id]', method: 'GET', handler: driverDetail.GET, permission: 'drivers.view', ctx: NONE },
  { name: 'GET /api/drivers/[id]/wallet', method: 'GET', handler: driverWallet.GET, permission: 'ledger.view', ctx: NONE },
  { name: 'POST /api/drivers/[id]/offers', method: 'POST', handler: driverOffers.POST, permission: 'drivers.manage', body: {}, ctx: NONE },
  { name: 'PATCH /api/drivers/[id]', method: 'PATCH', handler: driverDetail.PATCH, permission: 'drivers.manage', body: {}, ctx: NONE },
  { name: 'PATCH /api/drivers/[id]/payout-details', method: 'PATCH', handler: driverPayout.PATCH, permission: 'drivers.payout_details', body: {}, ctx: NONE },
  { name: 'POST /api/drivers/[id]/vehicles', method: 'POST', handler: driverVehicles.POST, permission: 'drivers.manage', body: {}, ctx: NONE },
  { name: 'PATCH /api/drivers/[id]/vehicles/[vehicleId]', method: 'PATCH', handler: driverVehicle.PATCH, permission: 'drivers.manage', body: {}, ctx: { params: { id: '-1', vehicleId: '-1' } } },
  { name: 'DELETE /api/drivers/[id]/vehicles/[vehicleId]', method: 'DELETE', handler: driverVehicle.DELETE, permission: 'drivers.manage', body: {}, ctx: { params: { id: '-1', vehicleId: '-1' } } },
  { name: 'GET /api/finance/ledger', method: 'GET', handler: ledger.GET, permission: 'ledger.view' },
  { name: 'POST /api/finance/ledger', method: 'POST', handler: ledger.POST, permission: 'ledger.settle', body: {} },
  { name: 'GET /api/finance/payouts', method: 'GET', handler: payouts.GET, permission: 'ledger.view' },
  { name: 'POST /api/finance/payouts', method: 'POST', handler: payouts.POST, permission: 'payouts.record', body: {} },
  { name: 'GET /api/finance/dues-payments', method: 'GET', handler: duesPayments.GET, permission: 'ledger.view' },
  { name: 'POST /api/finance/dues-payments', method: 'POST', handler: duesPayments.POST, permission: 'dues.record', body: {} },
  { name: 'GET /api/settings', method: 'GET', handler: settings.GET, permission: 'settings.view' },
  { name: 'POST /api/settings', method: 'POST', handler: settings.POST, permission: 'settings.change', body: {} },
  { name: 'GET /api/whatsapp/messages', method: 'GET', handler: messages.GET, permission: 'inbox.use' },
  { name: 'POST /api/whatsapp/messages', method: 'POST', handler: messages.POST, permission: 'inbox.use', body: {} },
  { name: 'GET /api/notifications/failures', method: 'GET', handler: notificationFailures.GET, permission: 'bookings.view' },
  { name: 'POST /api/notifications/failures/[id]/resolve', method: 'POST', handler: notificationResolve.POST, permission: 'notifications.resolve', body: {}, ctx: NONE },
  { name: 'GET /api/system/status', method: 'GET', handler: systemStatus.GET, permission: 'settings.view' },
  { name: 'GET /api/finance/gst-documents', method: 'GET', handler: gstDocuments.GET, permission: 'ledger.view' },
  { name: 'GET /api/finance/gst-documents/place-of-supply', method: 'GET', handler: documentsAwaitingPos.GET, permission: 'ledger.view' },
  { name: 'POST /api/finance/gst-documents/[kind]/[id]/place-of-supply', method: 'POST', handler: documentPos.POST, permission: 'gst_documents.manage', body: { stateCode: 'xx' }, ctx: { params: { kind: 'TI', id: '-1' } } },
  { name: 'GET /api/finance/gst-documents/[kind]/[id]/pdf', method: 'GET', handler: documentPdf.GET, permission: 'ledger.view', ctx: { params: { kind: 'TI', id: '-1' } } },
];

function request(method: string, cookie?: string, body?: any) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  return new NextRequest('http://localhost:3001/api/probe', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(route: ProtectedRoute, cookie?: string, body = route.body) {
  const res = await route.handler(request(route.method, cookie, route.method === 'GET' ? undefined : body), route.ctx);
  return { status: res.status, text: await res.text() };
}
const route = (name: string) => PROTECTED.find((r) => r.name === name)!;

const RUN = crypto.randomBytes(4).toString('hex');
const tokens = {} as Record<Role, string>;
let expiredToken = '';
let inactiveToken = '';
let unknownRoleToken = '';
const adminIds: number[] = [];

async function admin(role: string, isActive = true) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active)
     VALUES ($1, $2, $3, 'Auth Test Admin', $4, $5) RETURNING id`,
    [`auth-test-${RUN}-${adminIds.length}@example.test`, hash, salt, role, isActive]
  );
  adminIds.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}

let originalMeta: any;

before(async () => {
  for (const role of ROLES) tokens[role] = (await createAdminSession(await admin(role))).token;
  const expiredAdmin = await admin('SUPER_ADMIN');
  expiredToken = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO crm_admin_sessions (user_id, session_token, expires_at) VALUES ($1, $2, CURRENT_TIMESTAMP - INTERVAL '1 minute')`,
    [expiredAdmin, expiredToken]
  );
  inactiveToken = (await createAdminSession(await admin('SUPER_ADMIN', false))).token;
  unknownRoleToken = (await createAdminSession(await admin('INTERN'))).token;
  originalMeta = (await getAllSettings(true)).meta_whatsapp_config;
});

after(async () => {
  if (originalMeta !== undefined) await updateSetting('meta_whatsapp_config', originalMeta);
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('every admin route checks the session and the role', () => {
  it('each handler outside the public list calls requireAdmin(req, <known permission>) first', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'route.ts') files.push(full);
      }
    };
    walk(API_DIR);
    assert.ok(files.length > 10, 'found the route files');

    const problems: string[] = [];
    for (const file of files) {
      const routeName = path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
      if (PUBLIC_ROUTES.has(routeName)) continue;
      const handlers = fs.readFileSync(file, 'utf8').split(/^export async function /m).slice(1);
      for (const h of handlers) {
        const name = h.match(/^(\w+)/)?.[1];
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(name || '')) continue;
        const beforeTry = h.split(/^\s{2}try \{/m)[0];
        const m = beforeTry.match(/const auth = await requireAdmin\(req, '([a-z_.]+)'\);\s*\n\s*if \(auth instanceof NextResponse\) return auth;/);
        if (!m) problems.push(`${name} /api/${routeName}: no requireAdmin guard`);
        else if (!(m[1] in PERMISSIONS)) problems.push(`${name} /api/${routeName}: unknown permission ${m[1]}`);
        else {
          const listed = PROTECTED.find((r) => r.name === `${name} /api/${routeName}`);
          if (!listed) problems.push(`${name} /api/${routeName}: not covered by this test's PROTECTED list`);
          else if (listed.permission !== m[1]) problems.push(`${name} /api/${routeName}: uses ${m[1]}, test expects ${listed.permission}`);
        }
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  for (const r of PROTECTED) {
    it(`${r.name}: 401 without a valid, active, unexpired session`, async () => {
      for (const [label, cookie] of [
        ['no cookie', undefined],
        ['forged cookie', 'forged-token'],
        ['empty cookie', ''],
        ['expired session', expiredToken],
        ['deactivated admin', inactiveToken],
      ] as const) {
        const res = await call(r, cookie);
        assert.strictEqual(res.status, 401, `${label} should get 401, got ${res.status}`);
      }
    });

    it(`${r.name}: roles follow the permission matrix (${r.permission})`, async () => {
      for (const role of ROLES) {
        const res = await call(r, tokens[role]);
        if (hasPermission(role, r.permission)) {
          assert.ok(res.status !== 401 && res.status !== 403, `${role} is allowed ${r.permission} but got ${res.status}`);
        } else {
          assert.strictEqual(res.status, 403, `${role} must be refused ${r.permission}, got ${res.status}`);
        }
      }
      assert.strictEqual((await call(r, unknownRoleToken)).status, 403, 'an unknown role gets nothing');
    });
  }

  it('the agreed matrix', () => {
    const allowed = (p: Permission) => ROLES.filter((role) => hasPermission(role, p)).join(',');
    assert.strictEqual(allowed('settings.change'), 'SUPER_ADMIN');
    assert.strictEqual(allowed('ledger.settle'), 'SUPER_ADMIN,FINANCE_MANAGER');
    assert.strictEqual(allowed('payouts.record'), 'SUPER_ADMIN,FINANCE_MANAGER');
    assert.strictEqual(allowed('dues.record'), 'SUPER_ADMIN,FINANCE_MANAGER');
    assert.strictEqual(allowed('bookings.override_fare'), 'SUPER_ADMIN');
    assert.strictEqual(allowed('incentives.award'), 'SUPER_ADMIN,FINANCE_MANAGER');
    assert.strictEqual(allowed('catalog.manage'), 'SUPER_ADMIN');
    assert.strictEqual(allowed('dispatch.manage'), 'SUPER_ADMIN,DISPATCHER');
    assert.strictEqual(allowed('inbox.use'), 'SUPER_ADMIN,DISPATCHER');
    assert.strictEqual(allowed('bookings.view'), 'SUPER_ADMIN,DISPATCHER,FINANCE_MANAGER');
    assert.strictEqual(allowed('notifications.resolve'), 'SUPER_ADMIN,DISPATCHER,FINANCE_MANAGER');
    assert.strictEqual(allowed('gst_documents.manage'), 'SUPER_ADMIN,FINANCE_MANAGER');
  });

  it('a dispatcher cannot waive the advance; validation still applies for the super admin', async () => {
    const body = {
      customer_phone: '910000009999', origin_city: 'Patna', pickup_date: '2026-12-01', pickup_time: '10:00',
      wp_vehicle_code: 'sedan', customer_total_fare: 2500, advance_mode: 'WAIVED', advance_waiver_reason: 'short',
    };
    const dispatcher = await call(route('POST /api/bookings'), tokens.DISPATCHER, body);
    assert.strictEqual(dispatcher.status, 403);
    assert.ok(dispatcher.text.includes('cannot waive'));
    const superAdmin = await call(route('POST /api/bookings'), tokens.SUPER_ADMIN, body);
    assert.strictEqual(superAdmin.status, 400, 'super admin passes the role check and hits the reason rule');
  });

  it('middleware answers API calls without a cookie with 401 JSON, pages with a login redirect', async () => {
    const api = middleware(new NextRequest('http://localhost:3001/api/drivers'));
    assert.strictEqual(api.status, 401);
    const page = middleware(new NextRequest('http://localhost:3001/finance'));
    assert.strictEqual(page.status, 307);
    assert.ok(page.headers.get('location')?.includes('/login'));
    const webhook = middleware(new NextRequest('http://localhost:3001/api/payments/razorpay/webhook', { method: 'POST' }));
    assert.strictEqual(webhook.headers.get('x-middleware-next'), '1', 'Razorpay webhook is not blocked by the cookie check');
  });
});

describe('settings secrets', () => {
  const REAL_TOKEN = `test-meta-token-${RUN}`;
  const REAL_VERIFY = `test-verify-${RUN}`;

  before(async () => {
    // phone_number_id stays empty, so WhatsApp sends remain simulated.
    await updateSetting('meta_whatsapp_config', { ...originalMeta, access_token: REAL_TOKEN, webhook_verify_token: REAL_VERIFY, phone_number_id: '' });
  });

  it('are masked in GET, for every role', async () => {
    for (const role of ROLES) {
      const res = await call(route('GET /api/settings'), tokens[role]);
      assert.strictEqual(res.status, 200);
      assert.ok(!res.text.includes(REAL_TOKEN) && !res.text.includes(REAL_VERIFY), `${role} must not see secrets`);
      const meta = JSON.parse(res.text).settings.meta_whatsapp_config;
      assert.strictEqual(meta.access_token, SECRET_MASK);
      assert.strictEqual(meta.webhook_verify_token, SECRET_MASK);
      assert.strictEqual(meta.api_version, originalMeta.api_version, 'non-secret fields are shown');
    }
  });

  it('saving the masked value back keeps the stored secret, and the response stays masked', async () => {
    const shown = JSON.parse((await call(route('GET /api/settings'), tokens.SUPER_ADMIN)).text).settings.meta_whatsapp_config;
    const res = await call(route('POST /api/settings'), tokens.SUPER_ADMIN, { key: 'meta_whatsapp_config', value: { ...shown, api_version: 'v21.0' } });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes(REAL_TOKEN));
    const stored = (await getAllSettings(true)).meta_whatsapp_config;
    assert.strictEqual(stored.access_token, REAL_TOKEN);
    assert.strictEqual(stored.webhook_verify_token, REAL_VERIFY);
  });

  it('omitting a secret keeps it; sending a new value replaces it', async () => {
    const { access_token, ...rest } = (await getAllSettings(true)).meta_whatsapp_config;
    assert.ok(access_token);
    await call(route('POST /api/settings'), tokens.SUPER_ADMIN, { key: 'meta_whatsapp_config', value: rest });
    assert.strictEqual((await getAllSettings(true)).meta_whatsapp_config.access_token, REAL_TOKEN);

    await call(route('POST /api/settings'), tokens.SUPER_ADMIN, { key: 'meta_whatsapp_config', value: { ...rest, access_token: 'rotated-token' } });
    assert.strictEqual((await getAllSettings(true)).meta_whatsapp_config.access_token, 'rotated-token');
  });

  it('a dispatcher cannot change settings at all', async () => {
    const res = await call(route('POST /api/settings'), tokens.DISPATCHER, { key: 'meta_whatsapp_config', value: { access_token: 'attacker' } });
    assert.strictEqual(res.status, 403);
    assert.notStrictEqual((await getAllSettings(true)).meta_whatsapp_config.access_token, 'attacker');
  });
});
