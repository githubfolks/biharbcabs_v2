import { query, withTransaction } from './db';
import {
  getDispatchSlaTimeoutMinutes,
  getCommissionConfig,
  getDriverMaxNegativeBalance,
  getAdminContacts,
  getDriverRatingPolicy,
  getRevenueProtectionPolicy,
  getReturnTripPolicy,
} from './settings';
import { PoolClient } from 'pg';
import { settleReturnDiscountFunding } from './return-trips';

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
  options?: {
    isPrepaidRide?: boolean;
    /** Only drivers returning from originCity to this city, whose return lasts until the pickup. */
    returnTrip?: { destinationCity: string; pickupAt: Date };
    /** Leave out drivers who already have an offer for this booking. */
    excludeOfferedForBooking?: number;
  }
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

  // Returning drivers are matched on where they are now, not their base city.
  if (options?.returnTrip) {
    const destParam = params.length + 1;
    const pickupParam = params.length + 2;
    sql = sql.replace(
      'WHERE LOWER(d.base_city) = LOWER($1)',
      `WHERE EXISTS (
         SELECT 1 FROM crm_driver_returns r
         WHERE r.driver_id = d.id AND r.ended_at IS NULL
           AND r.expires_at > CURRENT_TIMESTAMP AND r.expires_at >= $${pickupParam}
           AND LOWER(r.from_city) = LOWER($1) AND LOWER(r.to_city) = LOWER($${destParam})
       )`
    );
    params.push(options.returnTrip.destinationCity, options.returnTrip.pickupAt);
  }
  if (options?.excludeOfferedForBooking) {
    const bookingParam = params.length + 1;
    sql = sql.replace(
      'AND d.is_available = true',
      `AND d.is_available = true
        AND NOT EXISTS (SELECT 1 FROM crm_dispatch_offers o WHERE o.driver_id = d.id AND o.booking_id = $${bookingParam})`
    );
    params.push(options.excludeOfferedForBooking);
  }

  const res = await query(sql, params);
  return res.rows;
}

/** Pickup moment of a stored booking, read as India time. */
function bookingPickupAt(booking: any): Date {
  const date = booking.pickup_date instanceof Date
    ? `${booking.pickup_date.getFullYear()}-${String(booking.pickup_date.getMonth() + 1).padStart(2, '0')}-${String(booking.pickup_date.getDate()).padStart(2, '0')}`
    : String(booking.pickup_date).slice(0, 10);
  const time = String(booking.pickup_time).slice(0, 5);
  return new Date(`${date}T${time}:00+05:30`);
}

/**
 * Broadcast ride to eligible drivers and initialize SLA deadline.
 */
/**
 * Broadcast a ride and start its SLA.
 *
 * A booking carrying a return-trip discount is first offered only to drivers returning on that
 * route, for the policy's exclusive window. When the window ends (see releaseExpiredReturnWindows),
 * or if no returning driver is free, it goes to regular drivers, who are paid as if there were no
 * discount because the company absorbs it.
 */
export async function broadcastRideToDrivers(
  bookingId: number,
  options?: { releaseReturnWindow?: boolean }
): Promise<{
  success: boolean;
  offersCreated: number;
  slaDeadline: Date;
  candidates: DispatchCandidate[];
  isReturnPriority: boolean;
  exclusiveUntil: Date | null;
  offeredDriverFare: number;
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
    let slaDeadline = new Date(Date.now() + timeoutMins * 60 * 1000);

    // 2. Find eligible drivers (prepaid rides cross-absorb debt from digital-only restricted drivers)
    const isPrepaid = booking.payment_status === 'PAID_IN_FULL' || Number(booking.advance_paid) >= Number(booking.customer_total_fare);
    const hasDiscount = Number(booking.return_discount_amount) > 0 && !booking.return_discount_funded_by;

    let candidates: DispatchCandidate[] = [];
    let isReturnPriority = false;
    let exclusiveUntil: Date | null = null;

    if (hasDiscount && !booking.return_window_released_at && !options?.releaseReturnWindow) {
      const { policy, active } = await getReturnTripPolicy();
      if (active && booking.destination_city) {
        candidates = await findEligibleDrivers(booking.origin_city, booking.wp_vehicle_code, {
          isPrepaidRide: isPrepaid,
          returnTrip: { destinationCity: booking.destination_city, pickupAt: bookingPickupAt(booking) },
        });
      }
      if (candidates.length > 0) {
        isReturnPriority = true;
        exclusiveUntil = new Date(Date.now() + Number(policy.exclusive_window_minutes) * 60 * 1000);
        // The SLA starts once regular drivers get the ride, so escalation never cuts the window short.
        slaDeadline = new Date(exclusiveUntil.getTime() + timeoutMins * 60 * 1000);
      }
    }

    if (!isReturnPriority) {
      candidates = await findEligibleDrivers(booking.origin_city, booking.wp_vehicle_code, {
        isPrepaidRide: isPrepaid,
        excludeOfferedForBooking: options?.releaseReturnWindow ? bookingId : undefined,
      });
    }

    // A regular driver earns the undiscounted payout; the company covers the discount.
    const offeredDriverFare = hasDiscount && !isReturnPriority
      ? Number(booking.driver_payout_amount) + Number(booking.return_discount_driver_share)
      : Number(booking.driver_payout_amount);

    // 3. Update booking status and SLA
    await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'AWAITING_DRIVER',
           driver_broadcast_at = CURRENT_TIMESTAMP,
           sla_deadline_at = $1,
           return_exclusive_until = CASE WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE return_exclusive_until END,
           return_window_released_at = CASE
             WHEN return_discount_amount > 0 AND $4::boolean = false AND return_window_released_at IS NULL THEN CURRENT_TIMESTAMP
             ELSE return_window_released_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [slaDeadline, bookingId, exclusiveUntil, isReturnPriority]
    );

    // 4. Create offer records for each candidate
    let offersCreated = 0;
    for (const cand of candidates) {
      await client.query(
        `INSERT INTO crm_dispatch_offers
         (booking_id, driver_id, offered_driver_fare, offer_status, sent_at, is_return_priority)
         VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP, $4)`,
        [bookingId, cand.driver_id, offeredDriverFare, isReturnPriority]
      );
      offersCreated++;
    }

    return {
      success: true,
      offersCreated,
      slaDeadline,
      candidates,
      isReturnPriority,
      exclusiveUntil,
      offeredDriverFare,
    };
  });
}

/**
 * Bookings whose return-trip exclusive window has ended without a driver accepting.
 * Each is broadcast to regular drivers; returns them with the new candidates for notification.
 */
export async function releaseExpiredReturnWindows(): Promise<Array<{ bookingId: number; result: Awaited<ReturnType<typeof broadcastRideToDrivers>> }>> {
  const due = await query(
    `SELECT id FROM crm_bookings
     WHERE booking_status = 'AWAITING_DRIVER'
       AND assigned_driver_id IS NULL
       AND return_exclusive_until IS NOT NULL
       AND return_exclusive_until <= CURRENT_TIMESTAMP
       AND return_window_released_at IS NULL`
  );
  const released = [];
  for (const row of due.rows) {
    released.push({ bookingId: Number(row.id), result: await broadcastRideToDrivers(Number(row.id), { releaseReturnWindow: true }) });
  }
  return released;
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
  status: 'ASSIGNED' | 'ALREADY_ASSIGNED' | 'OFFER_EXPIRED' | 'NOT_FOUND' | 'NOT_OFFERED';
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

    // Only a driver who was offered this ride may take it. Without this, any driver could accept any
    // waiting booking, including one reserved for a returning driver.
    const offerRes = await client.query(
      `SELECT offer_status FROM crm_dispatch_offers WHERE booking_id = $1 AND driver_id = $2 ORDER BY id DESC LIMIT 1`,
      [bookingId, driverId]
    );
    if (offerRes.rows.length === 0) {
      return {
        success: false,
        status: 'NOT_OFFERED',
        message: `Ride #${booking.booking_code} was not offered to you.`,
      };
    }

    // Check if already assigned
    if (booking.assigned_driver_id && Number(booking.assigned_driver_id) !== Number(driverId)) {
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

    if (offerRes.rows[0].offer_status !== 'PENDING') {
      return {
        success: false,
        status: 'OFFER_EXPIRED',
        booking,
        message: `Your offer for this ride is no longer active.`,
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

    // Decide who funds any return-trip discount before the booking is assigned.
    await settleReturnDiscountFunding(client, booking, driverId);

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

    // Re-read so callers see the payout after any return-trip funding change.
    const fresh = await client.query(
      `SELECT b.*, c.full_name AS customer_name, c.phone AS customer_phone
       FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE b.id = $1`,
      [bookingId]
    );
    Object.assign(booking, fresh.rows[0]);

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
