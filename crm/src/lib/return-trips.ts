import { PoolClient } from 'pg';
import { query } from './db';

/**
 * Driver return-trip status. A driver who drops a customer away from home can mark
 * "returning", which gives them priority for rides from that city back to their base city.
 */

export interface DriverReturn {
  id: number;
  driver_id: number;
  from_city: string;
  to_city: string;
  started_at: Date;
  expires_at: Date;
}

type Queryable = Pick<PoolClient, 'query'>;
const db: Queryable = { query: ((text: string, params?: any[]) => query(text, params)) as any };

/** Start (or restart) a driver's return. Any earlier active return is closed first. */
export async function startDriverReturn(
  driverId: number,
  fromCity: string,
  toCity: string,
  hours: number,
  sourceBookingId?: number,
  client: Queryable = db
): Promise<DriverReturn> {
  await endDriverReturn(driverId, 'REPLACED', client);
  const res = await client.query(
    `INSERT INTO crm_driver_returns (driver_id, from_city, to_city, source_booking_id, expires_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + ($5::numeric * INTERVAL '1 hour'))
     RETURNING id, driver_id, from_city, to_city, started_at, expires_at`,
    [driverId, fromCity, toCity, sourceBookingId ?? null, hours]
  );
  return res.rows[0];
}

/** End a driver's active return, if any. Returns whether one was ended. */
export async function endDriverReturn(driverId: number, reason: string, client: Queryable = db): Promise<boolean> {
  const res = await client.query(
    `UPDATE crm_driver_returns SET ended_at = CURRENT_TIMESTAMP, end_reason = $2
     WHERE driver_id = $1 AND ended_at IS NULL`,
    [driverId, reason]
  );
  return (res.rowCount ?? 0) > 0;
}

/** The driver's active, unexpired return, or null. */
export async function getActiveReturn(driverId: number, client: Queryable = db): Promise<DriverReturn | null> {
  const res = await client.query(
    `SELECT id, driver_id, from_city, to_city, started_at, expires_at FROM crm_driver_returns
     WHERE driver_id = $1 AND ended_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
    [driverId]
  );
  return res.rows[0] || null;
}

/** Close returns whose time has run out, so the record shows why they ended. */
export async function expireDriverReturns(): Promise<number> {
  const res = await query(
    `UPDATE crm_driver_returns SET ended_at = expires_at, end_reason = 'EXPIRED'
     WHERE ended_at IS NULL AND expires_at <= CURRENT_TIMESTAMP`
  );
  return res.rowCount ?? 0;
}

/**
 * When a discounted booking is taken by a driver who was not offered it as a returning driver,
 * the company absorbs the whole discount and the driver is paid as if there were no discount.
 * When a returning driver takes it, the agreed split stands and their return ends.
 * Runs inside the caller's transaction, with the booking row already locked.
 */
export async function settleReturnDiscountFunding(client: Queryable, booking: any, driverId: number): Promise<'RETURN_DRIVER' | 'COMPANY' | null> {
  if (!(Number(booking.return_discount_amount) > 0) || booking.return_discount_funded_by) return null;

  const offer = await client.query(
    `SELECT is_return_priority FROM crm_dispatch_offers WHERE booking_id = $1 AND driver_id = $2 ORDER BY id DESC LIMIT 1`,
    [booking.id, driverId]
  );
  const returning = offer.rows[0]?.is_return_priority === true && (await getActiveReturn(driverId, client)) !== null;

  if (returning) {
    await client.query(`UPDATE crm_bookings SET return_discount_funded_by = 'RETURN_DRIVER', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.id]);
    await endDriverReturn(driverId, 'ACCEPTED_RETURN_RIDE', client);
    return 'RETURN_DRIVER';
  }

  await client.query(
    `UPDATE crm_bookings
     SET driver_payout_amount = driver_payout_amount + return_discount_driver_share,
         commission_amount = commission_amount - return_discount_driver_share,
         return_discount_company_share = return_discount_amount,
         return_discount_driver_share = 0,
         return_discount_funded_by = 'COMPANY',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [booking.id]
  );
  return 'COMPANY';
}
