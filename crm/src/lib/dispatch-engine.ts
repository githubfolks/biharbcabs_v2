import { query, withTransaction } from './db';
import {
  getDispatchSlaTimeoutMinutes,
  getAdminContacts,
  getDriverRatingPolicy,
  getDriverRideGapHours,
  getRevenueProtectionPolicy,
  getReturnTripPolicy,
  getSplitRules,
} from './settings';
import { PoolClient } from 'pg';
import { settleReturnDiscountFunding } from './return-trips';
import { issueStartOtp } from './trip-otp';
import { FareSplit, splitFare } from './fare-split';

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

export type RideSplitCalculation = FareSplit;

/** Split a fare with the current settings (see fare-split.ts for the GST treatment). */
export async function calculateRideSplitWithTaxes(customerTotalFare: number): Promise<RideSplitCalculation> {
  return splitFare(customerTotalFare, await getSplitRules());
}

/** Statuses in which a booking is still waiting for its driver. */
export const ASSIGNABLE_STATUSES = ['AWAITING_DRIVER', 'ESCALATED_NO_DRIVER', 'CONFIRMED_AWAITING_DRIVER'];

/** A ride BiharCabs has been paid for in full: drivers restricted for dues may take it (it pays their debt down). */
export function isPrepaidBooking(b: { payment_status?: string; advance_paid?: any; customer_total_fare?: any }): boolean {
  return b.payment_status === 'PAID_IN_FULL' || Number(b.advance_paid || 0) >= Number(b.customer_total_fare || 0);
}

/** What this ride does to the driver's wallet when settled, counted only when it adds to what they owe. */
export function rideShortfall(b: { advance_paid?: any; commission_amount?: any }): number {
  return Math.min(0, Number(b.advance_paid || 0) - Number(b.commission_amount || 0));
}

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

interface EligibilityQuery {
  vehicleCode: string;
  isPrepaid: boolean;
  /** This ride's shortfall (rideShortfall), added to the driver's projected wallet. */
  rideShortfall: number;
  /** The booking being dispatched: its own shortfall is not counted twice as an "open ride". */
  bookingId?: number;
  /** This ride's pickup, checked against the pickups of rides the driver already holds. */
  pickupAt: Date;
}

/**
 * The one definition of the dispatch rules. Every rule is a column, so broadcast selection (all true)
 * and single-driver checks (which failed) cannot drift apart:
 *   status, available, rating, licence, a verified in-date vehicle of the cab type, and credit:
 *   wallet + shortfall of the driver's other open rides + this ride's shortfall must stay within the
 *   driver's tier credit limit (not applied to fully prepaid rides, which reduce what they owe), and
 *   schedule: no other ride they hold (assigned or in progress) with a pickup less than
 *   driver_ride_gap_hours before or after this one (bookings have no end time, so a fixed gap).
 * One row per driver (their best vehicle of the type).
 */
async function eligibilityRows(db: Db, q: EligibilityQuery, filter: { sql: string; params: any[] }): Promise<any[]> {
  const ratingPolicy = await getDriverRatingPolicy();
  const p = await getRevenueProtectionPolicy();
  if (!(q.pickupAt instanceof Date) || Number.isNaN(q.pickupAt.getTime())) {
    throw new Error('Dispatch rules need the ride\'s pickup time');
  }
  const params: any[] = [
    q.vehicleCode,                            // $1
    ratingPolicy.min_dispatch_rating,         // $2
    q.isPrepaid,                              // $3
    q.rideShortfall,                          // $4
    q.bookingId ?? 0,                         // $5
    p.elite_min_rating,                       // $6
    p.elite_min_trips,                        // $7
    p.dynamic_credit_limits.elite,            // $8
    p.standard_min_rating,                    // $9
    p.dynamic_credit_limits.standard,         // $10
    p.dynamic_credit_limits.probation_or_new, // $11
    q.pickupAt,                               // $12
    await getDriverRideGapHours(),            // $13
  ];
  const offset = params.length;
  const filterSql = filter.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
  params.push(...filter.params);

  const res = await db.query(
    `WITH rules AS (
       SELECT
         d.id AS driver_id, d.full_name, d.phone, d.whatsapp_phone, d.base_city, d.wallet_balance, d.rating,
         v.id AS vehicle_id, v.model_name, v.registration_no,
         (CASE WHEN $3::boolean THEN d.onboarding_status IN ('APPROVED_ACTIVE', 'RESTRICTED_DIGITAL_ONLY')
               ELSE d.onboarding_status = 'APPROVED_ACTIVE' END) AS status_ok,
         d.is_available AS available_ok,
         d.rating >= ($2::numeric) AS rating_ok,
         (d.license_expiry IS NULL OR d.license_expiry >= CURRENT_DATE) AS licence_ok,
         (v.id IS NOT NULL AND v.is_verified = true
           AND (v.insurance_expiry IS NULL OR v.insurance_expiry >= CURRENT_DATE)
           AND (v.fitness_expiry IS NULL OR v.fitness_expiry >= CURRENT_DATE)
           AND (v.permit_expiry IS NULL OR v.permit_expiry >= CURRENT_DATE)) AS vehicle_ok,
         (d.wallet_balance
           + COALESCE((SELECT SUM(LEAST(0, ob.advance_paid - ob.commission_amount)) FROM crm_bookings ob
                       WHERE ob.assigned_driver_id = d.id AND ob.id <> $5::bigint
                         AND ob.booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS')), 0)
           + ($4::numeric)) AS projected_wallet,
         (CASE WHEN d.rating >= ($6::numeric) AND d.total_trips_completed >= ($7::integer) THEN ($8::numeric)
               WHEN d.rating >= ($9::numeric) THEN ($10::numeric)
               ELSE ($11::numeric) END) AS credit_limit,
         (SELECT sb.booking_code FROM crm_bookings sb
          WHERE sb.assigned_driver_id = d.id AND sb.id <> $5::bigint
            AND sb.booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS')
            AND ABS(EXTRACT(EPOCH FROM (((sb.pickup_date + sb.pickup_time) AT TIME ZONE 'Asia/Kolkata') - $12::timestamptz)))
                < ($13::numeric) * 3600
          ORDER BY sb.pickup_date, sb.pickup_time LIMIT 1) AS clashing_booking_code,
         ($13::numeric) AS ride_gap_hours
       FROM crm_drivers d
       LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id AND LOWER(v.wp_vehicle_code) = LOWER($1)
       WHERE ${filterSql}
     ),
     best AS (
       SELECT DISTINCT ON (driver_id) *, ($3::boolean OR projected_wallet >= -credit_limit) AS credit_ok,
              (clashing_booking_code IS NULL) AS schedule_ok
       FROM rules
       ORDER BY driver_id, vehicle_ok DESC, vehicle_id
     )
     SELECT * FROM best`,
    params
  );
  return res.rows;
}

const RULES: Array<[string, string]> = [
  ['status_ok', 'account is not active for this ride'],
  ['available_ok', 'driver is marked unavailable'],
  ['rating_ok', 'rating is below the dispatch minimum'],
  ['licence_ok', 'driving licence has expired'],
  ['vehicle_ok', 'no verified cab of this type with valid insurance, fitness and permit'],
  ['credit_ok', 'this ride would take them past their credit limit'],
  ['schedule_ok', 'already has a ride with a pickup too close to this one'],
];

export function failedRules(row: any): string[] {
  return RULES.filter(([col]) => row[col] !== true).map(([col, reason]) =>
    col === 'schedule_ok' && row.clashing_booking_code
      ? `already has ride #${row.clashing_booking_code} with a pickup less than ${Number(row.ride_gap_hours)} hours from this one`
      : reason
  );
}

/**
 * Find all active, verified, compliant drivers eligible for a booking.
 * - Base city matches origin city (or, for return trips, drivers returning from it).
 * - Every rule in eligibilityRows passes.
 * Prepaid rides put drivers with dues first, so the ride pays their debt down.
 */
export async function findEligibleDrivers(
  originCity: string,
  vehicleCode: string,
  options: {
    isPrepaidRide?: boolean;
    /** This ride's shortfall for the credit check (see rideShortfall); 0 when not yet known. */
    rideShortfall?: number;
    /** The booking being dispatched, so it is not also counted among the driver's open rides. */
    bookingId?: number;
    /** Only drivers returning from originCity to this city, whose return lasts until the pickup. */
    returnTrip?: { destinationCity: string; pickupAt: Date };
    /** Leave out drivers who already have an offer for this booking. */
    excludeOfferedForBooking?: number;
  } & (
    /** This ride's pickup, for the gap between a driver's rides (a return trip's pickup counts). */
    { pickupAt: Date } | { returnTrip: { destinationCity: string; pickupAt: Date }; pickupAt?: Date }
  )
): Promise<DispatchCandidate[]> {
  const pickupAt = options.pickupAt ?? options.returnTrip?.pickupAt;
  if (!pickupAt) throw new Error('findEligibleDrivers needs the ride\'s pickup time');
  const isPrepaid = options?.isPrepaidRide ?? false;
  const filterParams: any[] = [originCity];
  let filterSql = options?.returnTrip
    ? `EXISTS (SELECT 1 FROM crm_driver_returns r
               WHERE r.driver_id = d.id AND r.ended_at IS NULL
                 AND r.expires_at > CURRENT_TIMESTAMP AND r.expires_at >= $3
                 AND LOWER(r.from_city) = LOWER($1) AND LOWER(r.to_city) = LOWER($2))`
    : `LOWER(d.base_city) = LOWER($1)`;
  if (options?.returnTrip) filterParams.push(options.returnTrip.destinationCity, options.returnTrip.pickupAt);
  if (options?.excludeOfferedForBooking) {
    filterParams.push(options.excludeOfferedForBooking);
    filterSql += ` AND NOT EXISTS (SELECT 1 FROM crm_dispatch_offers o WHERE o.driver_id = d.id AND o.booking_id = $${filterParams.length})`;
  }

  const rows = await eligibilityRows(
    { query },
    { vehicleCode, isPrepaid, rideShortfall: options?.rideShortfall ?? 0, bookingId: options?.bookingId, pickupAt },
    { sql: filterSql, params: filterParams }
  );
  return rows
    .filter((r) => failedRules(r).length === 0)
    .sort((a, b) =>
      (isPrepaid ? Number(Number(a.wallet_balance) >= 0) - Number(Number(b.wallet_balance) >= 0) : 0) ||
      Number(b.rating) - Number(a.rating) ||
      Number(b.wallet_balance) - Number(a.wallet_balance)
    )
    .map((r) => ({
      driver_id: r.driver_id, full_name: r.full_name, phone: r.phone, whatsapp_phone: r.whatsapp_phone, base_city: r.base_city,
      wallet_balance: r.wallet_balance, rating: r.rating, vehicle_id: r.vehicle_id, model_name: r.model_name, registration_no: r.registration_no,
    }));
}

/**
 * Check one driver against the dispatch rules for a booking, at the moment of acceptance or a staff
 * assignment. Call inside the transaction with the driver row locked, so the credit check sees the
 * driver's other rides as they are. Base city is not checked: the driver was offered the ride, or
 * staff chose them.
 */
export async function checkDriverEligibility(
  db: Db,
  driverId: number,
  booking: { id: number; wp_vehicle_code: string; pickup_date: any; pickup_time: any; payment_status?: string; advance_paid?: any; customer_total_fare?: any; commission_amount?: any }
): Promise<{ eligible: boolean; reasons: string[]; vehicleId: number | null }> {
  const rows = await eligibilityRows(
    db,
    {
      vehicleCode: booking.wp_vehicle_code, isPrepaid: isPrepaidBooking(booking), rideShortfall: rideShortfall(booking),
      bookingId: Number(booking.id), pickupAt: bookingPickupAt(booking),
    },
    { sql: 'd.id = $1', params: [driverId] }
  );
  const row = rows[0];
  if (!row) return { eligible: false, reasons: ['driver not found'], vehicleId: null };
  const reasons = failedRules(row);
  return { eligible: reasons.length === 0, reasons, vehicleId: row.vehicle_ok ? Number(row.vehicle_id) : null };
}

/** Pickup moment of a stored booking, read as India time. */
export function bookingPickupAt(booking: any): Date {
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
/** Bookings in these statuses still owe the advance (or lost it) and must never reach drivers. */
export const UNPAID_ADVANCE_STATUSES = ['AWAITING_ADVANCE', 'ADVANCE_EXPIRED', 'ADVANCE_LINK_FAILED'];

export function assertAdvanceSettled(booking: { booking_code?: string; booking_status: string }): void {
  if (UNPAID_ADVANCE_STATUSES.includes(booking.booking_status)) {
    throw new Error(`Booking ${booking.booking_code || ''} cannot be dispatched: advance not paid (status ${booking.booking_status}).`);
  }
}

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
    assertAdvanceSettled(booking);
    // Broadcasting resets the booking to AWAITING_DRIVER, so it is only allowed while the booking waits for a
    // driver; otherwise a cancelled, assigned or finished booking would be reopened.
    if (!ASSIGNABLE_STATUSES.includes(booking.booking_status)) {
      throw new Error(`Booking ${booking.booking_code} cannot be broadcast (status ${booking.booking_status}).`);
    }
    let slaDeadline = new Date(Date.now() + timeoutMins * 60 * 1000);

    // 2. Find eligible drivers (prepaid rides cross-absorb debt from digital-only restricted drivers)
    const isPrepaid = isPrepaidBooking(booking);
    // The credit check counts this ride's shortfall (and each driver's other open rides).
    const shortfall = rideShortfall(booking);
    const hasDiscount = Number(booking.return_discount_amount) > 0 && !booking.return_discount_funded_by;

    let candidates: DispatchCandidate[] = [];
    let isReturnPriority = false;
    let exclusiveUntil: Date | null = null;

    if (hasDiscount && !booking.return_window_released_at && !options?.releaseReturnWindow) {
      const { policy, active } = await getReturnTripPolicy();
      if (active && booking.destination_city) {
        candidates = await findEligibleDrivers(booking.origin_city, booking.wp_vehicle_code, {
          isPrepaidRide: isPrepaid,
          rideShortfall: shortfall,
          bookingId,
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
        rideShortfall: shortfall,
        bookingId,
        pickupAt: bookingPickupAt(booking),
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
  status: 'ASSIGNED' | 'ALREADY_ASSIGNED' | 'OFFER_EXPIRED' | 'NOT_FOUND' | 'NOT_OFFERED' | 'NOT_ELIGIBLE';
  booking?: BookingDetails;
  /** On ASSIGNED: the customer's trip-start OTP, to send to the customer only. */
  startOtp?: string;
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

    // Re-check the driver now, not just when the offer went out: they may have been suspended, gone past
    // their credit limit with other rides, or had documents expire since. The driver row is locked so two
    // rides accepted at once are both counted.
    await client.query(`SELECT id FROM crm_drivers WHERE id = $1 FOR UPDATE`, [driverId]);
    const eligibility = await checkDriverEligibility(client, driverId, booking);
    if (!eligibility.eligible) {
      await client.query(
        `UPDATE crm_dispatch_offers SET offer_status = 'INELIGIBLE', responded_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND driver_id = $2 AND offer_status = 'PENDING'`,
        [bookingId, driverId]
      );
      return {
        success: false,
        status: 'NOT_ELIGIBLE',
        booking,
        message: `You cannot take ride #${booking.booking_code} right now: ${eligibility.reasons.join('; ')}. Contact BiharCabs support if this is wrong.`,
      };
    }
    const vehicleId = eligibility.vehicleId;

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

    // The customer's code for starting the trip, issued with the assignment.
    const startOtp = await issueStartOtp(client, bookingId);

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
      startOtp,
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
