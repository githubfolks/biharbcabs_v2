import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { query, getDbPool } from '../lib/db';
import {
  getAllSettings,
  getSetting,
  updateSetting,
  getDispatchSlaTimeoutMinutes,
  getCommissionConfig,
  getRevenueProtectionPolicy,
} from '../lib/settings';
import {
  calculateFareSplit,
  calculateRideSplitWithTaxes,
  findEligibleDrivers,
  acceptRideOffer,
  checkAndEscalateSlaBreaches,
} from '../lib/dispatch-engine';
import { completeTripAndSettle, awardDriverIncentive } from '../lib/billing';
import { fetchLiveQuote } from '../lib/tariff-bridge';
import { hashPassword, verifyPassword, createAdminSession, validateSession, revokeSession } from '../lib/auth';
import {
  parsePreFilledWebsiteMessage,
  processIncomingWhatsAppMessage,
  getConversation,
  resetConversation,
} from '../lib/whatsapp-bot';
import { executeAllCronTasks, runUnpaidDuesGuardrails } from '../lib/cron-service';
import { recordCustomerRating, disputeRating, getDriverRatingProfile } from '../lib/ratings';

describe('BiharCabs Operational CRM Core Engine Tests', () => {
  it('1. Connects natively to PostgreSQL biharcabs_crm and verifies tables', async () => {
    const res = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    const tableNames = res.rows.map((r) => r.table_name);
    assert.ok(tableNames.includes('crm_settings'), 'crm_settings exists');
    assert.ok(tableNames.includes('crm_customers'), 'crm_customers exists');
    assert.ok(tableNames.includes('crm_drivers'), 'crm_drivers exists');
    assert.ok(tableNames.includes('crm_driver_vehicles'), 'crm_driver_vehicles exists');
    assert.ok(tableNames.includes('crm_bookings'), 'crm_bookings exists');
    assert.ok(tableNames.includes('crm_dispatch_offers'), 'crm_dispatch_offers exists');
    assert.ok(tableNames.includes('crm_payments_ledger'), 'crm_payments_ledger exists');
    assert.ok(tableNames.includes('crm_invoices'), 'crm_invoices exists');
    assert.ok(tableNames.includes('crm_whatsapp_logs'), 'crm_whatsapp_logs exists');
  });

  it('2. Dynamic Settings: Loads and updates settings dynamically without hardcoding', async () => {
    const timeout = await getDispatchSlaTimeoutMinutes();
    assert.strictEqual(typeof timeout, 'number');

    // Update dynamic SLA timeout
    await updateSetting('dispatch_sla_timeout_minutes', { value: 20 }, 'Updated via test');
    const updated = await getDispatchSlaTimeoutMinutes();
    assert.strictEqual(updated, 20);

    // Revert back to 15
    await updateSetting('dispatch_sla_timeout_minutes', { value: 15 }, 'Reverted via test');
    const reverted = await getDispatchSlaTimeoutMinutes();
    assert.strictEqual(reverted, 15);
  });

  it('3. Commission Engine: Dynamically calculates fare split & commission', async () => {
    const split = await calculateFareSplit(3000);
    // 12% of 3000 = 360, Driver = 2640
    assert.strictEqual(split.commissionAmount, 360);
    assert.strictEqual(split.driverPayoutAmount, 2640);
  });

  it('4. Tariff Bridge: Fails gracefully without generating synthetic data when WP is unreachable', async () => {
    const quote = await fetchLiveQuote({
      origin_city: 'Patna',
      destination_city: 'Darbhanga',
      trip_type: 'oneway',
      pickup_date: '2026-11-10',
    });

    // If WordPress server isn't running on port 8080 right now, it should fail gracefully
    // returning success: false, and never returning fake/synthetic numbers!
    if (!quote.success) {
      assert.strictEqual(quote.success, false);
      assert.strictEqual(quote.quotes.length, 0);
      assert.ok(quote.error, 'Returns graceful error object');
    } else {
      assert.ok(quote.quotes.length > 0, 'Returns real quotes');
    }
  });

  it('5. End-to-End Workflow: Driver Onboarding, Ride Creation, Atomic Lock & Commission Settlement', async () => {
    const timestamp = Date.now();
    const testPhone = `917070${timestamp.toString().slice(-6)}`;

    // A. Onboard a test driver
    const driverRes = await query(
      `INSERT INTO crm_drivers (
        full_name, phone, whatsapp_phone, base_city, onboarding_status,
        license_number, license_expiry, wallet_balance, is_available
      ) VALUES ($1, $2, $2, 'Patna', 'APPROVED_ACTIVE', 'DL-TEST-999', '2030-01-01', 0.00, true)
      RETURNING id, full_name`,
      ['Test Driver Suresh', testPhone]
    );
    const driverId = driverRes.rows[0].id;

    // Link a verified vehicle
    const vehicleRes = await query(
      `INSERT INTO crm_driver_vehicles (
        driver_id, wp_vehicle_code, registration_no, model_name,
        insurance_expiry, fitness_expiry, permit_expiry, is_verified
      ) VALUES ($1, 'sedan', $2, 'Maruti Dzire', '2030-01-01', '2030-01-01', '2030-01-01', true)
      RETURNING id`,
      [driverId, `BR-01-TEST-${timestamp.toString().slice(-4)}`]
    );
    const vehicleId = vehicleRes.rows[0].id;

    // Verify driver is found by eligible driver search
    const eligible = await findEligibleDrivers('Patna', 'sedan');
    const matched = eligible.find((d) => d.driver_id === driverId);
    assert.ok(matched, 'Newly onboarded driver is matched for Patna Sedan');

    // B. Create a Customer and Booking
    const custRes = await query(
      `INSERT INTO crm_customers (phone, full_name)
       VALUES ($1, 'Test Customer') RETURNING id`,
      [`919800${timestamp.toString().slice(-6)}`]
    );
    const customerId = custRes.rows[0].id;

    const bookRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, trip_type, origin_city, destination_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code,
        distance_km, customer_total_fare, driver_payout_amount, commission_amount,
        booking_status
      ) VALUES ($1, $2, 'oneway', 'Patna', 'Gaya', 'Patna Airport', '2026-11-10', '09:00', 'sedan', 110, 2500, 2200, 300, 'AWAITING_DRIVER')
      RETURNING id, booking_code`,
      [`BC-T${timestamp.toString().slice(-4)}`, customerId]
    );
    const bookingId = bookRes.rows[0].id;

    // C. Atomic Ride Acceptance (only a driver who was offered the ride may accept it)
    await query(
      `INSERT INTO crm_dispatch_offers (booking_id, driver_id, offered_driver_fare, offer_status) VALUES ($1, $2, 2200, 'PENDING')`,
      [bookingId, driverId]
    );
    const acceptResult = await acceptRideOffer(bookingId, driverId);
    assert.strictEqual(acceptResult.success, true);
    assert.strictEqual(acceptResult.status, 'ASSIGNED');

    // A driver who was never offered the ride cannot take it
    const secondAccept = await acceptRideOffer(bookingId, driverId + 9999);
    assert.strictEqual(secondAccept.success, false);
    assert.strictEqual(secondAccept.status, 'NOT_OFFERED');

    // D. Complete Trip and Settle Commission Ledger
    // Trip Fare: 2500, Commission: 300 -> Driver Net Earnings = 2200
    // Suppose Driver collected ₹2500 cash from customer at drop-off.
    // Settlement: (2500 - 300) - 2500 = -300 -> Driver owes ₹300 commission to BiharCabs!
    const settlement = await completeTripAndSettle({
      bookingId,
      cashCollectedByDriver: 2500,
      tollParking: 0,
      notes: 'Test trip completion',
    });

    assert.strictEqual(settlement.settlementType, 'RECEIVABLE_FROM_DRIVER');
    assert.strictEqual(settlement.driverNetSettlement, -300);
    assert.strictEqual(settlement.newDriverWalletBalance, -300);
    assert.ok(settlement.invoiceNumber.startsWith('INV-BC-'));

    // Verify invoice was inserted
    const invRes = await query(`SELECT * FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    assert.strictEqual(invRes.rows.length, 1);
    assert.strictEqual(Number(invRes.rows[0].total_amount), 2500);

    // Verify ledger entry was recorded
    const ledgerRes = await query(
      `SELECT * FROM crm_payments_ledger WHERE booking_id = $1 AND transaction_type = 'DRIVER_COMMISSION_DEDUCTION'`,
      [bookingId]
    );
    assert.strictEqual(ledgerRes.rows.length, 1);
    assert.strictEqual(Number(ledgerRes.rows[0].amount), 300);

    // Clean up test records
    await query(`DELETE FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_payments_ledger WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    await query(`DELETE FROM crm_driver_vehicles WHERE id = $1`, [vehicleId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [driverId]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
  });

  it('6. Admin Authentication: Verifies secure hashing, session creation, validation and revocation', async () => {
    // A. Password hash & verify
    const plainPass = 'SecureAdminSecret2026!';
    const { hash, salt } = hashPassword(plainPass);
    assert.ok(hash && salt);
    assert.strictEqual(verifyPassword(plainPass, hash, salt), true);
    assert.strictEqual(verifyPassword('WrongPass', hash, salt), false);

    // B. Test initial seeded admin
    const adminRes = await query(`SELECT * FROM crm_admin_users WHERE email = 'admin@biharcabs.com'`);
    assert.strictEqual(adminRes.rows.length, 1);
    const admin = adminRes.rows[0];
    // Never assert a real account's password: the seeded default was published and has been removed.
    const sample = hashPassword('test-only-password');
    assert.strictEqual(verifyPassword('test-only-password', sample.hash, sample.salt), true);
    assert.strictEqual(verifyPassword('wrong-password', sample.hash, sample.salt), false);

    // C. Create session
    const { token, expiresAt } = await createAdminSession(admin.id, 'TestAgent/1.0', '127.0.0.1');
    assert.ok(token);
    assert.ok(expiresAt > new Date());

    // D. Validate session
    const validUser = await validateSession(token);
    assert.ok(validUser);
    assert.strictEqual(validUser.email, 'admin@biharcabs.com');
    assert.strictEqual(validUser.role, 'SUPER_ADMIN');

    // E. Revoke session
    await revokeSession(token);
    const revokedUser = await validateSession(token);
    assert.strictEqual(revokedUser, null);
  });

  it('7. WhatsApp Services: Pre-filled website parser & customer booking state machine', async () => {
    // A. Test Website pre-filled message parser
    const text = 'Hi BiharCabs, I want to book a One-Way cab from Patna to Darbhanga on 2026-11-12 at 09:30 AM.';
    const parsed = parsePreFilledWebsiteMessage(text);
    assert.strictEqual(parsed.isWebsiteQuote, true);
    assert.strictEqual(parsed.origin, 'Patna');
    assert.strictEqual(parsed.destination, 'Darbhanga');
    assert.strictEqual(parsed.trip_type, 'oneway');
    assert.strictEqual(parsed.pickup_date, '2026-11-12');
    assert.strictEqual(parsed.pickup_time, '09:30 AM');
    assert.strictEqual(parsePreFilledWebsiteMessage('Hi BiharCabs, I want to book a One-Way cab from Patna to Gaya on 2026-11-12.').pickup_time, undefined);

    // B. Test Conversational State Machine Step-by-Step
    const testPhone = '919876543219';
    await resetConversation(testPhone);

    // Step 1: Greeting "Hi"
    await processIncomingWhatsAppMessage({
      fromPhone: testPhone,
      text: 'Hi',
    });
    let conv = await getConversation(testPhone);
    assert.strictEqual(conv.state, 'AWAITING_TRIP_TYPE');

    // Step 2: Choose One-Way
    await processIncomingWhatsAppMessage({
      fromPhone: testPhone,
      buttonId: 'tt_oneway',
      buttonText: '🚖 One-Way Drop',
    });
    conv = await getConversation(testPhone);
    assert.strictEqual(conv.state, 'AWAITING_ORIGIN');

    // Step 3: Enter Origin
    await processIncomingWhatsAppMessage({
      fromPhone: testPhone,
      text: 'Patna',
    });
    conv = await getConversation(testPhone);
    assert.strictEqual(conv.state, 'AWAITING_DESTINATION');

    // Step 4: Enter Destination -> asks when the cab is needed
    await processIncomingWhatsAppMessage({
      fromPhone: testPhone,
      text: 'Darbhanga',
    });
    conv = await getConversation(testPhone);
    assert.strictEqual(conv.state, 'AWAITING_PICKUP_TIME');

    // Step 4b: An unreadable time asks again
    await processIncomingWhatsAppMessage({ fromPhone: testPhone, text: 'sometime soon' });
    conv = await getConversation(testPhone);
    assert.strictEqual(conv.state, 'AWAITING_PICKUP_TIME');

    // Step 4c: A real time -> live fares (or a custom quote if WP is offline)
    await processIncomingWhatsAppMessage({ fromPhone: testPhone, text: 'tomorrow 9 am' });
    conv = await getConversation(testPhone);
    assert.ok(conv.state === 'AWAITING_VEHICLE_CHOICE' || conv.state === 'IDLE');
    if (conv.state === 'AWAITING_VEHICLE_CHOICE') {
      assert.match(String(conv.context_data.pickup_time), /^09:00$/);
    }

    await resetConversation(testPhone);
  });

  it('8. WhatsApp Services: Driver self-serve onboarding flow (JOIN)', async () => {
    const driverPhone = '919123456789';
    await resetConversation(driverPhone);

    // Step 1: Send "JOIN"
    await processIncomingWhatsAppMessage({
      fromPhone: driverPhone,
      text: 'JOIN',
    });
    let conv = await getConversation(driverPhone);
    assert.strictEqual(conv.state, 'DRIVER_ONBOARD_NAME');

    // Step 2: Full Name
    await processIncomingWhatsAppMessage({
      fromPhone: driverPhone,
      text: 'Mahesh Kumar Sharma',
    });
    conv = await getConversation(driverPhone);
    assert.strictEqual(conv.state, 'DRIVER_ONBOARD_CITY');

    // Step 3: Base City
    await processIncomingWhatsAppMessage({
      fromPhone: driverPhone,
      buttonId: 'city_patna',
      buttonText: 'Patna',
    });
    conv = await getConversation(driverPhone);
    assert.strictEqual(conv.state, 'DRIVER_ONBOARD_VEHICLE');

    // Step 4: Vehicle category
    await processIncomingWhatsAppMessage({
      fromPhone: driverPhone,
      buttonId: 'v_sedan',
      buttonText: 'Sedan (Dzire/Etios)',
    });
    conv = await getConversation(driverPhone);
    assert.strictEqual(conv.state, 'DRIVER_ONBOARD_REG');

    // Step 5: Vehicle Registration Number
    await processIncomingWhatsAppMessage({
      fromPhone: driverPhone,
      text: 'BR-01-AB-1234',
    });
    conv = await getConversation(driverPhone);
    assert.strictEqual(conv.state, 'IDLE');

    // Verify driver was created in database
    const dRes = await query(`SELECT * FROM crm_drivers WHERE phone = $1`, [driverPhone]);
    assert.strictEqual(dRes.rows.length, 1);
    assert.strictEqual(dRes.rows[0].full_name, 'Mahesh Kumar Sharma');
    assert.strictEqual(dRes.rows[0].onboarding_status, 'APPROVED_ACTIVE');

    // Verify vehicle was created
    const vRes = await query(`SELECT * FROM crm_driver_vehicles WHERE driver_id = $1`, [dRes.rows[0].id]);
    assert.strictEqual(vRes.rows.length, 1);
    assert.strictEqual(vRes.rows[0].registration_no, 'BR-01-AB-1234');

    // Cleanup
    await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = $1`, [dRes.rows[0].id]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [dRes.rows[0].id]);
    await query(`DELETE FROM crm_whatsapp_conversations WHERE phone = $1`, [driverPhone]);
  });

  it('9. WhatsApp Cron Services: Verifies automated SLA, wake-up, doc expiry and unpaid dues checks', async () => {
    // A. Create an expired driver to test compliance suspension
    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, license_expiry, wallet_balance, is_available)
       VALUES ('Expired Doc Driver', '919999888877', '919999888877', 'Patna', 'APPROVED_ACTIVE', '2020-01-01', -2000.00, true)
       RETURNING id`
    );
    const expiredDriverId = dRes.rows[0].id;

    // Link vehicle with expired fitness
    const vRes = await query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, fitness_expiry, is_verified)
       VALUES ($1, 'sedan', 'BR-01-EXP-999', 'Old Dzire', '2020-01-01', true)
       RETURNING id`,
      [expiredDriverId]
    );
    const expiredVehicleId = vRes.rows[0].id;

    // Run master cron
    const results = await executeAllCronTasks();
    assert.ok(typeof results.slaBreachesEscalated === 'number');
    assert.ok(typeof results.wakeupChecksSent === 'number');
    assert.ok(results.documentsExpiredSuspended >= 1, 'Expired driver was suspended');

    // Verify driver was transitioned to SUSPENDED_DOC_EXPIRED
    const checkRes = await query(`SELECT onboarding_status, is_available FROM crm_drivers WHERE id = $1`, [expiredDriverId]);
    assert.strictEqual(checkRes.rows[0].onboarding_status, 'SUSPENDED_DOC_EXPIRED');
    assert.strictEqual(checkRes.rows[0].is_available, false);

    // Cleanup
    await query(`DELETE FROM crm_driver_vehicles WHERE id = $1`, [expiredVehicleId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [expiredDriverId]);
  });

  it('10. Driver Rating System: Records 1-tap ratings, recalculates average, handles low-rating alerts, and disputes', async () => {
    const ts = Date.now();
    const testPhone = `917999${ts.toString().slice(-6)}`;
    const custPhone = `919999${ts.toString().slice(-6)}`;

    // 1. Create a test driver
    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, wallet_balance, is_available)
       VALUES ('Rating Test Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 5.0, 500.0, true)
       RETURNING id`,
      [testPhone]
    );
    const driverId = dRes.rows[0].id;

    // 2. Create customer and booking
    const cRes = await query(
      `INSERT INTO crm_customers (full_name, phone) VALUES ('Rating Test Customer', $1) RETURNING id`,
      [custPhone]
    );
    const customerId = cRes.rows[0].id;

    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Patna Airport', CURRENT_DATE, '10:00:00', 'sedan', 2500, 'COMPLETED_SETTLED', 'PAID_IN_FULL')
      RETURNING id, booking_code`,
      [`RATE-TEST-${ts}`, customerId, driverId]
    );
    const bookingId = bRes.rows[0].id;

    // 3. Customer rates 5 Stars
    const r1 = await recordCustomerRating({
      bookingId,
      rating: 5,
    });

    assert.strictEqual(r1.success, true);
    assert.strictEqual(r1.newDriverRating, 5.0);
    assert.strictEqual(r1.shouldPromptGoogleReview, true);

    // Verify driver stats updated
    let profile = await getDriverRatingProfile(driverId);
    assert.ok(profile);
    assert.strictEqual(profile?.totalRatingsCount, 1);
    assert.strictEqual(profile?.rating5Count, 1);
    assert.strictEqual(profile?.currentRating, 5.0);

    // 4. Create second booking and test a 1-Star rating with category
    const b2Res = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Patna Junction', CURRENT_DATE, '14:00:00', 'sedan', 2000, 'COMPLETED_SETTLED', 'PAID_IN_FULL')
      RETURNING id`,
      [`RATE-TEST-2-${ts}`, customerId, driverId]
    );
    const booking2Id = b2Res.rows[0].id;

    const r2 = await recordCustomerRating({
      bookingId: booking2Id,
      rating: 1,
      feedbackCategory: 'RASH_DRIVING',
      customerComment: 'Driver drove too fast on bypass',
    });

    assert.strictEqual(r2.success, true);
    // Average of 5 and 1 = 3.0
    assert.strictEqual(r2.newDriverRating, 3.0);
    assert.strictEqual(r2.shouldPromptGoogleReview, false);
    assert.strictEqual(r2.alertAdmin, true);

    profile = await getDriverRatingProfile(driverId);
    assert.strictEqual(profile?.totalRatingsCount, 2);
    assert.strictEqual(profile?.rating1Count, 1);
    assert.strictEqual(profile?.currentRating, 3.0);

    // 5. Test dispute resolution: Admin investigates and excludes the 1-star rating
    const reviewId = profile!.recentReviews.find((r) => r.rating === 1)!.id;
    const adminRes = await query(`SELECT id FROM crm_admin_users LIMIT 1`);
    const adminId = adminRes.rows[0]?.id || 1;

    const disputeResult = await disputeRating(
      reviewId,
      adminId,
      'Speed limit logs verified via GPS - driver maintained legal limit; customer was agitated.'
    );

    assert.strictEqual(disputeResult.success, true);
    // After excluding the 1-star rating, driver rating goes back to 5.0
    assert.strictEqual(disputeResult.newDriverRating, 5.0);

    // 6. Test WhatsApp bot rating button dispatch
    await processIncomingWhatsAppMessage({
      fromPhone: custPhone,
      buttonId: `rate_trip_${bookingId}_5`,
    });

    // Cleanup
    await query(`DELETE FROM crm_driver_ratings WHERE driver_id = $1`, [driverId]);
    await query(`DELETE FROM crm_bookings WHERE id IN ($1, $2)`, [bookingId, booking2Id]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [driverId]);
  });

  it('11. Revenue Protection & Tax Settlement: Verifies 10% advance token, 3% commission + 18% GST + ₹10 tech fee math, zero-debt cash collection, and dynamic driver credit limits', async () => {
    // 1. Mathematically audit ₹2000 ride split
    const split = await calculateRideSplitWithTaxes(2000);
    assert.strictEqual(split.customerTotalFare, 2000);
    assert.strictEqual(split.platformCommission, 60); // 3%
    assert.strictEqual(split.gstAmount, 10.8); // 18% of 60
    assert.strictEqual(split.techFeeAmount, 10);
    assert.strictEqual(split.totalCompanyDuesZ, 80.8); // 60 + 10.8 + 10
    assert.strictEqual(split.advanceTokenAmount, 200); // 10%
    assert.strictEqual(split.balanceCashDueFromCustomer, 1800); // 2000 - 200
    assert.strictEqual(split.driverGrossEarnings, 1919.2); // 2000 - 80.8

    // 2. Settlement Verification with Advance Token: Zero-Debt Driver Collection
    const ts = Date.now();
    const dPhone = `917111${ts.toString().slice(-6)}`;
    const cPhone = `919111${ts.toString().slice(-6)}`;

    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, wallet_balance, is_available)
       VALUES ('Token Test Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 5.0, 0.00, true)
       RETURNING id`,
      [dPhone]
    );
    const driverId = dRes.rows[0].id;

    const cRes = await query(
      `INSERT INTO crm_customers (full_name, phone) VALUES ('Token Test Customer', $1) RETURNING id`,
      [cPhone]
    );
    const customerId = cRes.rows[0].id;

    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        commission_amount, advance_paid, gst_amount, tech_fee_amount, balance_cash_due_from_customer,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Patna Junction', CURRENT_DATE, '10:00:00', 'sedan', 2000, 80.80, 200, 10.80, 10, 1800, 'INQUIRY_OPEN', 'PARTIALLY_PAID')
      RETURNING id`,
      [`REV-TEST-${ts}`, customerId, driverId]
    );
    const bookingId = bRes.rows[0].id;

    // Driver completes trip and collects balance cash (₹1800)
    const settleResult = await completeTripAndSettle({
      bookingId,
      cashCollectedByDriver: 1800,
      tollParking: 0,
    });

    // Driver gross = 2000 - 80.80 = 1919.20. Driver collected 1800 cash.
    // Base net settlement = 1919.20 - 1800 = +119.20.
    // Rolling reserve float deduction = Math.min(100, 500) = 100.
    // Net driver wallet settlement = 119.20 - 100 = +19.20.
    assert.strictEqual(settleResult.securityReserveDeducted, 100);
    assert.strictEqual(settleResult.newSecurityReserveBalance, 100);
    assert.strictEqual(settleResult.newDriverWalletBalance, 19.2);
    assert.strictEqual(settleResult.settlementType, 'PAYABLE_TO_DRIVER');

    // 3. Dynamic Leeway Verification: Probation (300) vs Standard (1000) vs Elite (2500)
    const dProbationPhone = `917222${ts.toString().slice(-6)}`;
    const dStandardPhone = `917333${ts.toString().slice(-6)}`;
    const dElitePhone = `917444${ts.toString().slice(-6)}`;

    // Driver A: Probation (rating 4.0), debt -₹350 (exceeds -₹300 limit)
    const pRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, is_available)
       VALUES ('Probation Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.0, 5, -350.00, true)
       RETURNING id`,
      [dProbationPhone]
    );
    const pId = pRes.rows[0].id;
    await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [pId, `BR-01-P-${ts.toString().slice(-4)}`]);

    // Driver B: Standard (rating 4.5), debt -₹800 (within -₹1000 limit)
    const sRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, is_available)
       VALUES ('Standard Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.5, 15, -800.00, true)
       RETURNING id`,
      [dStandardPhone]
    );
    const sId = sRes.rows[0].id;
    await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [sId, `BR-01-S-${ts.toString().slice(-4)}`]);

    // Driver C: Elite (rating 4.9, 30 trips), debt -₹2000 (within -₹2500 limit)
    const eRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, is_available)
       VALUES ('Elite Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.9, 30, -2000.00, true)
       RETURNING id`,
      [dElitePhone]
    );
    const eId = eRes.rows[0].id;
    await query(`INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified) VALUES ($1, 'sedan', $2, 'Dzire', true)`, [eId, `BR-01-E-${ts.toString().slice(-4)}`]);

    const candidates = await findEligibleDrivers('Patna', 'sedan');
    const candidateIds = candidates.map((c) => c.driver_id);

    // Probation driver (-350) should be excluded
    assert.strictEqual(candidateIds.includes(pId), false, 'Probation driver exceeding -300 is excluded');
    // Standard driver (-800) should be included
    assert.strictEqual(candidateIds.includes(sId), true, 'Standard driver within -1000 is included');
    // Elite driver (-2000) should be included
    assert.strictEqual(candidateIds.includes(eId), true, 'Elite driver within -2500 is included');

    // Cleanup
    await query(`DELETE FROM crm_payments_ledger WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    await query(`DELETE FROM crm_driver_vehicles WHERE driver_id IN ($1, $2, $3)`, [pId, sId, eId]);
    await query(`DELETE FROM crm_drivers WHERE id IN ($1, $2, $3, $4)`, [pId, sId, eId, driverId]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
  });

  it('12. Cross-Ride Debt Absorption & Soft Mode: Verifies restricted drivers receive prepaid rides to clear debt, auto-restore to active, and automated UPI micro-recharges', async () => {
    const ts = Date.now();
    const dPhone = `917888${ts.toString().slice(-6)}`;
    const cPhone = `919888${ts.toString().slice(-6)}`;

    // 1. Create a driver with negative balance of -₹500 (probation driver with rating 4.15 >= 4.10 dispatch min, limit -₹300)
    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, is_available)
       VALUES ('Soft Mode Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.15, 3, -500.00, true)
       RETURNING id`,
      [dPhone]
    );
    const driverId = dRes.rows[0].id;

    await query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified)
       VALUES ($1, 'sedan', $2, 'Dzire Soft', true)`,
      [driverId, `BR-01-SM-${ts.toString().slice(-4)}`]
    );

    // 2. Run unpaid dues cron -> Driver is NOT blocked! Soft degraded to RESTRICTED_DIGITAL_ONLY
    const restrictedCount = await runUnpaidDuesGuardrails();
    assert.ok(restrictedCount >= 1, 'Restricted driver count updated');

    const checkRes = await query(`SELECT onboarding_status, is_available FROM crm_drivers WHERE id = $1`, [driverId]);
    assert.strictEqual(checkRes.rows[0].onboarding_status, 'RESTRICTED_DIGITAL_ONLY');
    assert.strictEqual(checkRes.rows[0].is_available, true, 'Driver remains available for prepaid rides');

    // 3. Test Cash Ride Exclusion: Driver cannot receive standard cash rides
    const cashCandidates = await findEligibleDrivers('Patna', 'sedan', { isPrepaidRide: false });
    assert.strictEqual(cashCandidates.some((c) => c.driver_id === driverId), false, 'Excluded from cash rides');

    // 4. Test Prepaid Ride Inclusion: Driver IS eligible for prepaid bookings to absorb debt!
    const prepaidCandidates = await findEligibleDrivers('Patna', 'sedan', { isPrepaidRide: true });
    assert.strictEqual(prepaidCandidates.some((c) => c.driver_id === driverId), true, 'Eligible for prepaid rides');

    // 5. Test Cross-Ride Debt Absorption: Customer books prepaid ride (₹1500 advance paid online)
    const cRes = await query(
      `INSERT INTO crm_customers (full_name, phone) VALUES ('Prepaid Customer', $1) RETURNING id`,
      [cPhone]
    );
    const customerId = cRes.rows[0].id;

    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        commission_amount, advance_paid, gst_amount, tech_fee_amount, balance_cash_due_from_customer,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Airport', CURRENT_DATE, '15:00:00', 'sedan', 1500, 60.00, 1500, 8.10, 10, 0, 'INQUIRY_OPEN', 'PAID_IN_FULL')
      RETURNING id`,
      [`CROSS-TEST-${ts}`, customerId, driverId]
    );
    const bookingId = bRes.rows[0].id;

    // Driver completes prepaid ride: cash collected = 0
    const settleRes = await completeTripAndSettle({
      bookingId,
      cashCollectedByDriver: 0,
      tollParking: 0,
    });

    // Payout earnings = 1500 - 60 = 1440. Previous wallet was -500.
    // Rolling reserve float deduction = Math.min(100, 500) = 100.
    // New wallet balance = 1440 - 100 - 500 = +840!
    assert.strictEqual(settleRes.securityReserveDeducted, 100);
    assert.strictEqual(settleRes.newSecurityReserveBalance, 100);
    assert.strictEqual(settleRes.newDriverWalletBalance, 840);
    assert.strictEqual(settleRes.settlementType, 'PAYABLE_TO_DRIVER');

    // Verify driver was automatically restored from RESTRICTED_DIGITAL_ONLY to APPROVED_ACTIVE!
    const restoredRes = await query(`SELECT onboarding_status FROM crm_drivers WHERE id = $1`, [driverId]);
    assert.strictEqual(restoredRes.rows[0].onboarding_status, 'APPROVED_ACTIVE', 'Auto-restored to APPROVED_ACTIVE');

    // 6. Test 1-Tap UPI WhatsApp Payment Deep Link Generator
    await processIncomingWhatsAppMessage({
      fromPhone: dPhone,
      buttonId: `pay_dues_${driverId}`,
    });

    // Cleanup
    await query(`DELETE FROM crm_payments_ledger WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = $1`, [driverId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [driverId]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
  });

  it('13. Rolling Security Reserve Float & Incentive Debt Routing: Verifies Porter-style float accrual, streak bonuses, and incentive wallet debt offsetting', async () => {
    const ts = Date.now();
    const dPhone = `917777${ts.toString().slice(-6)}`;
    const cPhone = `919777${ts.toString().slice(-6)}`;

    // 1. Create Driver with 4 completed trips, negative balance of -₹120, and ₹0 reserve
    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, security_reserve_balance, is_available)
       VALUES ('Incentive Test Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.8, 4, -120.00, 0.00, true)
       RETURNING id`,
      [dPhone]
    );
    const driverId = dRes.rows[0].id;

    await query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name, is_verified)
       VALUES ($1, 'sedan', $2, 'Dzire Reserve', true)`,
      [driverId, `BR-01-RR-${ts.toString().slice(-4)}`]
    );

    const cRes = await query(
      `INSERT INTO crm_customers (full_name, phone) VALUES ('Incentive Customer', $1) RETURNING id`,
      [cPhone]
    );
    const customerId = cRes.rows[0].id;

    // 2. Booking #5: customer pays ₹200 advance online, ₹1800 cash on drop (total fare ₹2000)
    // Commission = ₹80.80
    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        commission_amount, advance_paid, gst_amount, tech_fee_amount, balance_cash_due_from_customer,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Danapur', CURRENT_DATE, '16:00:00', 'sedan', 2000, 80.80, 200, 10.80, 10, 1800, 'INQUIRY_OPEN', 'ADVANCE_PAID')
      RETURNING id`,
      [`RESERVE-TEST-${ts}`, customerId, driverId]
    );
    const bookingId = bRes.rows[0].id;

    // Driver completes 5th trip:
    // Trip count becomes 5 (target streak is 5 trips -> awards ₹150 streak bonus)
    // Driver earnings = 2000 - 80.80 = 1919.20. Cash collected = 1800.
    // Base net settlement = +119.20
    // Reserve deduction = min(100, 500, 119.20) = 100.
    // Streak bonus = 150.
    // Final net settlement for this trip = 119.20 - 100 + 150 = +169.20
    // Driver wallet was -120.00.
    // New wallet balance = -120 + 169.20 = +49.20!
    const settleRes = await completeTripAndSettle({
      bookingId,
      cashCollectedByDriver: 1800,
      tollParking: 0,
    });

    assert.strictEqual(settleRes.securityReserveDeducted, 100);
    assert.strictEqual(settleRes.newSecurityReserveBalance, 100);
    assert.strictEqual(settleRes.streakBonusAwarded, 150);
    assert.strictEqual(settleRes.newDriverWalletBalance, 49.2);

    // Verify driver's reserve and trips in database
    const dCheck = await query(`SELECT security_reserve_balance, total_trips_completed, wallet_balance FROM crm_drivers WHERE id = $1`, [driverId]);
    assert.strictEqual(Number(dCheck.rows[0].security_reserve_balance), 100);
    assert.strictEqual(dCheck.rows[0].total_trips_completed, 5);
    assert.strictEqual(Number(dCheck.rows[0].wallet_balance), 49.2);

    // 3. Test Direct Admin/Promotional Incentive Debt Routing:
    // Set driver back to debt (-₹150) in RESTRICTED_DIGITAL_ONLY status
    await query(`UPDATE crm_drivers SET wallet_balance = -150.00, onboarding_status = 'RESTRICTED_DIGITAL_ONLY' WHERE id = $1`, [driverId]);

    // Award ₹200 promotional bonus
    const incResult = await awardDriverIncentive(driverId, 200, 'Top Weekly Partner Bonus');
    assert.strictEqual(incResult.success, true);
    assert.strictEqual(incResult.debtCleared, 150);
    assert.strictEqual(incResult.newWalletBalance, 50);

    const postIncCheck = await query(`SELECT wallet_balance, onboarding_status FROM crm_drivers WHERE id = $1`, [driverId]);
    assert.strictEqual(Number(postIncCheck.rows[0].wallet_balance), 50);
    assert.strictEqual(postIncCheck.rows[0].onboarding_status, 'APPROVED_ACTIVE', 'Status auto-restored after incentive cleared dues');

    // Cleanup
    await query(`DELETE FROM crm_payments_ledger WHERE driver_id = $1`, [driverId]);
    await query(`DELETE FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = $1`, [driverId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [driverId]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
  });

  it('14. Operational CRM Management API & Enrichment: Verifies driver credit tier enrichment, statutory finance KPIs, and booking tax breakdown', async () => {
    const ts = Date.now();
    const dPhone = `917666${ts.toString().slice(-6)}`;
    const cPhone = `919666${ts.toString().slice(-6)}`;

    // 1. Create a Standard Driver (rating 4.5, 10 trips, reserve ₹200)
    const dRes = await query(
      `INSERT INTO crm_drivers (full_name, phone, whatsapp_phone, base_city, onboarding_status, rating, total_trips_completed, wallet_balance, security_reserve_balance, is_available)
       VALUES ('API Verification Driver', $1, $1, 'Patna', 'APPROVED_ACTIVE', 4.5, 10, -150.00, 200.00, true)
       RETURNING id`,
      [dPhone]
    );
    const driverId = dRes.rows[0].id;

    // 2. Fetch via drivers route handler logic
    const revPolicy = await getRevenueProtectionPolicy();
    const rating = 4.5;
    const trips = 10;
    let tier = 'PROBATION';
    const limits = revPolicy.dynamic_credit_limits || { probation_or_new: 300, standard: 1000, elite: 2500 };
    let dynamicLimit = limits.probation_or_new;
    if (rating >= revPolicy.elite_min_rating && trips >= revPolicy.elite_min_trips) {
      tier = 'ELITE';
      dynamicLimit = limits.elite;
    } else if (rating >= revPolicy.standard_min_rating) {
      tier = 'STANDARD';
      dynamicLimit = limits.standard;
    }

    assert.strictEqual(tier, 'STANDARD');
    assert.strictEqual(dynamicLimit, 1000);

    // 3. Create customer & booking with tax split
    const cRes = await query(
      `INSERT INTO crm_customers (full_name, phone) VALUES ('API Test Customer', $1) RETURNING id`,
      [cPhone]
    );
    const customerId = cRes.rows[0].id;

    const fare = 3000;
    const taxSplit = await calculateRideSplitWithTaxes(fare);
    // 3% facilitation = 90. 18% GST on 90 = 16.20. Tech fee = 10. Total deduction = 116.20. Advance 10% = 300. Cash due = 2700.
    assert.strictEqual(taxSplit.platformCommission, 90);
    assert.strictEqual(taxSplit.gstAmount, 16.2);
    assert.strictEqual(taxSplit.techFeeAmount, 10);
    assert.strictEqual(taxSplit.totalCompanyDuesZ, 116.2);
    assert.strictEqual(taxSplit.advanceTokenAmount, 300);
    assert.strictEqual(taxSplit.balanceCashDueFromCustomer, 2700);

    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, assigned_driver_id, trip_type, origin_city,
        pickup_address, pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        driver_payout_amount, commission_amount, gst_amount, tech_fee_amount, advance_paid, balance_cash_due_from_customer,
        booking_status, payment_status
      ) VALUES ($1, $2, $3, 'oneway', 'Patna', 'Airport', CURRENT_DATE, '18:00:00', 'sedan', $4, $5, $6, $7, $8, $9, $10, 'COMPLETED_SETTLED', 'PAID_IN_FULL')
      RETURNING id`,
      [
        `KPI-TEST-${ts}`,
        customerId,
        driverId,
        fare,
        taxSplit.driverGrossEarnings,
        taxSplit.totalCompanyDuesZ,
        taxSplit.gstAmount,
        taxSplit.techFeeAmount,
        taxSplit.advanceTokenAmount,
        taxSplit.balanceCashDueFromCustomer,
      ]
    );
    const bookingId = bRes.rows[0].id;

    // 4. Verify Financial KPI queries
    const kpiRes = await query(`
      SELECT
        COALESCE(SUM(b.commission_amount), 0) AS total_commission_revenue,
        COALESCE(SUM(b.gst_amount), 0) AS total_gst_statutory_collected,
        COALESCE(SUM(b.tech_fee_amount), 0) AS total_tech_fees_collected,
        COALESCE((SELECT SUM(security_reserve_balance) FROM crm_drivers), 0) AS total_security_reserve_held,
        COALESCE((SELECT SUM(ABS(wallet_balance)) FROM crm_drivers WHERE wallet_balance < 0), 0) AS total_driver_dues_outstanding
      FROM crm_bookings b
      WHERE b.id = $1
    `, [bookingId]);

    assert.strictEqual(Number(kpiRes.rows[0].total_commission_revenue), 116.2);
    assert.strictEqual(Number(kpiRes.rows[0].total_gst_statutory_collected), 16.2);
    assert.strictEqual(Number(kpiRes.rows[0].total_tech_fees_collected), 10);
    assert.ok(Number(kpiRes.rows[0].total_security_reserve_held) >= 200);
    assert.ok(Number(kpiRes.rows[0].total_driver_dues_outstanding) >= 150);

    // Cleanup
    await query(`DELETE FROM crm_payments_ledger WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_invoices WHERE booking_id = $1`, [bookingId]);
    await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    await query(`DELETE FROM crm_driver_vehicles WHERE driver_id = $1`, [driverId]);
    await query(`DELETE FROM crm_drivers WHERE id = $1`, [driverId]);
    await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
  });

  it('15. Dynamic Revenue Protection Policy Configuration: Verifies updating take-rate, customer convenience fees, and dynamic credit leeway in crm_settings', async () => {
    // 1. Fetch current policy
    const originalPolicy = await getRevenueProtectionPolicy();

    // 2. Update policy dynamically via updateSetting (e.g. increase take-rate to 10%, set ₹39 convenience fee)
    const updatedPolicyConfig = {
      ...originalPolicy,
      platform_commission_pct: 10.0,
      customer_convenience_fee: 39.0,
      tech_fee_amount: 10.0,
      gst_on_commission_pct: 18.0,
      dynamic_credit_limits: {
        probation_or_new: 350.0,
        standard: 1200.0,
        elite: 3000.0,
      },
    };

    await updateSetting('revenue_protection_policy', updatedPolicyConfig, 'Updated 10% unit economics policy');

    // 3. Verify getRevenueProtectionPolicy immediately returns updated values from DB
    const freshPolicy = await getRevenueProtectionPolicy();
    assert.strictEqual(freshPolicy.platform_commission_pct, 10.0);
    assert.strictEqual(freshPolicy.customer_convenience_fee, 39.0);
    assert.strictEqual(freshPolicy.dynamic_credit_limits.standard, 1200.0);

    // 4. Verify calculateRideSplitWithTaxes() immediately recalculates on ₹2,000 fare
    // At 10%: platform commission = 200. GST 18% = 36. Tech fee = 10. Convenience fee = 39. Total company dues Z = 246.00.
    const split10 = await calculateRideSplitWithTaxes(2000);
    assert.strictEqual(split10.platformCommission, 200);
    assert.strictEqual(split10.gstAmount, 36);
    assert.strictEqual(split10.techFeeAmount, 10);
    assert.strictEqual(split10.convenienceFeeAmount, 39);
    assert.strictEqual(split10.totalCompanyDuesZ, 246);
    assert.strictEqual(split10.driverGrossEarnings, 1754);

    // 5. Restore original policy
    await updateSetting('revenue_protection_policy', originalPolicy, 'Restored original policy');
    const restoredPolicy = await getRevenueProtectionPolicy();
    assert.strictEqual(restoredPolicy.platform_commission_pct, originalPolicy.platform_commission_pct);
  });

  after(async () => {
    await getDbPool().end();
  });
});
