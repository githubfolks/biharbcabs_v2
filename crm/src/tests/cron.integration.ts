/**
 * Scheduled-job tests: endpoint authentication, and which jobs run on which schedule.
 * Runs against a disposable database whose name ends in _test (schema, crm_settings, migrations 08 and 09):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/cron.integration.ts
 *
 * WhatsApp sends are simulated when no Meta token is configured; each is still logged in crm_whatsapp_logs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { checkCronAuthorization } from '../lib/cron-auth';
import { POST as frequentPOST, GET as frequentGET } from '../app/api/dispatch/cron/route';
import { POST as dailyPOST } from '../app/api/dispatch/cron/daily/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const SECRET = 'test-cron-secret-not-real';
const EXPIRING_PHONE = '910000000501';
const EXPIRED_PHONE = '910000000502';
let expiringDriver = 0, expiredDriver = 0;

type Handler = (req: NextRequest) => Promise<Response>;
async function call(handler: Handler, path: string, authorization?: string, method = 'POST') {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  const res = await handler(new NextRequest(`http://localhost:3001${path}`, { method, headers }));
  return { status: res.status, json: await res.json() };
}
const outboundTo = async (phone: string) =>
  (await query(`SELECT count(*)::int n FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1`, [phone])).rows[0].n;
const statusOf = async (id: number) =>
  (await query(`SELECT onboarding_status FROM crm_drivers WHERE id = $1`, [id])).rows[0].onboarding_status;

async function driverWithFitnessExpiry(phone: string, fitnessExpirySql: string): Promise<number> {
  const id = Number((await query(
    `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, wallet_balance, is_available, rating)
     VALUES ('Cron Test Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 0, true, 4.9) RETURNING id`,
    [phone]
  )).rows[0].id);
  await query(
    `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, fitness_expiry, is_verified)
     VALUES ($1, 'sedan', $2, 'Dzire', ${fitnessExpirySql}, true)`,
    [id, `BR-CRON-${phone.slice(-3)}`]
  );
  return id;
}

before(async () => {
  expiringDriver = await driverWithFitnessExpiry(EXPIRING_PHONE, `CURRENT_DATE + INTERVAL '5 days'`);
  expiredDriver = await driverWithFitnessExpiry(EXPIRED_PHONE, `CURRENT_DATE - INTERVAL '1 day'`);
});
after(async () => {
  await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = ANY($1)`, [[expiringDriver, expiredDriver]]);
  await query(`DELETE FROM crm_drivers WHERE id = ANY($1)`, [[expiringDriver, expiredDriver]]);
  await query(`DELETE FROM crm_whatsapp_logs WHERE phone = ANY($1)`, [[EXPIRING_PHONE, EXPIRED_PHONE]]);
  await getDbPool().end();
});

describe('cron authorization', () => {
  it('accepts only the exact bearer secret', () => {
    assert.strictEqual(checkCronAuthorization(`Bearer ${SECRET}`, SECRET), 'ok');
    assert.strictEqual(checkCronAuthorization(`bearer ${SECRET}`, SECRET), 'ok', 'scheme is case-insensitive');
    assert.strictEqual(checkCronAuthorization(`Bearer ${SECRET}x`, SECRET), 'unauthorized');
    assert.strictEqual(checkCronAuthorization(`Bearer ${SECRET.slice(0, -1)}`, SECRET), 'unauthorized');
    assert.strictEqual(checkCronAuthorization(SECRET, SECRET), 'unauthorized', 'missing Bearer scheme');
    assert.strictEqual(checkCronAuthorization(null, SECRET), 'unauthorized');
    assert.strictEqual(checkCronAuthorization(`Bearer ${SECRET}`, ''), 'not_configured');
  });

  it('refuses every call, and runs nothing, while CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    assert.strictEqual((await call(frequentPOST, '/api/dispatch/cron', `Bearer ${SECRET}`)).status, 503);
    assert.strictEqual((await call(dailyPOST, '/api/dispatch/cron/daily', `Bearer ${SECRET}`)).status, 503);
    assert.strictEqual(await statusOf(expiredDriver), 'APPROVED_ACTIVE', 'nothing ran');
  });

  it('rejects missing or wrong secrets on both endpoints and both methods, and runs nothing', async () => {
    process.env.CRON_SECRET = SECRET;
    assert.strictEqual((await call(frequentPOST, '/api/dispatch/cron')).status, 401);
    assert.strictEqual((await call(frequentPOST, '/api/dispatch/cron', 'Bearer guess')).status, 401);
    assert.strictEqual((await call(frequentGET, '/api/dispatch/cron', 'Bearer guess', 'GET')).status, 401);
    assert.strictEqual((await call(dailyPOST, '/api/dispatch/cron/daily')).status, 401);
    assert.strictEqual((await call(dailyPOST, '/api/dispatch/cron/daily', 'Bearer guess')).status, 401);
    assert.strictEqual(await statusOf(expiredDriver), 'APPROVED_ACTIVE', 'nothing ran');
    assert.strictEqual(await outboundTo(EXPIRING_PHONE), 0, 'nothing sent');
  });
});

describe('schedules', () => {
  it('the frequent job suspends expired documents but never sends expiry reminders, however often it runs', async () => {
    process.env.CRON_SECRET = SECRET;
    for (let i = 0; i < 3; i++) {
      const res = await call(frequentPOST, '/api/dispatch/cron', `Bearer ${SECRET}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.strictEqual('documentsExpiringWarned' in res.json.cronResults, false);
    }
    assert.strictEqual(await statusOf(expiredDriver), 'SUSPENDED_DOC_EXPIRED');
    assert.strictEqual(await outboundTo(EXPIRED_PHONE), 1, 'suspension notice sent once across three runs');
    assert.strictEqual(await outboundTo(EXPIRING_PHONE), 0, 'no reminder from the frequent job');
    assert.strictEqual(await statusOf(expiringDriver), 'APPROVED_ACTIVE', 'expiring (not expired) driver keeps working');
  });

  it('the daily job sends one reminder to a driver whose documents expire within 15 days', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call(dailyPOST, '/api/dispatch/cron/daily', `Bearer ${SECRET}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.cronResults.documentsExpiringWarned >= 1);
    assert.strictEqual(await outboundTo(EXPIRING_PHONE), 1);
    assert.strictEqual(await outboundTo(EXPIRED_PHONE), 1, 'suspended driver gets no reminder');
  });
});
