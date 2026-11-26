import { DomainError } from './route-errors';
import { query, withTransaction } from './db';
import { notify } from './wa-notify';
import { sendWhatsAppText } from './whatsapp';
import { CANCELLABLE_STATUSES } from './booking-rules';
import { releasePlanReservation } from './driver-plans';
import { recordBookingEvent } from './booking-timeline';

/**
 * Booking cancellations (no customer advance system).
 * Cancels the booking, expires pending driver offers, releases any driver subscription plan
 * reservation, and notifies the customer and assigned driver.
 */

export { CANCELLABLE_STATUSES };
export type CancellationFault = 'CUSTOMER' | 'BIHARCABS';
const MIN_REASON_LENGTH = 5;

export class CancelError extends DomainError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export interface RefundDecision {
  refund: number;
  forfeit: number;
  explanation: string;
}

export interface CancelResult {
  bookingCode: string;
  refundAmount: number;
  forfeitedAmount: number;
  refundStatus: string;
  explanation: string;
}

export async function previewCancellation(
  bookingId: number,
  fault: CancellationFault
): Promise<{ bookingCode: string; decision: RefundDecision }> {
  const b = (await query(`SELECT booking_code, booking_status FROM crm_bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b) throw new CancelError('Booking not found.', 404);
  if (!CANCELLABLE_STATUSES.includes(b.booking_status)) {
    throw new CancelError(`Booking #${b.booking_code} cannot be cancelled (status ${b.booking_status}).`, 409);
  }
  const explanation =
    fault === 'BIHARCABS'
      ? 'Booking will be cancelled by BiharCabs with no cancellation charge.'
      : 'Booking will be cancelled with no online payment to refund.';
  return { bookingCode: b.booking_code, decision: { refund: 0, forfeit: 0, explanation } };
}

export async function cancelBooking(input: {
  bookingId: number;
  by: 'CUSTOMER' | 'STAFF';
  fault: CancellationFault;
  reason: string;
  adminId?: number | null;
}): Promise<CancelResult> {
  const reason = String(input.reason || '').trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new CancelError(`A cancellation needs a reason of at least ${MIN_REASON_LENGTH} characters.`, 400);
  }
  if (input.fault !== 'CUSTOMER' && input.fault !== 'BIHARCABS') {
    throw new CancelError('fault must be CUSTOMER or BIHARCABS.', 400);
  }

  const outcome = await withTransaction(async (client) => {
    const b = (
      await client.query(
        `SELECT b.*, c.phone AS customer_phone
         FROM crm_bookings b
         JOIN crm_customers c ON c.id = b.customer_id
         WHERE b.id = $1 FOR UPDATE OF b`,
        [input.bookingId]
      )
    ).rows[0];
    if (!b) throw new CancelError('Booking not found.', 404);
    if (!CANCELLABLE_STATUSES.includes(b.booking_status)) {
      throw new CancelError(`Booking #${b.booking_code} cannot be cancelled (status ${b.booking_status}).`, 409);
    }

    await releasePlanReservation(client, Number(b.id), `Booking #${b.booking_code} cancelled`);
    await client.query(
      `UPDATE crm_dispatch_offers SET offer_status = 'EXPIRED', responded_at = CURRENT_TIMESTAMP
       WHERE booking_id = $1 AND offer_status = 'PENDING'`,
      [b.id]
    );
    await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = $1, cancelled_by_admin = $2,
           cancellation_fault = $3, cancellation_reason = $4, refund_due_amount = 0, forfeited_amount = 0,
           start_otp_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [input.by, input.adminId ?? null, input.fault, reason, b.id]
    );

    await recordBookingEvent(
      {
        bookingId: Number(b.id),
        eventType: 'CANCELLED',
        fromStatus: b.booking_status,
        toStatus: 'CANCELLED',
        actorType: input.by === 'STAFF' ? 'ADMIN' : 'CUSTOMER',
        actorId: input.adminId ?? null,
        actorLabel: input.by === 'STAFF' && input.adminId ? `Admin #${input.adminId}` : input.by,
        summary: `Booking cancelled (${input.fault}): ${reason}`,
        metadata: { by: input.by, fault: input.fault, reason },
      },
      client
    );

    return b;
  });

  const explanation =
    input.fault === 'BIHARCABS'
      ? 'Cancelled by BiharCabs.'
      : 'Cancelled as requested.';

  console.info(`[Cancel] ${outcome.booking_code} cancelled by ${input.by}${input.adminId ? ` (admin #${input.adminId})` : ''}, fault ${input.fault}`);

  if (outcome.customer_phone) {
    await notify(outcome.customer_phone, 'customer_booking_update', {
      params: [`#${outcome.booking_code}`, `Cancelled. ${explanation}`],
      freeform: () => sendWhatsAppText(outcome.customer_phone, `❌ Booking #${outcome.booking_code} is cancelled.\n${explanation}`),
    }).catch((err) => console.error('[Cancel] Customer notification failed:', err?.message));
  }

  if (outcome.assigned_driver_id) {
    const d = (await query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [outcome.assigned_driver_id])).rows[0];
    const phone = d?.whatsapp_phone || d?.phone;
    if (phone) {
      const text = `Ride #${outcome.booking_code} has been cancelled. You no longer need to do this trip.`;
      await notify(phone, 'driver_account_notice', {
        params: [text],
        freeform: () => sendWhatsAppText(phone, `❌ ${text}`),
      }).catch((err) => console.error('[Cancel] Driver notification failed:', err?.message));
    }
  }

  return {
    bookingCode: outcome.booking_code,
    refundAmount: 0,
    forfeitedAmount: 0,
    refundStatus: 'NONE',
    explanation,
  };
}
