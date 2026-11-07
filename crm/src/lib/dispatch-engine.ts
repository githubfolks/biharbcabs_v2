import { query, withTransaction } from './db';
import {
  getDispatchSlaTimeoutMinutes,
  getCommissionConfig,
  getDriverMaxNegativeBalance,
  getAdminContacts,
  getDriverRatingPolicy,
  getRevenueProtectionPolicy,
} from './settings';
import { PoolClient } from 'pg';

export interface DispatchCandidate {
  driver_id: number;
  full_name: string;
  phone: string;
  whatsapp_phone: string;
  base_city: string;
  vehicle_id: number;
  model_name: string;
  registration_no: string;
  wallet_balance: number;
  rating: number;
}

export interface BookingDetails {
  id: number;
  booking_code: string;
  customer_id: number;
  customer_name?: string;
  customer_phone?: string;
  trip_type: string;
  origin_city: string;
  destination_city?: string;
  pickup_address: string;
  drop_address?: string;
  pickup_date: string;
  pickup_time: string;
  wp_vehicle_code: string;
  distance_km: number;
  customer_total_fare: number;
  driver_payout_amount: number;
  commission_amount: number;
  booking_status: string;
  assigned_driver_id?: number;
}

export interface RideSplitCalculation {
  customerTotalFare: number;
  platformCommission: number;
  gstAmount: number;
  techFeeAmount: number;
  convenienceFeeAmount: number;
  totalCompanyDuesZ: number;
  advanceTokenAmount: number;
  balanceCashDueFromCustomer: number;
  driverGrossEarnings: number;
}

/**
 * Mathematically compute platform commission, 18% GST on commission, tech fee,
 * customer convenience fee, and universal advance token according to dynamic crm_settings.
 */
export async function calculateRideSplitWithTaxes(customerTotalFare: number): Promise<RideSplitCalculation> {
  const policy = await getRevenueProtectionPolicy();

  const platformCommission = Math.round((customerTotalFare * policy.platform_commission_pct) / 100);
  const gstAmount = parseFloat(((platformCommission * policy.gst_on_commission_pct) / 100).toFixed(2));
  const techFeeAmount = Number(policy.tech_fee_amount || 10);
  const convenienceFeeAmount = Number(policy.customer_convenience_fee || 0);
  const totalCompanyDuesZ = parseFloat((platformCommission + gstAmount + techFeeAmount).toFixed(2));

  // Compute advance token (minimum ₹200, capped at total fare)
  const calculatedAdvance = Math.round((customerTotalFare * policy.advance_token_percentage) / 100);
  const advanceTokenAmount = Math.min(customerTotalFare, Math.max(policy.min_advance_amount, calculatedAdvance));

  const balanceCashDueFromCustomer = Math.max(0, customerTotalFare - advanceTokenAmount);
  const driverGrossEarnings = customerTotalFare - totalCompanyDuesZ;

  return {
    customerTotalFare,
    platformCommission,
    gstAmount,
    techFeeAmount,
    convenienceFeeAmount,
    totalCompanyDuesZ,
    advanceTokenAmount,
    balanceCashDueFromCustomer,
    driverGrossEarnings,
  };
}

/**
 * Calculate the commission and driver payout dynamically according to crm_settings.
 */
export async function calculateFareSplit(customerTotalFare: number): Promise<{
  commissionAmount: number;
  driverPayoutAmount: number;
}> {
  const config = await getCommissionConfig();
  let commission = 0;

  if (config.type === 'PERCENTAGE' && config.percentage) {
    commission = Math.round((customerTotalFare * config.percentage) / 100);
  } else if (config.type === 'FIXED_MARGIN' && config.fixed_margin) {
    commission = Math.min(config.fixed_margin, customerTotalFare);
  } else {
    commission = Math.round((customerTotalFare * 12) / 100);
  }

  const driverPayout = Math.max(0, customerTotalFare - commission);
  return {
    commissionAmount: commission,
    driverPayoutAmount: driverPayout,
  };
}

/**
 * Find all active, verified, compliant drivers eligible for a booking.
 * Guardrails enforced:
 * 1. Base city matches origin city
 * 2. Documents are unexpired (DL, Insurance, Fitness, Permit)
 * 3. Cross-Ride & Prepaid Ride Absorption:
 *    - If isPrepaidRide is true: drivers in 'RESTRICTED_DIGITAL_ONLY' with negative balance
 *      are ELIGIBLE and PRIORITIZED so their debt is automatically absorbed from trip payout!
 *    - If isPrepaidRide is false: driver must be 'APPROVED_ACTIVE' and within their dynamic credit limit:
 *        - Elite (4.8★+, 25+ trips): Leeway up to ₹2,500 negative
 *        - Standard (4.2★+): Leeway up to ₹1,000 negative
 *        - Probation / New: Leeway capped at ₹300 negative
 */
export async function findEligibleDrivers(
  originCity: string,
  vehicleCode: string,
  options?: { isPrepaidRide?: boolean }
): Promise<DispatchCandidate[]> {
  const ratingPolicy = await getDriverRatingPolicy();
  const revPolicy = await getRevenueProtectionPolicy();
  const isPrepaid = options?.isPrepaidRide ?? false;

  let sql: string;
  let params: any[];

  if (isPrepaid) {
    // For prepaid rides: Include drivers in digital-only restricted mode, prioritizing drivers with dues
    sql = `
      SELECT 
        d.id AS driver_id,
        d.full_name,
        d.phone,
        d.whatsapp_phone,
        d.base_city,
        d.wallet_balance,
        d.rating,
        v.id AS vehicle_id,
        v.model_name,
        v.registration_no
      FROM crm_drivers d
      JOIN crm_driver_vehicles v ON v.driver_id = d.id
      WHERE LOWER(d.base_city) = LOWER($1)
        AND d.onboarding_status IN ('APPROVED_ACTIVE', 'RESTRICTED_DIGITAL_ONLY')
        AND d.is_available = true
        AND d.rating >= ($2::numeric)
        AND (d.license_expiry IS NULL OR d.license_expiry >= CURRENT_DATE)
        AND LOWER(v.wp_vehicle_code) = LOWER($3)
        AND v.is_verified = true
        AND (v.insurance_expiry IS NULL OR v.insurance_expiry >= CURRENT_DATE)
        AND (v.fitness_expiry IS NULL OR v.fitness_expiry >= CURRENT_DATE)
        AND (v.permit_expiry IS NULL OR v.permit_expiry >= CURRENT_DATE)
      ORDER BY (CASE WHEN d.wallet_balance < 0 THEN 0 ELSE 1 END) ASC, d.rating DESC, d.wallet_balance DESC;
    `;
    params = [originCity, ratingPolicy.min_dispatch_rating, vehicleCode];
  } else {
    // Standard cash ride: enforce dynamic credit limit and APPROVED_ACTIVE status
    sql = `
      SELECT 
        d.id AS driver_id,
        d.full_name,
        d.phone,
        d.whatsapp_phone,
        d.base_city,
        d.wallet_balance,
        d.rating,
        v.id AS vehicle_id,
        v.model_name,
        v.registration_no
      FROM crm_drivers d
      JOIN crm_driver_vehicles v ON v.driver_id = d.id
      WHERE LOWER(d.base_city) = LOWER($1)
        AND d.onboarding_status = 'APPROVED_ACTIVE'
        AND d.is_available = true
        AND d.rating >= ($2::numeric)
        AND d.wallet_balance >= -(
          CASE 
            WHEN d.rating >= ($4::numeric) AND d.total_trips_completed >= ($5::integer) THEN ($6::numeric)
            WHEN d.rating >= ($7::numeric) THEN ($8::numeric)
            ELSE ($9::numeric)
          END
        )
        AND (d.license_expiry IS NULL OR d.license_expiry >= CURRENT_DATE)
        AND LOWER(v.wp_vehicle_code) = LOWER($3)
        AND v.is_verified = true
        AND (v.insurance_expiry IS NULL OR v.insurance_expiry >= CURRENT_DATE)
        AND (v.fitness_expiry IS NULL OR v.fitness_expiry >= CURRENT_DATE)
        AND (v.permit_expiry IS NULL OR v.permit_expiry >= CURRENT_DATE)
      ORDER BY d.rating DESC, d.wallet_balance DESC;
    `;
    params = [
      originCity,
      ratingPolicy.min_dispatch_rating,
      vehicleCode,
      revPolicy.elite_min_rating,
      revPolicy.elite_min_trips,
      revPolicy.dynamic_credit_limits.elite,
      revPolicy.standard_min_rating,
      revPolicy.dynamic_credit_limits.standard,
      revPolicy.dynamic_credit_limits.probation_or_new,
    ];
  }

  const res = await query(sql, params);
  return res.rows;
}

/**
 * Broadcast ride to eligible drivers and initialize SLA deadline.
 */
export async function broadcastRideToDrivers(bookingId: number): Promise<{
  success: boolean;
  offersCreated: number;
  slaDeadline: Date;
  candidates: DispatchCandidate[];
}> {
  const timeoutMins = await getDispatchSlaTimeoutMinutes();

  return withTransaction(async (client: PoolClient) => {
    // 1. Fetch booking details with row lock
    const bookingRes = await client.query(
      `SELECT * FROM crm_bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      throw new Error(`Booking #${bookingId} not found`);
    }

    const booking = bookingRes.rows[0];
    const slaDeadline = new Date(Date.now() + timeoutMins * 60 * 1000);

    // 2. Find eligible drivers (prepaid rides cross-absorb debt from digital-only restricted drivers)
    const isPrepaid = booking.payment_status === 'PAID_IN_FULL' || Number(booking.advance_paid) >= Number(booking.customer_total_fare);
    const candidates = await findEligibleDrivers(booking.origin_city, booking.wp_vehicle_code, { isPrepaidRide: isPrepaid });

    // 3. Update booking status and SLA
    await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'AWAITING_DRIVER',
           driver_broadcast_at = CURRENT_TIMESTAMP,
           sla_deadline_at = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [slaDeadline, bookingId]
    );

    // 4. Create offer records for each candidate
    let offersCreated = 0;
    for (const cand of candidates) {
      await client.query(
        `INSERT INTO crm_dispatch_offers 
         (booking_id, driver_id, offered_driver_fare, offer_status, sent_at)
         VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP)`,
        [bookingId, cand.driver_id, booking.driver_payout_amount]
      );
      offersCreated++;
    }

    return {
      success: true,
      offersCreated,
      slaDeadline,
      candidates,
    };
  });
}

/**
 * Atomic ride acceptance by a driver.
 * Uses PostgreSQL row-level lock (SELECT ... FOR UPDATE) to guarantee that
 * only the FIRST driver to confirm gets assigned, preventing race conditions.
 */
export async function acceptRideOffer(
  bookingId: number,
  driverId: number
): Promise<{
  success: boolean;
  status: 'ASSIGNED' | 'ALREADY_ASSIGNED' | 'OFFER_EXPIRED' | 'NOT_FOUND';
  booking?: BookingDetails;
  message: string;
}> {
  return withTransaction(async (client: PoolClient) => {
    // 1. Lock the booking row
    const bookingRes = await client.query(
      `SELECT b.*, c.full_name AS customer_name, c.phone AS customer_phone
       FROM crm_bookings b
       JOIN crm_customers c ON c.id = b.customer_id
       WHERE b.id = $1
       FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      return {
        success: false,
        status: 'NOT_FOUND',
        message: `Booking #${bookingId} does not exist.`,
      };
    }

    const booking: BookingDetails = bookingRes.rows[0];

    // Check if already assigned
    if (booking.assigned_driver_id && booking.assigned_driver_id !== driverId) {
      // Mark this driver's offer as MISSED
      await client.query(
        `UPDATE crm_dispatch_offers
         SET offer_status = 'MISSED', responded_at = CURRENT_TIMESTAMP
         WHERE booking_id = $1 AND driver_id = $2`,
        [bookingId, driverId]
      );

      return {
        success: false,
        status: 'ALREADY_ASSIGNED',
        booking,
        message: `Sorry, this ride has already been accepted by another driver.`,
      };
    }

    // Check if booking is in an acceptable state
    if (booking.booking_status !== 'AWAITING_DRIVER' && booking.booking_status !== 'ESCALATED_NO_DRIVER') {
      return {
        success: false,
        status: 'OFFER_EXPIRED',
        booking,
        message: `This ride offer is no longer active (Status: ${booking.booking_status}).`,
      };
    }

    // Find driver's active vehicle
    const vehicleRes = await client.query(
      `SELECT id FROM crm_driver_vehicles 
       WHERE driver_id = $1 AND LOWER(wp_vehicle_code) = LOWER($2) AND is_verified = true
       ORDER BY id ASC LIMIT 1`,
      [driverId, booking.wp_vehicle_code]
    );

    const vehicleId = vehicleRes.rows[0]?.id || null;

    // 2. Assign the driver and update booking
    await client.query(
      `UPDATE crm_bookings
       SET assigned_driver_id = $1,
           assigned_vehicle_id = $2,
           booking_status = 'DRIVER_ASSIGNED',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [driverId, vehicleId, bookingId]
    );

    // 3. Mark this driver's offer as ACCEPTED
    await client.query(
      `UPDATE crm_dispatch_offers
       SET offer_status = 'ACCEPTED', responded_at = CURRENT_TIMESTAMP
       WHERE booking_id = $1 AND driver_id = $2`,
      [bookingId, driverId]
    );

    // 4. Mark all other pending offers for this booking as EXPIRED
    await client.query(
      `UPDATE crm_dispatch_offers
       SET offer_status = 'EXPIRED', responded_at = CURRENT_TIMESTAMP
       WHERE booking_id = $1 AND driver_id != $2 AND offer_status = 'PENDING'`,
      [bookingId, driverId]
    );

    booking.assigned_driver_id = driverId;
    booking.booking_status = 'DRIVER_ASSIGNED';

    return {
      success: true,
      status: 'ASSIGNED',
      booking,
      message: `Ride #${booking.booking_code} successfully assigned to you!`,
    };
  });
}

/**
 * SLA Timeout Escalation Checker.
 * Finds bookings in AWAITING_DRIVER whose SLA deadline has passed,
 * escalates them to ESCALATED_NO_DRIVER, and returns them for admin notification.
 */
export async function checkAndEscalateSlaBreaches(): Promise<BookingDetails[]> {
  const res = await query(
    `UPDATE crm_bookings
     SET booking_status = 'ESCALATED_NO_DRIVER',
         updated_at = CURRENT_TIMESTAMP
     WHERE booking_status = 'AWAITING_DRIVER'
       AND sla_deadline_at IS NOT NULL
       AND sla_deadline_at <= CURRENT_TIMESTAMP
     RETURNING *`
  );

  return res.rows;
}
