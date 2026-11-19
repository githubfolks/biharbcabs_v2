/**
 * Driver wake-up check: the reminder goes out before pickup (India time, never for past pickups), the
 * driver's confirmation is recorded, and admins are alerted once if an assigned driver has not confirmed
 * by 60 minutes before pickup. Runs against a disposable database whose name ends in _test (migrations
 * 08 to 23):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/wakeup.integration.ts
 *
 * WhatsApp sends are simulated (logged to crm_whatsapp_logs) when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { getAllSettings, getWakeupUnconfirmedAlertMinutes, updateSetting } from '../lib/settings';
import { executeFrequentCronTasks, runDriverWakeupChecks, runUnconfirmedWakeupAlerts } from '../lib/cron-service';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let customerId = 0;

/** IST date and time `minutes` from now, as stored on bookings. */
function pickupIn(minutes: number) {
  const ist = new Date(Date.now() + minutes * 60e3 + 5.5 * 3600e3).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 16) };
}
async function driver() {
  const phone = `9188${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const r = await query(`INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating) VALUES ($1, $1, 'Wakeup Driver', 'Patna', 'APPROVED_ACTIVE', 4.5) RETURNING id`, [phone]);
  return { id: Number(r.rows[0].id), phone };
}
/** A booking assigned to the driver, pickup `minutes` from now; optionally with the wake-up already sent. */
async function assigned(driverId: number, minutes: number, opts: { wakeupSentMinutesAgo?: number; status?: string } = {}) {
  const p = pickupIn(minutes);
  const r = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status, wakeup_sent_at)
     VALUES ($1, $2, $3, 'local', 'Patna', 'Kankarbagh', $4, $5, 'sedan', 1500, 1350, 150, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP - make_interval(mins => $7::int) END)
     RETURNING id, booking_code`,
    [`BC-W${RUN}${seq++}`, customerId, driverId, p.date, p.time, opts.status || 'DRIVER_ASSIGNED', opts.wakeupSentMinutesAgo ?? null]
  );
  return { id: Number(r.rows[0].id), code: r.rows[0].booking_code as string };
}
const row = async (id: number) => (await query(`SELECT wakeup_sent_at, wakeup_confirmed_at, wakeup_alerted_at FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const lastTo = async (p: string) => JSON.stringify((await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0]?.payload || '');
const adminAlertsFor = async (code: string) =>
  Number((await query(`SELECT COUNT(*) FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND payload::text LIKE $1`, [`%NOT confirmed trip #${code}%`])).rows[0].count);

let originalAlertSetting: any;
before(async () => {
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Wakeup Customer') RETURNING id`, [`9189${String(Date.now()).slice(-6)}${seq++}`])).rows[0].id);
  originalAlertSetting = (await getAllSettings(true)).driver_wakeup_unconfirmed_alert_minutes;
  assert.strictEqual(await getWakeupUnconfirmedAlertMinutes(), 60, 'migration 23 sets 60 minutes');
});
after(async () => {
  if (originalAlertSetting !== undefined) await updateSetting('driver_wakeup_unconfirmed_alert_minutes', originalAlertSetting);
  await getDbPool().end();
});

describe('wake-up reminder', () => {
  it('goes to drivers with a pickup within the window, never for a pickup already past or far away', async () => {
    const d = await driver();
    const soon = await assigned(d.id, 90);
    const far = await assigned(d.id, 5 * 60);
    const past = await assigned(d.id, -30);
    await runDriverWakeupChecks();
    assert.ok((await row(soon.id)).wakeup_sent_at, 'pickup in 90 min: reminder sent');
    assert.strictEqual((await row(far.id)).wakeup_sent_at, null, 'pickup in 5 hours: not yet');
    assert.strictEqual((await row(past.id)).wakeup_sent_at, null, 'pickup already past: no reminder');
  });
});

describe('driver confirms', () => {
  it('tapping "I am ready" records the confirmation for that trip', async () => {
    const d = await driver();
    const b = await assigned(d.id, 90, { wakeupSentMinutesAgo: 1 });
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `wakeup_ready_${b.id}` });
    assert.ok((await row(b.id)).wakeup_confirmed_at);
    assert.ok((await lastTo(d.phone)).includes(`confirmed for trip #${b.code}`));
  });

  it('typing "ready" confirms the next upcoming trip', async () => {
    const d = await driver();
    const later = await assigned(d.id, 300);
    const next = await assigned(d.id, 90);
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, text: 'ready' });
    assert.ok((await row(next.id)).wakeup_confirmed_at);
    assert.strictEqual((await row(later.id)).wakeup_confirmed_at, null);
  });

  it('another driver cannot confirm someone else\'s trip; a driver with no trip is told so', async () => {
    const owner = await driver();
    const other = await driver();
    const b = await assigned(owner.id, 90);
    await processIncomingWhatsAppMessage({ fromPhone: other.phone, buttonId: `wakeup_ready_${b.id}` });
    assert.strictEqual((await row(b.id)).wakeup_confirmed_at, null);
    assert.ok((await lastTo(other.phone)).includes('could not find an upcoming trip'));
  });
});

describe('unconfirmed driver alert (60 minutes before pickup)', () => {
  it('alerts admins once when the driver has not confirmed by 60 minutes before pickup', async () => {
    const d = await driver();
    const b = await assigned(d.id, 50, { wakeupSentMinutesAgo: 40 });
    await runUnconfirmedWakeupAlerts();
    assert.ok((await row(b.id)).wakeup_alerted_at);
    assert.strictEqual(await adminAlertsFor(b.code), 1);
    await runUnconfirmedWakeupAlerts();
    assert.strictEqual(await adminAlertsFor(b.code), 1, 'only once');
  });

  it('no alert when the driver confirmed, the pickup is still more than 60 minutes away, the reminder has just gone out, or the ride is not assigned', async () => {
    const d = await driver();
    const confirmed = await assigned(d.id, 50, { wakeupSentMinutesAgo: 40 });
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: `wakeup_ready_${confirmed.id}` });
    const early = await assigned(d.id, 90, { wakeupSentMinutesAgo: 30 });
    const justSent = await assigned(d.id, 40, { wakeupSentMinutesAgo: 5 });
    const cancelled = await assigned(d.id, 50, { wakeupSentMinutesAgo: 40, status: 'CANCELLED' });
    await runUnconfirmedWakeupAlerts();
    for (const b of [confirmed, early, justSent, cancelled]) {
      assert.strictEqual((await row(b.id)).wakeup_alerted_at, null, b.code);
      assert.strictEqual(await adminAlertsFor(b.code), 0, b.code);
    }
  });

  it('an invalid setting falls back to 60 minutes (a missed safety alert is worse)', async () => {
    await updateSetting('driver_wakeup_unconfirmed_alert_minutes', { value: 'soon' });
    try {
      assert.strictEqual(await getWakeupUnconfirmedAlertMinutes(), 60);
    } finally {
      await updateSetting('driver_wakeup_unconfirmed_alert_minutes', originalAlertSetting);
    }
  });

  it('runs in the frequent job', async () => {
    const d = await driver();
    const b = await assigned(d.id, 45, { wakeupSentMinutesAgo: 30 });
    const result = await executeFrequentCronTasks();
    assert.ok(result.unconfirmedWakeupAlerts >= 1);
    assert.ok((await row(b.id)).wakeup_alerted_at);
  });
});
