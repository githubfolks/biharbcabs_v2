/**
 * WhatsApp notifications: free-form inside the 24-hour window, approved templates outside it,
 * template button taps mapped back to bookings, and drivers alerted on every dispatch path.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 16):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/wa-notify.integration.ts
 *
 * WhatsApp sends are simulated (logged to crm_whatsapp_logs) when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { isServiceWindowOpen, notify, resolveTemplateButton, templateParam } from '../lib/wa-notify';
import { TEMPLATE_DEFS } from '../lib/wa-templates';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';
import { sendWhatsAppText } from '../lib/whatsapp';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';
import { POST as webhookPOST } from '../app/api/whatsapp/webhook/route';
import * as dispatchRoute from '../app/api/bookings/[id]/dispatch/route';
import * as messagesRoute from '../app/api/whatsapp/messages/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const SECRET = 'test-meta-secret-wa-notify';
const RUN = String(Date.now()).slice(-5);
let seq = 0;
const phone = (prefix: string) => `91${prefix}${RUN}${String(seq++).padStart(3, '0')}`;
let token = '';
let originalTemplates: any;
const adminIds: number[] = [];

const outbound = async (to: string) =>
  (await query(`SELECT message_type, payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id`, [to])).rows;
const lastOutbound = async (to: string) => (await outbound(to)).pop();
const openWindow = (p: string, hoursAgo = 0) =>
  query(`INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status, created_at)
         VALUES ('INBOUND', $1, 'text', '{}'::jsonb, 'RECEIVED', CURRENT_TIMESTAMP - make_interval(hours => $2))`, [p, hoursAgo]);

async function driver() {
  const p = phone('55');
  const d = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, wallet_balance)
     VALUES ($1, $1, 'Template Driver', 'Patna', 'APPROVED_ACTIVE', true, 4.9, 0) RETURNING id`, [p]);
  await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`,
    [d.rows[0].id, `BR01WA${RUN}${seq++}`]);
  return { id: Number(d.rows[0].id), phone: p };
}
/** Only this driver is offered rides in a city unique to the test, so other test data cannot interfere. */
async function booking(city: string, status = 'CONFIRMED_AWAITING_DRIVER') {
  const cust = phone('44');
  const c = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Template Customer') RETURNING id`, [cust]);
  const s = await calculateRideSplitWithTaxes(2500);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, gst_amount, tech_fee_amount, ride_gst_amount,
       advance_paid, payment_mode, advance_status, balance_cash_due_from_customer, booking_status)
     VALUES ($1, $2, 'oneway', $3, 'Gaya', 'Station Road', CURRENT_DATE + 1, '09:30', 'sedan', 2500, $4, $5, $6, $7, $8, 0, 'FULL_CASH', 'NOT_REQUIRED', 2500, $9) RETURNING id`,
    [`BC-W${RUN}${seq++}`, c.rows[0].id, city, s.driverGrossEarnings, s.totalCompanyDuesZ, s.gstAmount, s.techFeeAmount, s.rideGstAmount, status]
  );
  return { id: Number(b.rows[0].id), cust };
}
const cityFor = async (driverId: number) => {
  const city = `WaCity${RUN}${seq++}`;
  await query(`UPDATE crm_drivers SET base_city = $1 WHERE id = $2`, [city, driverId]);
  return city;
};
const routeCall = (handler: any, body: any, ctx?: any) =>
  handler(new NextRequest('http://localhost:3001/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` }, body: JSON.stringify(body),
  }), ctx);

before(async () => {
  originalTemplates = (await getAllSettings(true)).whatsapp_templates;
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  const a = await query(`INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'WA Tester', 'SUPER_ADMIN', true) RETURNING id`,
    [`wa-${RUN}@example.test`, hash, salt]);
  adminIds.push(Number(a.rows[0].id));
  token = (await createAdminSession(adminIds[0])).token;
});
after(async () => {
  await updateSetting('whatsapp_templates', originalTemplates);
  delete process.env.META_APP_SECRET;
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_drivers SET is_available = false WHERE full_name = 'Template Driver'`);
  await getDbPool().end();
});

describe('24-hour service window', () => {
  it('is open only if the number messaged us within 24 hours', async () => {
    const p = phone('33');
    assert.strictEqual(await isServiceWindowOpen(p), false);
    await openWindow(p, 25);
    assert.strictEqual(await isServiceWindowOpen(p), false, 'a message 25 hours ago does not count');
    await openWindow(p, 1);
    assert.strictEqual(await isServiceWindowOpen(p), true);
  });

  it('inside the window the rich message goes; outside it the approved template', async () => {
    const inside = phone('33');
    const outside = phone('33');
    await openWindow(inside);
    const opts = { params: ['#BC-1', 'Patna to Gaya', 'Tomorrow 09:30', 'SEDAN', '₹2,250', '₹2,280.65'], ref: 1 };
    const a = await notify(inside, 'driver_ride_alert', { ...opts, freeform: () => sendWhatsAppText(inside, 'rich') });
    const b = await notify(outside, 'driver_ride_alert', { ...opts, freeform: () => sendWhatsAppText(outside, 'rich') });
    assert.strictEqual(a.channel, 'FREEFORM');
    assert.strictEqual((await lastOutbound(inside)).message_type, 'text');
    assert.strictEqual(b.channel, 'TEMPLATE');
    const sent = await lastOutbound(outside);
    assert.strictEqual(sent.message_type, 'template');
    assert.strictEqual(sent.payload.template.name, 'bc_driver_ride_alert');
    assert.deepStrictEqual(sent.payload.template.components[0].parameters.map((p: any) => p.text), opts.params);
  });

  it('template parameters are single-line and never empty; wrong param counts are a programming error', async () => {
    assert.strictEqual(templateParam('a\nb\tc'), 'a · b · c');
    assert.strictEqual(templateParam(''), '-');
    assert.strictEqual(templateParam('x      y'), 'x   y');
    await assert.rejects(() => notify(phone('33'), 'customer_trip_started', { params: [] }), /expected 1 params/);
  });

  it('without an approved template name nothing is sent and the failure is reported', async () => {
    await updateSetting('whatsapp_templates', { ...originalTemplates, customer_trip_started: '' });
    const p = phone('33');
    const r = await notify(p, 'customer_trip_started', { params: ['#BC-2'] });
    assert.strictEqual(r.success, false);
    assert.strictEqual(await lastOutbound(p), undefined);
    await updateSetting('whatsapp_templates', originalTemplates);
  });
});

describe('template button taps', () => {
  it('a tap on Accept in a ride-alert template assigns the ride, via the signed webhook', async () => {
    process.env.META_APP_SECRET = SECRET;
    const d = await driver();
    const city = await cityFor(d.id);
    const b = await booking(city);
    await routeCall(dispatchRoute.POST, { action: 'broadcast' }, { params: { id: String(b.id) } });
    const send = (await query(`SELECT wamid FROM crm_wa_template_sends WHERE phone = $1 AND template_key = 'driver_ride_alert' AND ref_id = $2`, [d.phone, b.id])).rows[0];
    assert.ok(send, 'the template send was recorded for mapping taps');

    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Driver' } }], messages: [{
      id: `wamid.tap.${RUN}.${seq++}`, from: d.phone, type: 'button', context: { id: send.wamid }, button: { payload: 'Accept', text: 'Accept' },
    }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    const res = await webhookPOST(new NextRequest('http://localhost:3001/api/whatsapp/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } }));
    assert.strictEqual(res.status, 200);
    const row = (await query(`SELECT booking_status, assigned_driver_id FROM crm_bookings WHERE id = $1`, [b.id])).rows[0];
    assert.strictEqual(row.booking_status, 'DRIVER_ASSIGNED');
    assert.strictEqual(Number(row.assigned_driver_id), d.id);
  });

  it('taps resolve only for the number the template went to, and only for its own labels', async () => {
    const d = await driver();
    const city = await cityFor(d.id);
    const b = await booking(city);
    await routeCall(dispatchRoute.POST, { action: 'broadcast' }, { params: { id: String(b.id) } });
    const { wamid } = (await query(`SELECT wamid FROM crm_wa_template_sends WHERE phone = $1 AND ref_id = $2`, [d.phone, b.id])).rows[0];
    assert.strictEqual(await resolveTemplateButton(wamid, 'Decline', d.phone), `decline_ride_${b.id}`);
    assert.strictEqual(await resolveTemplateButton(wamid, ' accept ', d.phone), `accept_ride_${b.id}`, 'label match ignores case and spaces');
    assert.strictEqual(await resolveTemplateButton(wamid, 'Accept', phone('99')), undefined, 'another number cannot use it');
    assert.strictEqual(await resolveTemplateButton(wamid, 'Start Trip', d.phone), undefined, 'not a button of this template');
    assert.strictEqual(await resolveTemplateButton('wamid.unknown', 'Accept', d.phone), undefined);
  });
});

describe('drivers are alerted on every dispatch path', () => {
  it('manual Broadcast alerts the offered drivers', async () => {
    const d = await driver();
    const city = await cityFor(d.id);
    const b = await booking(city);
    const res = await routeCall(dispatchRoute.POST, { action: 'broadcast' }, { params: { id: String(b.id) } });
    const json = await res.json();
    assert.strictEqual(json.driversAlerted, 1);
    assert.strictEqual((await lastOutbound(d.phone)).payload.template.name, 'bc_driver_ride_alert');
  });

  it('when no offered driver can be reached, admins are alerted at once', async () => {
    const d = await driver();
    const city = await cityFor(d.id);
    const b = await booking(city);
    await updateSetting('whatsapp_templates', { ...originalTemplates, driver_ride_alert: '' });
    try {
      const admins = (await getAllSettings(true)).admin_escalation_contacts || [];
      assert.ok(admins.length > 0, 'test database has an admin contact');
      const before = (await outbound(admins[0].phone)).length;
      const res = await routeCall(dispatchRoute.POST, { action: 'broadcast' }, { params: { id: String(b.id) } });
      assert.strictEqual((await res.json()).driversAlerted, 0);
      const adminMsgs = await outbound(admins[0].phone);
      assert.ok(adminMsgs.length > before);
      assert.ok(JSON.stringify(adminMsgs.pop().payload).includes('no WhatsApp alert was delivered'));
    } finally {
      await updateSetting('whatsapp_templates', originalTemplates);
    }
  });

  it('force-assign tells the driver (with Start Trip) and the customer (with the OTP), and the OTP starts the trip', async () => {
    const d = await driver();
    const b = await booking('Patna');
    const res = await routeCall(dispatchRoute.POST, { action: 'force_assign', driver_id: d.id }, { params: { id: String(b.id) } });
    assert.strictEqual(res.status, 200);

    const toDriver = await lastOutbound(d.phone);
    assert.strictEqual(toDriver.payload.template.name, 'bc_driver_trip_assigned');
    const tap = await resolveTemplateButton(
      (await query(`SELECT wamid FROM crm_wa_template_sends WHERE phone = $1 AND ref_id = $2 AND template_key = 'driver_trip_assigned'`, [d.phone, b.id])).rows[0].wamid,
      'Start Trip', d.phone);
    assert.strictEqual(tap, `start_trip_${b.id}`);

    const toCustomer = await lastOutbound(b.cust);
    assert.strictEqual(toCustomer.payload.template.name, 'bc_customer_driver_assigned');
    const otp = toCustomer.payload.template.components[0].parameters[7].text;
    assert.match(otp, /^\d{4,8}$/, 'the OTP is in the customer template');
    const hash = (await query(`SELECT start_otp_hash FROM crm_bookings WHERE id = $1`, [b.id])).rows[0].start_otp_hash;
    assert.ok(hash && !hash.includes(otp));
    assert.ok(!JSON.stringify(toDriver.payload).includes(otp), 'the driver never sees the OTP');

    // The driver taps Start Trip (from the template) and enters the customer's code.
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, buttonId: tap });
    await processIncomingWhatsAppMessage({ fromPhone: d.phone, text: otp });
    assert.strictEqual((await query(`SELECT booking_status FROM crm_bookings WHERE id = $1`, [b.id])).rows[0].booking_status, 'TRIP_IN_PROGRESS');
  });
});

describe('staff inbox', () => {
  it('refuses a typed message outside the window instead of failing silently', async () => {
    const p = phone('22');
    const closed = await routeCall(messagesRoute.POST, { phone: p, text: 'Hello' });
    assert.strictEqual(closed.status, 409);
    assert.strictEqual(await lastOutbound(p), undefined);
    await openWindow(p);
    const open = await routeCall(messagesRoute.POST, { phone: p, text: 'Hello' });
    assert.strictEqual((await open.json()).success, true);
  });
});

describe('template submission document', () => {
  it('lists every template body exactly as the code sends it', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'crm-design', 'whatsapp_templates.md'), 'utf8');
    for (const [key, def] of Object.entries(TEMPLATE_DEFS)) {
      assert.ok(doc.includes(def.body), `${key} body missing or changed in whatsapp_templates.md`);
      for (const b of (def as any).buttons || []) assert.ok(doc.includes(`\`${b.label}\``), `${key} button ${b.label}`);
    }
  });
});
