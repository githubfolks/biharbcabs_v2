/**
 * Trip start OTP and cash settlement, driven through the WhatsApp bot as drivers and customers use it.
 * Runs against a disposable database whose name ends in _test (migrations 08 to 14):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/trip-otp.integration.ts
 *
 * WhatsApp sends are simulated (logged to crm_whatsapp_logs) when no Meta token is configured.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { processIncomingWhatsAppMessage } from '../lib/whatsapp-bot';
import { getTripOtpPolicy } from '../lib/trip-otp';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = String(Date.now()).slice(-5);
let seq = 0;
const phone = (prefix: string) => `91${prefix}${RUN}${String(seq++).padStart(3, '0')}`;
let maxAttempts = 5;

const send = (fromPhone: string, msg: { text?: string; buttonId?: string }) =>
  processIncomingWhatsAppMessage({ fromPhone, customerName: 'OTP Tester', ...msg });
const lastTextTo = async (to: string) => {
  const r = await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`, [to]);
  return JSON.stringify(r.rows[0]?.payload || '');
};
/** The OTP as the customer received it on WhatsApp. */
const otpSentTo = async (customer: string) => {
  const r = await query(
    `SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 AND payload::text LIKE '%Trip OTP for booking%' ORDER BY id DESC LIMIT 1`,
    [customer]
  );
  const m = JSON.stringify(r.rows[0]?.payload || '').match(/Trip OTP for booking #[\w-]+: \*(\d+)\*/);
  return m ? m[1] : null;
};
const booking = async (id: number) => (await query(`SELECT * FROM crm_bookings WHERE id = $1`, [id])).rows[0];
const conversationState = async (p: string) => (await query(`SELECT state FROM crm_whatsapp_conversations WHERE phone = $1`, [p])).rows[0]?.state;

async function driver() {
  const p = phone('66');
  const d = await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, is_available, rating, wallet_balance, security_reserve_balance, total_trips_completed)
     VALUES ($1, $1, 'OTP Driver', 'Patna', 'APPROVED_ACTIVE', true, 4.9, 0, 0, 1) RETURNING id`,
    [p]
  );
  await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [d.rows[0].id, `BR01OTP${RUN}${seq++}`]);
  return { id: Number(d.rows[0].id), phone: p };
}

/** A booking offered to the driver, with the given confirmed advance. */
async function offeredBooking(driverId: number, advancePaid: number, fare = 2500) {
  const cust = phone('77');
  const c = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'OTP Customer') RETURNING id`, [cust]);
  const split = await calculateRideSplitWithTaxes(fare);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, gst_amount, tech_fee_amount,
       advance_paid, advance_status, payment_mode, balance_cash_due_from_customer, booking_status)
     VALUES ($1, $2, 'oneway', 'Patna', 'Gaya', 'Patna Jn', CURRENT_DATE + 1, '10:00', 'sedan', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'AWAITING_DRIVER') RETURNING id`,
    [`BC-O${RUN}${seq++}`, c.rows[0].id, fare, split.driverGrossEarnings, split.totalCompanyDuesZ, split.gstAmount, split.techFeeAmount,
     advancePaid, advancePaid > 0 ? 'PAID' : 'NOT_REQUIRED', advancePaid > 0 ? 'ADVANCE_ONLINE' : 'FULL_CASH', fare - advancePaid]
  );
  const id = Number(b.rows[0].id);
  await query(`INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, $3, 'PENDING')`, [id, driverId, split.driverGrossEarnings]);
  return { id, cust, share: split.totalCompanyDuesZ };
}

/** Driver accepts through the bot and taps Start Trip; returns the customer's OTP. */
async function acceptAndAskToStart(d: { phone: string }, b: { id: number; cust: string }) {
  await send(d.phone, { buttonId: `accept_ride_${b.id}` });
  const otp = await otpSentTo(b.cust);
  assert.ok(otp, 'customer received an OTP when the driver was assigned');
  await send(d.phone, { buttonId: `start_trip_${b.id}` });
  return otp!;
}

before(async () => {
  maxAttempts = (await getTripOtpPolicy()).max_failed_attempts;
});
after(async () => {
  await getDbPool().end();
});

describe('trip start OTP', () => {
  it('is sent to the customer on assignment; only its hash is stored; the trip waits for it', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 250);
    const otp = await acceptAndAskToStart(d, b);
    assert.match(otp, /^\d{4,8}$/);

    const row = await booking(b.id);
    assert.strictEqual(row.booking_status, 'DRIVER_ASSIGNED', 'tapping Start Trip alone does not start it');
    assert.ok(row.start_otp_hash && !row.start_otp_hash.includes(otp));
    assert.ok(!JSON.stringify(row).includes(`"${otp}"`), 'the code itself is not stored');
    assert.strictEqual(await conversationState(d.phone), 'AWAITING_START_OTP');
    assert.ok((await lastTextTo(d.phone)).includes('ask the customer for their trip OTP'));
  });

  it('a wrong code is refused with attempts left; the right code starts the trip and tells the customer', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 250);
    const otp = await acceptAndAskToStart(d, b);
    const wrong = otp === '0000' ? '1111' : '0000';

    await send(d.phone, { text: wrong });
    assert.strictEqual((await booking(b.id)).booking_status, 'DRIVER_ASSIGNED');
    assert.ok((await lastTextTo(d.phone)).includes(`${maxAttempts - 1} attempts left`));

    await send(d.phone, { text: otp });
    const row = await booking(b.id);
    assert.strictEqual(row.booking_status, 'TRIP_IN_PROGRESS');
    assert.ok(row.trip_started_at);
    assert.strictEqual(row.start_otp_hash, null, 'a code works once');
    assert.ok((await lastTextTo(b.cust)).includes('has started'));
    assert.notStrictEqual(await conversationState(d.phone), 'AWAITING_START_OTP');
  });

  it('locks after too many wrong codes; the customer gets a new code that works, the old one does not', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 0);
    const oldOtp = await acceptAndAskToStart(d, b);
    const wrong = oldOtp === '0000' ? '1111' : '0000';
    for (let i = 0; i < maxAttempts; i++) await send(d.phone, { text: wrong });

    await send(d.phone, { text: oldOtp });
    assert.strictEqual((await booking(b.id)).booking_status, 'DRIVER_ASSIGNED', 'even the right code is refused once locked');
    assert.ok((await lastTextTo(d.phone)).includes('Too many wrong OTPs'));

    await send(b.cust, { text: 'OTP' });
    const newOtp = await otpSentTo(b.cust);
    assert.ok(newOtp);
    assert.strictEqual((await booking(b.id)).start_otp_failed_attempts, 0, 'new code resets the count');
    if (newOtp !== oldOtp) {
      await send(d.phone, { text: oldOtp });
      assert.strictEqual((await booking(b.id)).booking_status, 'DRIVER_ASSIGNED', 'the old code no longer works');
    }
    await send(d.phone, { text: newOtp! });
    assert.strictEqual((await booking(b.id)).booking_status, 'TRIP_IN_PROGRESS');
  });

  it('parallel guesses cannot exceed the limit', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 0);
    const otp = await acceptAndAskToStart(d, b);
    const guesses = Array.from({ length: 12 }, (_, i) => String((Number(otp) + 1 + i) % 10 ** otp.length).padStart(otp.length, '0'));
    await Promise.all(guesses.map((g) => send(d.phone, { text: g })));
    const row = await booking(b.id);
    assert.strictEqual(row.booking_status, 'DRIVER_ASSIGNED');
    assert.strictEqual(row.start_otp_failed_attempts, maxAttempts);
  });

  it('another driver cannot start the trip, even with the right code', async () => {
    const d = await driver();
    const other = await driver();
    const b = await offeredBooking(d.id, 0);
    const otp = await acceptAndAskToStart(d, b);
    await send(other.phone, { buttonId: `start_trip_${b.id}` });
    assert.ok((await lastTextTo(other.phone)).includes('cannot be started from your number'));
    await send(other.phone, { text: otp });
    assert.strictEqual((await booking(b.id)).booking_status, 'DRIVER_ASSIGNED');
  });

  it('a trip assigned before OTPs existed gets a code when the driver taps Start Trip', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 0);
    await send(d.phone, { buttonId: `accept_ride_${b.id}` });
    await query(`UPDATE crm_bookings SET start_otp_hash = NULL WHERE id = $1`, [b.id]);
    await query(`DELETE FROM crm_whatsapp_logs WHERE phone = $1`, [b.cust]);
    await send(d.phone, { buttonId: `start_trip_${b.id}` });
    const otp = await otpSentTo(b.cust);
    assert.ok(otp, 'customer was sent a code');
    await send(d.phone, { text: otp! });
    assert.strictEqual((await booking(b.id)).booking_status, 'TRIP_IN_PROGRESS');
  });

  it('"OTP" from someone with no assigned trip does nothing special', async () => {
    const stranger = phone('88');
    await send(stranger, { text: 'otp' });
    assert.ok(!(await lastTextTo(stranger)).includes('Trip OTP'));
  });
});

describe('cash settlement at trip completion (bot)', () => {
  async function completedTrip(advance: number) {
    const d = await driver();
    const b = await offeredBooking(d.id, advance);
    const otp = await acceptAndAskToStart(d, b);
    await send(d.phone, { text: otp });
    await send(d.phone, { buttonId: `complete_trip_${b.id}` });
    const ledger = (await query(`SELECT transaction_type, amount FROM crm_payments_ledger WHERE booking_id = $1`, [b.id])).rows;
    const drv = (await query(`SELECT wallet_balance, security_reserve_balance FROM crm_drivers WHERE id = $1`, [d.id])).rows[0];
    return { d, b, row: await booking(b.id), ledger, drv };
  }

  it('advance-paid ride: the driver collected fare minus advance, and is owed advance minus BiharCabs share', async () => {
    const { b, row, ledger, drv } = await completedTrip(250);
    assert.strictEqual(row.booking_status, 'COMPLETED_SETTLED');
    assert.strictEqual(Number(row.cash_collected_by_driver), 2250, 'cash = fare 2500 - advance 250');
    const cash = ledger.find((l) => l.transaction_type === 'CUSTOMER_SETTLEMENT');
    assert.strictEqual(Number(cash.amount), 2250);

    // Wallet + reserve together hold what BiharCabs owes the driver for this ride: advance - share.
    const owed = parseFloat((250 - b.share).toFixed(2));
    assert.ok(owed > 0);
    assert.strictEqual(parseFloat((Number(drv.wallet_balance) + Number(drv.security_reserve_balance)).toFixed(2)), owed);
    assert.ok(!ledger.some((l) => l.transaction_type === 'DRIVER_COMMISSION_DEDUCTION'), 'not charged as if they owed commission');
  });

  it('full-cash ride: the driver collected the full fare and owes BiharCabs its share', async () => {
    const { b, row, drv } = await completedTrip(0);
    assert.strictEqual(Number(row.cash_collected_by_driver), 2500);
    assert.strictEqual(Number(drv.wallet_balance), -b.share);
  });

  it('a trip cannot be completed unless it was started with the OTP', async () => {
    const d = await driver();
    const b = await offeredBooking(d.id, 250);
    await send(d.phone, { buttonId: `accept_ride_${b.id}` });
    await send(d.phone, { buttonId: `complete_trip_${b.id}` });
    assert.strictEqual((await booking(b.id)).booking_status, 'DRIVER_ASSIGNED');
    assert.ok((await lastTextTo(d.phone)).includes('cannot be completed'));
  });
});
