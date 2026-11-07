/**
 * End-to-end return-trip test against a disposable database.
 *
 *   createdb biharcabs_crm_test   (schema copied from the CRM database, plus crm_settings)
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/return-trips.integration.ts
 *
 * Refuses to run against any database whose name does not end in _test. Needs the WordPress quote
 * endpoint reachable with a rate card listing Patna to Darbhanga. WhatsApp sends are simulated when
 * no Meta token is configured, and are read back from crm_whatsapp_logs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { query, getDbPool } from '../lib/db';
import { invalidateSettingsCache, updateSetting } from '../lib/settings';
import { processIncomingWhatsAppMessage, getConversation, resetConversation } from '../lib/whatsapp-bot';
import { acceptRideOffer } from '../lib/dispatch-engine';
import { runReturnTripTasks } from '../lib/cron-service';
import { completeTripAndSettle } from '../lib/billing';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RETURNING = '910000000101'; // Darbhanga driver, finished a trip in Patna
const REGULAR = '910000000102';   // Patna driver
const CUSTOMER = '910000000201';
const POLICY = { enabled: true, discount_type: 'PERCENT', discount_value: 10, exclusive_window_minutes: 10, return_status_hours: 6 };
let returningId = 0, regularId = 0, customerId = 0;

async function setPolicy(value: any) {
  await updateSetting('return_trip_policy', value);
  invalidateSettingsCache();
}
async function lastBooking() {
  return (await query(`SELECT * FROM crm_bookings WHERE customer_id = $1 ORDER BY id DESC LIMIT 1`, [customerId])).rows[0];
}
/** Highest log id so far; messages are then read by id, which is exact, unlike timestamps. */
async function logMark(): Promise<number> {
  return Number((await query(`SELECT COALESCE(MAX(id), 0) AS id FROM crm_whatsapp_logs`)).rows[0].id);
}
async function messagesTo(phone: string, afterId: number) {
  const r = await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 AND id > $2 ORDER BY id`, [phone, afterId]);
  return r.rows.map((x) => JSON.stringify(x.payload));
}
async function book(text: string) {
  await resetConversation(CUSTOMER);
  for (const step of [{ text: 'hi' }, { buttonId: 'tt_oneway' }, { text: 'Patna' }, { text: 'Darbhanga' }, { text }]) {
    await processIncomingWhatsAppMessage({ fromPhone: CUSTOMER, customerName: 'Test Customer', ...step });
  }
  return getConversation(CUSTOMER);
}
async function finishBooking() {
  await processIncomingWhatsAppMessage({ fromPhone: CUSTOMER, buttonId: 'sel_veh_sedan' });
  await processIncomingWhatsAppMessage({ fromPhone: CUSTOMER, text: 'Gandhi Maidan, Patna' });
  return lastBooking();
}

before(async () => {
  await query(`UPDATE crm_settings SET setting_value = jsonb_set(setting_value, '{base_url}', '"http://localhost:8081"') WHERE setting_key = 'biharcabs_wp_api'`);
  const driver = async (phone: string, name: string, city: string) => {
    const d = await query(
      `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, wallet_balance)
       VALUES ($1, $1, $2, $3, 'APPROVED_ACTIVE', true, 4.9, 0) RETURNING id`,
      [phone, name, city]
    );
    await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [d.rows[0].id, `BR01TEST${phone.slice(-3)}`]);
    return Number(d.rows[0].id);
  };
  returningId = await driver(RETURNING, 'Returning Driver', 'Darbhanga');
  regularId = await driver(REGULAR, 'Regular Driver', 'Patna');
  customerId = Number((await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Test Customer') RETURNING id`, [CUSTOMER])).rows[0].id);
  await setPolicy(POLICY);
});

after(async () => {
  await getDbPool().end();
});

describe('return trips, end to end', () => {
  it('driver can mark returning only for their own completed trip away from home', async () => {
    const trip = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code, booking_status)
       VALUES ('BC-T001', $1, $2, 'oneway', 'Darbhanga', 'Patna', 'Darbhanga station', CURRENT_DATE, '08:00', 'sedan', 'COMPLETED_SETTLED') RETURNING id`,
      [customerId, returningId]
    );
    const tripId = trip.rows[0].id;

    await processIncomingWhatsAppMessage({ fromPhone: REGULAR, buttonId: `return_back_${tripId}` });
    assert.strictEqual((await query(`SELECT count(*)::int n FROM crm_driver_returns`)).rows[0].n, 0, 'another driver cannot use this trip');

    await processIncomingWhatsAppMessage({ fromPhone: RETURNING, buttonId: `return_back_${tripId}` });
    const r = (await query(`SELECT * FROM crm_driver_returns WHERE driver_id = $1 AND ended_at IS NULL`, [returningId])).rows[0];
    assert.ok(r, 'return started');
    assert.strictEqual(r.from_city, 'Patna');
    assert.strictEqual(r.to_city, 'Darbhanga');
    const hours = (new Date(r.expires_at).getTime() - new Date(r.started_at).getTime()) / 3600000;
    assert.ok(Math.abs(hours - 6) < 0.01, `lasts the configured 6 hours, got ${hours}`);
  });

  it('customer sees the discount, booking records the split, and only the returning driver is offered it', async () => {
    const since = await logMark();
    const conv = await book('now');
    assert.strictEqual(conv.state, 'AWAITING_VEHICLE_CHOICE', 'got live fares');
    const offer = conv.context_data.return_offers?.sedan;
    assert.ok(offer, 'sedan has a return-trip offer');
    assert.strictEqual(offer.original_fare, 1800); // 150 km x 12
    assert.strictEqual(offer.discount, 180);
    assert.strictEqual(offer.fare, 1620);
    assert.ok(!conv.context_data.return_offers?.ertiga, 'no returning Ertiga driver, so no Ertiga discount');
    const list = (await messagesTo(CUSTOMER, since)).join(' ');
    assert.match(list, /Sedan \(₹1,620\)/);
    assert.match(list, /Return-trip offer: ₹180 off/);
    assert.match(list, /Toll and parking extra/, 'toll note comes from the rate card');

    const b = await finishBooking();
    assert.strictEqual(Number(b.fare_before_discount), 1800);
    assert.strictEqual(Number(b.customer_total_fare), 1620);
    assert.strictEqual(Number(b.return_discount_amount), 180);
    assert.strictEqual(Number(b.return_discount_company_share), 54, 'company pays up to its 3% commission');
    assert.ok(Number(b.return_discount_driver_share) > 0);
    assert.strictEqual(Math.round((Number(b.driver_payout_amount) + Number(b.commission_amount)) * 100) / 100, 1620, 'payout and company dues add up to the fare');
    assert.strictEqual(Number(b.distance_km), 150, 'real distance, not a placeholder');
    assert.ok(b.return_exclusive_until, 'exclusive window set');

    const offers = (await query(`SELECT driver_id, is_return_priority, offered_driver_fare FROM crm_dispatch_offers WHERE booking_id = $1`, [b.id])).rows;
    assert.deepStrictEqual(offers.map((o) => Number(o.driver_id)), [returningId], 'only the returning driver is offered it first');
    assert.strictEqual(offers[0].is_return_priority, true);

    const alert = (await messagesTo(RETURNING, since)).join(' ');
    assert.match(alert, /Return trip home: this ride is yours alone for (9|10) min/);
    assert.doesNotMatch(alert, /09:00 AM/, 'alert shows the real pickup time');
    assert.strictEqual((await messagesTo(REGULAR, since)).length, 0, 'regular driver not alerted during the window');
  });

  it('returning driver accepts: discount split stands and their return ends', async () => {
    const b = await lastBooking();
    const payoutBefore = Number(b.driver_payout_amount);
    const res = await acceptRideOffer(Number(b.id), returningId);
    assert.strictEqual(res.status, 'ASSIGNED');
    const after = await lastBooking();
    assert.strictEqual(after.return_discount_funded_by, 'RETURN_DRIVER');
    assert.strictEqual(Number(after.driver_payout_amount), payoutBefore);
    const active = (await query(`SELECT end_reason FROM crm_driver_returns WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`, [returningId])).rows[0];
    assert.strictEqual(active.end_reason, 'ACCEPTED_RETURN_RIDE');

    const settled = await completeTripAndSettle({ bookingId: Number(b.id), cashCollectedByDriver: Number(after.balance_cash_due_from_customer), tollParking: 0 });
    assert.strictEqual(settled.totalCustomerPayable, 1620, 'customer pays the discounted fare');
  });

  it('nobody returning accepts in time: regular driver gets it and the company absorbs the discount', async () => {
    const trip = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code, booking_status)
       VALUES ('BC-T002', $1, $2, 'oneway', 'Darbhanga', 'Patna', 'Darbhanga station', CURRENT_DATE, '08:00', 'sedan', 'COMPLETED_SETTLED') RETURNING id`,
      [customerId, returningId]
    );
    await processIncomingWhatsAppMessage({ fromPhone: RETURNING, buttonId: `return_back_${trip.rows[0].id}` });

    await book('now');
    const b = await finishBooking();
    assert.ok(Number(b.return_discount_amount) > 0);
    const fullDriverPayout = Number(b.driver_payout_amount) + Number(b.return_discount_driver_share);

    // Window passes with no acceptance
    await query(`UPDATE crm_bookings SET return_exclusive_until = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1`, [b.id]);
    const since = await logMark();
    const cron = await runReturnTripTasks();
    assert.ok(cron.released >= 1, 'window released by the scheduled job');

    const offers = (await query(`SELECT driver_id, is_return_priority, offered_driver_fare FROM crm_dispatch_offers WHERE booking_id = $1 ORDER BY id`, [b.id])).rows;
    const regular = offers.find((o) => Number(o.driver_id) === regularId);
    assert.ok(regular, 'regular driver now offered');
    assert.strictEqual(regular.is_return_priority, false);
    assert.strictEqual(Number(regular.offered_driver_fare), fullDriverPayout, 'regular driver is offered the undiscounted payout');
    assert.strictEqual(offers.filter((o) => Number(o.driver_id) === returningId).length, 1, 'returning driver not offered twice');
    assert.ok((await messagesTo(REGULAR, since)).some((m) => m.includes('New Ride Alert')), 'regular driver alerted');

    const res = await acceptRideOffer(Number(b.id), regularId);
    assert.strictEqual(res.status, 'ASSIGNED');
    const after = await lastBooking();
    assert.strictEqual(after.return_discount_funded_by, 'COMPANY');
    assert.strictEqual(Number(after.driver_payout_amount), fullDriverPayout);
    assert.strictEqual(Number(after.return_discount_company_share), Number(after.return_discount_amount));
    assert.strictEqual(Number(after.return_discount_driver_share), 0);
    assert.strictEqual(Number(after.customer_total_fare), Number(b.customer_total_fare), 'customer keeps the promised price');
    assert.strictEqual(Math.round((Number(after.driver_payout_amount) + Number(after.commission_amount)) * 100) / 100, Number(after.customer_total_fare));
    const stillReturning = (await query(`SELECT count(*)::int n FROM crm_driver_returns WHERE driver_id = $1 AND ended_at IS NULL`, [returningId])).rows[0].n;
    assert.strictEqual(stillReturning, 1, "returning driver's status is untouched when someone else takes the ride");
  });

  it('reached home ends priority, after which no discount is shown', async () => {
    await processIncomingWhatsAppMessage({ fromPhone: RETURNING, buttonId: 'reached_home' });
    const r = (await query(`SELECT end_reason FROM crm_driver_returns WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`, [returningId])).rows[0];
    assert.strictEqual(r.end_reason, 'REACHED_HOME');
    const conv = await book('now');
    assert.deepStrictEqual(conv.context_data.return_offers, {}, 'no returning driver, no discount');
  });

  it('a pickup after the return status ends gets no discount', async () => {
    const trip = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code, booking_status)
       VALUES ('BC-T003', $1, $2, 'oneway', 'Darbhanga', 'Patna', 'Darbhanga station', CURRENT_DATE, '08:00', 'sedan', 'COMPLETED_SETTLED') RETURNING id`,
      [customerId, returningId]
    );
    await processIncomingWhatsAppMessage({ fromPhone: RETURNING, buttonId: `return_back_${trip.rows[0].id}` });
    const conv = await book('tomorrow 11 pm');
    assert.deepStrictEqual(conv.context_data.return_offers, {}, 'driver will be gone by then');
  });

  it('with the feature switched off: no discount and no return button', async () => {
    await setPolicy({ ...POLICY, enabled: false });
    const conv = await book('now');
    assert.deepStrictEqual(conv.context_data.return_offers, {});
    const since = await logMark();
    const trip = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code, booking_status)
       VALUES ('BC-T004', $1, $2, 'oneway', 'Darbhanga', 'Patna', 'Darbhanga station', CURRENT_DATE, '08:00', 'sedan', 'COMPLETED_SETTLED') RETURNING id`,
      [customerId, returningId]
    );
    await processIncomingWhatsAppMessage({ fromPhone: RETURNING, buttonId: `return_back_${trip.rows[0].id}` });
    assert.ok((await messagesTo(RETURNING, since)).some((m) => m.includes('not available')), 'driver told it is unavailable');
    await setPolicy(POLICY);
  });
});
