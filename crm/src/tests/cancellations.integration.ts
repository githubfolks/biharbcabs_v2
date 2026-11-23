/**
 * Cancellations (no customer advance system): cancelling a booking expires pending driver offers,
 * releases any driver subscription plan reservation, and marks the booking CANCELLED.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { cancelBooking, previewCancellation } from '../lib/cancellations';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');

describe('Booking cancellations (no advance)', () => {
  let customerId: number;
  let bookingId: number;

  after(async () => {
    if (bookingId) await query(`DELETE FROM crm_bookings WHERE id = $1`, [bookingId]);
    if (customerId) await query(`DELETE FROM crm_customers WHERE id = $1`, [customerId]);
    await getDbPool().end();
  });

  it('previews and cancels a booking cleanly with zero refund/forfeit', async () => {
    const cRes = await query(
      `INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Cancel Test') RETURNING id`,
      [`919900${RUN}`]
    );
    customerId = Number(cRes.rows[0].id);
    const bRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, trip_type, origin_city, pickup_address,
        pickup_date, pickup_time, wp_vehicle_code, customer_total_fare,
        booking_status, payment_mode, advance_status
      ) VALUES ($1, $2, 'LOCAL', 'Patna', 'Station', CURRENT_DATE + 1, '10:00', 'SEDAN_PETROL', 500, 'AWAITING_DRIVER', 'FULL_CASH', 'NOT_REQUIRED')
      RETURNING id`,
      [`CNL-${RUN}`, customerId]
    );
    bookingId = Number(bRes.rows[0].id);

    const prev = await previewCancellation(bookingId, 'CUSTOMER');
    assert.strictEqual(prev.decision.refund, 0);
    assert.strictEqual(prev.decision.forfeit, 0);

    const res = await cancelBooking({
      bookingId,
      by: 'CUSTOMER',
      fault: 'CUSTOMER',
      reason: 'Customer changed travel plans',
    });
    assert.strictEqual(res.refundAmount, 0);
    assert.strictEqual(res.forfeitedAmount, 0);
    assert.strictEqual(res.refundStatus, 'NONE');

    const check = (await query(`SELECT booking_status FROM crm_bookings WHERE id = $1`, [bookingId])).rows[0];
    assert.strictEqual(check.booking_status, 'CANCELLED');
  });
});
