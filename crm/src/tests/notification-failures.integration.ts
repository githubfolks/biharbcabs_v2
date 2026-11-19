/**
 * Failed WhatsApp messages: every failed business-initiated message is recorded (never its contents,
 * which can carry the trip OTP), admins get one summary per frequent cron run, and staff mark each one
 * handled. Runs against a disposable database whose name ends in _test (migrations 08 to 24):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/notification-failures.integration.ts
 *
 * WhatsApp sends are simulated (logged to crm_whatsapp_logs) when no Meta token is configured; failures
 * are produced with a missing template name, a failing free-form send, and a send that throws.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { bookingCodeIn, notify } from '../lib/wa-notify';
import { listOpenNotificationFailures, resolveNotificationFailure, runFailedMessageDigest } from '../lib/notification-failures';
import { executeFrequentCronTasks } from '../lib/cron-service';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = String(Date.now()).slice(-5);
let seq = 0;
const phone = () => `9192${RUN}${String(seq++).padStart(3, '0')}`;
let originalTemplates: any;
let adminId = 0;

const failuresFor = async (p: string) => (await query(`SELECT * FROM crm_notification_failures WHERE phone = $1 ORDER BY id`, [p])).rows;
const openWindow = (p: string) =>
  query(`INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status) VALUES ('INBOUND', $1, 'text', '{}'::jsonb, 'RECEIVED')`, [p]);
/** Outbound admin summaries that mention this phone. */
const summariesMentioning = async (p: string) =>
  (await query(`SELECT payload::text AS t FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND payload::text LIKE '%did not reach the recipient%' AND payload::text LIKE $1`, [`%${p}%`])).rows;

/** Make template sends of `key` fail: no approved template name configured. */
async function withoutTemplate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const { [key]: _removed, ...rest } = originalTemplates;
  await updateSetting('whatsapp_templates', rest);
  try {
    return await fn();
  } finally {
    await updateSetting('whatsapp_templates', originalTemplates);
  }
}

before(async () => {
  originalTemplates = (await getAllSettings(true)).whatsapp_templates;
  assert.ok(originalTemplates?.customer_trip_otp, 'test database has template names configured');
  const { hash, salt } = await hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Failures Tester', 'DISPATCHER', true) RETURNING id`,
    [`failures-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
  // Earlier suites leave failures behind; claim them so each summary below covers only this suite's.
  await runFailedMessageDigest();
});
after(async () => {
  if (originalTemplates) await updateSetting('whatsapp_templates', originalTemplates);
  await getDbPool().end();
});

describe('recording', () => {
  it('a template that cannot be sent is recorded with its booking code, never the OTP', async () => {
    const p = phone();
    const otp = '4827';
    const r = await withoutTemplate('customer_trip_otp', () => notify(p, 'customer_trip_otp', { params: ['#BC-FAIL01', otp] }));
    assert.strictEqual(r.success, false, 'the caller still sees the failure');
    const rows = await failuresFor(p);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].template_key, 'customer_trip_otp');
    assert.strictEqual(rows[0].channel, 'TEMPLATE');
    assert.strictEqual(rows[0].booking_code, 'BC-FAIL01');
    assert.ok(rows[0].error.includes('No template configured'));
    assert.ok(!JSON.stringify(rows[0]).includes(otp), 'the OTP is not stored');
  });

  it('a failed free-form send inside the service window is recorded', async () => {
    const p = phone();
    await openWindow(p);
    const r = await notify(p, 'customer_trip_started', {
      params: ['#BC-FAIL02'],
      freeform: async () => ({ success: false, error: 'Meta said no' }),
    });
    assert.strictEqual(r.success, false);
    const rows = await failuresFor(p);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].channel, 'FREEFORM');
    assert.strictEqual(rows[0].error, 'Meta said no');
  });

  it('a send that throws is recorded and the error still reaches the caller', async () => {
    const p = phone();
    await openWindow(p);
    await assert.rejects(
      notify(p, 'driver_account_notice', { params: ['notice'], freeform: async () => { throw new Error('network down'); } }),
      /network down/
    );
    const rows = await failuresFor(p);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].channel, 'FREEFORM');
    assert.strictEqual(rows[0].booking_code, null, 'account notices have no booking code');
    assert.strictEqual(rows[0].error, 'network down');
  });

  it('a call with the wrong params is recorded before any channel is chosen', async () => {
    const p = phone();
    await assert.rejects(notify(p, 'customer_trip_otp', { params: ['#BC-FAIL03'] }), /expected 2 params/);
    const rows = await failuresFor(p);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].channel, null);
  });

  it('successful sends record nothing', async () => {
    const p = phone();
    assert.strictEqual((await notify(p, 'customer_trip_started', { params: ['#BC-OK0001'] })).success, true);
    assert.strictEqual((await failuresFor(p)).length, 0);
  });

  it('the booking code is read from the template\'s booking code param only', () => {
    assert.strictEqual(bookingCodeIn('customer_payment_link', ['₹500', '#BC-AB12CD', 'https://rzp.io/x', 30, '₹2,000']), 'BC-AB12CD');
    assert.strictEqual(bookingCodeIn('driver_account_notice', ['Trip #BC-AB12CD cancelled']), null);
    assert.strictEqual(bookingCodeIn('customer_trip_started', ['no code']), null);
  });
});

describe('admin summary', () => {
  // Report anything recorded by earlier tests, so each summary below covers only its own failures.
  beforeEach(() => runFailedMessageDigest());

  it('one summary lists the failures, each reported only once', async () => {
    const a = phone();
    const b = phone();
    await withoutTemplate('customer_payment_link', async () => {
      await notify(a, 'customer_payment_link', { params: ['₹500', '#BC-SUM001', 'https://rzp.io/x', 30, '₹2,000'] });
      await notify(b, 'customer_payment_link', { params: ['₹500', '#BC-SUM002', 'https://rzp.io/y', 30, '₹2,000'] });
    });
    assert.strictEqual(await runFailedMessageDigest(), 2);
    const sent = await summariesMentioning(a);
    assert.strictEqual(sent.length, 1, 'one summary per admin contact');
    assert.ok(sent[0].t.includes('2 WhatsApp messages'));
    assert.ok(sent[0].t.includes('Advance payment link (customer)'));
    assert.ok(sent[0].t.includes('#BC-SUM001') && sent[0].t.includes(b));
    assert.strictEqual(await runFailedMessageDigest(), 0, 'nothing left to report');
    assert.strictEqual((await summariesMentioning(a)).length, 1);
  });

  it('lists five and counts the rest', async () => {
    const phones = Array.from({ length: 7 }, phone);
    await withoutTemplate('customer_trip_started', async () => {
      for (const p of phones) await notify(p, 'customer_trip_started', { params: ['#BC-MANY01'] });
    });
    assert.strictEqual(await runFailedMessageDigest(), 7);
    const t = (await summariesMentioning(phones[0]))[0].t;
    assert.ok(t.includes('7 WhatsApp messages') && t.includes('and 2 more'));
    assert.ok(!t.includes(phones[6]), 'the sixth and seventh are counted, not listed');
  });

  it('failed admin alerts and failures already handled are not reported, and not reported later', async () => {
    const admin = phone();
    const handled = phone();
    await withoutTemplate('admin_alert', () => notify(admin, 'admin_alert', { params: ['test alert'] }));
    await withoutTemplate('customer_trip_started', () => notify(handled, 'customer_trip_started', { params: ['#BC-DONE01'] }));
    await resolveNotificationFailure(Number((await failuresFor(handled))[0].id), adminId);
    assert.strictEqual(await runFailedMessageDigest(), 0);
    assert.ok((await failuresFor(admin))[0].alerted_at, 'claimed, so it is not reconsidered every run');
    assert.strictEqual((await summariesMentioning(admin)).length, 0);
    assert.strictEqual((await summariesMentioning(handled)).length, 0);
  });

  it('runs in the frequent job', async () => {
    const p = phone();
    await withoutTemplate('driver_wakeup', () => notify(p, 'driver_wakeup', { params: ['#BC-CRON01', 'today 10:00', 'Patna'], ref: 1 }));
    const result = await executeFrequentCronTasks();
    assert.ok(result.failedMessagesReported >= 1);
    assert.ok((await failuresFor(p))[0].alerted_at);
    assert.strictEqual((await summariesMentioning(p)).length, 1);
  });
});

describe('dispatch board list', () => {
  it('lists open failures with a staff-facing title; marking handled removes it and records who', async () => {
    const p = phone();
    await withoutTemplate('driver_trip_assigned', () =>
      notify(p, 'driver_trip_assigned', { params: ['#BC-LIST01', 'Kankarbagh', 'today 10:00', 'Asha 9100000000', '₹1,500'], ref: 1 })
    );
    const id = Number((await failuresFor(p))[0].id);
    const open = await listOpenNotificationFailures();
    const item = open.failures.find((f) => f.id === id);
    assert.ok(item);
    assert.strictEqual(item.title, 'Ride assigned (driver)');
    assert.strictEqual(item.bookingCode, 'BC-LIST01');
    assert.ok(open.openCount >= 1);

    await resolveNotificationFailure(id, adminId);
    const row = (await failuresFor(p))[0];
    assert.ok(row.resolved_at);
    assert.strictEqual(Number(row.resolved_by), adminId);
    assert.ok(!(await listOpenNotificationFailures()).failures.some((f) => f.id === id));
  });

  it('marking handled twice, an unknown id, or an invalid id is refused', async () => {
    const p = phone();
    await withoutTemplate('customer_trip_started', () => notify(p, 'customer_trip_started', { params: ['#BC-TWICE1'] }));
    const id = Number((await failuresFor(p))[0].id);
    await resolveNotificationFailure(id, adminId);
    await assert.rejects(resolveNotificationFailure(id, adminId), (e: any) => e.status === 409);
    await assert.rejects(resolveNotificationFailure(2_000_000_000, adminId), (e: any) => e.status === 404);
    await assert.rejects(resolveNotificationFailure(-1, adminId), (e: any) => e.status === 400);
  });
});
