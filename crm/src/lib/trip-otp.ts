import crypto from 'crypto';
import { PoolClient } from 'pg';
import { withTransaction } from './db';
import { getSetting } from './settings';
import { recordBookingEvent } from './booking-timeline';

/**
 * Customer OTP to start a trip. Issued when a driver is assigned and sent to the customer; the driver
 * must enter it to start the trip, so a trip (and its settlement) cannot happen without the customer
 * being met. Only a hash is stored. After max_failed_attempts wrong entries the driver cannot start
 * until the customer requests a new code.
 */

export interface TripOtpPolicy {
  otp_digits: number;
  max_failed_attempts: number;
}

const FALLBACK: TripOtpPolicy = { otp_digits: 4, max_failed_attempts: 5 };

export async function getTripOtpPolicy(): Promise<TripOtpPolicy> {
  const raw = await getSetting<any>('trip_otp_policy', {});
  const p = { otp_digits: Number(raw.otp_digits), max_failed_attempts: Number(raw.max_failed_attempts) };
  const valid = Number.isInteger(p.otp_digits) && p.otp_digits >= 4 && p.otp_digits <= 8
    && Number.isInteger(p.max_failed_attempts) && p.max_failed_attempts >= 1 && p.max_failed_attempts <= 20;
  if (!valid) {
    console.error('[Trip OTP] trip_otp_policy is missing or invalid; using 4 digits and 5 attempts.');
    return FALLBACK;
  }
  return p;
}

const hashOtp = (bookingId: number, otp: string) =>
  crypto.createHash('sha256').update(`crm-trip-otp:${bookingId}:${otp}`).digest('hex');

/** Create a new code for the booking (replacing any earlier one) and return it for sending to the customer. */
export async function issueStartOtp(client: PoolClient, bookingId: number, policy?: TripOtpPolicy): Promise<string> {
  const { otp_digits } = policy || (await getTripOtpPolicy());
  const otp = String(crypto.randomInt(0, 10 ** otp_digits)).padStart(otp_digits, '0');
  await client.query(
    `UPDATE crm_bookings
     SET start_otp_hash = $1, start_otp_issued_at = CURRENT_TIMESTAMP, start_otp_failed_attempts = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [hashOtp(bookingId, otp), bookingId]
  );
  await recordBookingEvent(
    {
      bookingId,
      eventType: 'START_OTP_ISSUED',
      actorType: 'SYSTEM',
      actorLabel: 'Trip OTP',
      summary: `Start OTP issued and sent to customer`,
    },
    client
  );
  return otp;
}

export type StartTripResult =
  | { status: 'STARTED'; booking: any }
  | { status: 'WRONG_OTP'; attemptsLeft: number }
  | { status: 'LOCKED'; booking: any; justLocked: boolean }
  | { status: 'NO_OTP'; booking: any }
  | { status: 'NOT_ALLOWED' };

/**
 * Start the trip if the code is right. Only the assigned driver, only while DRIVER_ASSIGNED.
 * Every wrong entry is counted under a row lock, so parallel guesses cannot exceed the limit.
 */
export async function startTripWithOtp(bookingId: number, driverPhone: string, code: string): Promise<StartTripResult> {
  const policy = await getTripOtpPolicy();
  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT b.*, c.phone AS customer_phone
       FROM crm_bookings b
       JOIN crm_customers c ON c.id = b.customer_id
       JOIN crm_drivers d ON d.id = b.assigned_driver_id
       WHERE b.id = $1 AND b.booking_status = 'DRIVER_ASSIGNED' AND (d.phone = $2 OR d.whatsapp_phone = $2)
       FOR UPDATE OF b`,
      [bookingId, driverPhone]
    );
    const b = res.rows[0];
    if (!b) return { status: 'NOT_ALLOWED' };
    if (!b.start_otp_hash) return { status: 'NO_OTP', booking: b };
    if (b.start_otp_failed_attempts >= policy.max_failed_attempts) return { status: 'LOCKED', booking: b, justLocked: false };

    const expected = Buffer.from(b.start_otp_hash, 'hex');
    const given = Buffer.from(hashOtp(bookingId, String(code).trim()), 'hex');
    if (!crypto.timingSafeEqual(expected, given)) {
      const attempts = b.start_otp_failed_attempts + 1;
      await client.query(`UPDATE crm_bookings SET start_otp_failed_attempts = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [attempts, b.id]);
      const locked = attempts >= policy.max_failed_attempts;
      await recordBookingEvent(
        {
          bookingId: Number(b.id),
          eventType: locked ? 'START_OTP_LOCKED' : 'START_OTP_FAILED',
          actorType: 'DRIVER',
          actorId: b.assigned_driver_id ? Number(b.assigned_driver_id) : null,
          actorLabel: driverPhone,
          summary: locked
            ? `Start OTP locked after ${attempts} failed attempts`
            : `Wrong Start OTP entered (attempt ${attempts}/${policy.max_failed_attempts})`,
          metadata: { attempts, maxAttempts: policy.max_failed_attempts },
        },
        client
      );
      if (locked) return { status: 'LOCKED', booking: b, justLocked: true };
      return { status: 'WRONG_OTP', attemptsLeft: policy.max_failed_attempts - attempts };
    }

    const started = await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'TRIP_IN_PROGRESS', trip_started_at = CURRENT_TIMESTAMP,
           start_otp_hash = NULL, start_otp_failed_attempts = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [b.id]
    );
    await recordBookingEvent(
      {
        bookingId: Number(b.id),
        eventType: 'TRIP_STARTED',
        fromStatus: 'DRIVER_ASSIGNED',
        toStatus: 'TRIP_IN_PROGRESS',
        actorType: 'DRIVER',
        actorId: b.assigned_driver_id ? Number(b.assigned_driver_id) : null,
        actorLabel: driverPhone,
        summary: `Trip started after Start OTP verification`,
      },
      client
    );
    return { status: 'STARTED', booking: { ...started.rows[0], customer_phone: b.customer_phone } };
  });
}

/** For "OTP" from a customer: a fresh code for their next assigned trip, or null if none. */
export async function reissueOtpForCustomer(customerPhone: string): Promise<{ bookingCode: string; otp: string } | null> {
  const policy = await getTripOtpPolicy();
  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT b.id, b.booking_code FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id
       WHERE c.phone = $1 AND b.booking_status = 'DRIVER_ASSIGNED'
       ORDER BY b.pickup_date, b.pickup_time LIMIT 1
       FOR UPDATE OF b`,
      [customerPhone.replace(/\D/g, '')]
    );
    const b = res.rows[0];
    if (!b) return null;
    return { bookingCode: b.booking_code, otp: await issueStartOtp(client, Number(b.id), policy) };
  });
}

/** Customer-facing OTP text. */
export function otpMessage(bookingCode: string, otp: string): string {
  return `🔐 Trip OTP for booking #${bookingCode}: *${otp}*\nShare it with your driver only when you are in the cab. Never share it on a call or before the driver arrives.\nLost it? Reply *OTP* for a new one.`;
}
