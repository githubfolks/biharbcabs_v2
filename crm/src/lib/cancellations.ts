import { query, withTransaction } from './db';
import { getSetting } from './settings';
import { bookingPickupAt } from './dispatch-engine';
import { closeLinkAtRazorpay } from './advance-payments';
import { requestRefund } from './refunds';
import { notify, notifyAdmins } from './wa-notify';
import { sendWhatsAppText } from './whatsapp';
import { CANCELLABLE_STATUSES } from './advance-rules';

/**
 * Booking cancellations and advance refunds (agreed policy):
 * - Customer cancels at least free_cancellation_hours before pickup: the online advance is refunded in full.
 * - Customer cancels later: no refund; BiharCabs keeps the advance (also when a driver was assigned).
 * - BiharCabs cancels (no driver, driver no-show, operational): full refund at any time.
 * Refunds go back to the original Razorpay payment. A refund is claimed (SUBMITTING) before Razorpay is
 * called, so a retry can never refund twice; it is booked to the ledger when Razorpay reports it processed.
 */

export { CANCELLABLE_STATUSES };
export type CancellationFault = 'CUSTOMER' | 'BIHARCABS';
const MIN_REASON_LENGTH = 5;

export class CancelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function getFreeCancellationHours(): Promise<number> {
  const raw = await getSetting<any>('cancellation_policy', {});
  const hours = Number(raw.free_cancellation_hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 72) {
    throw new Error('[Settings] cancellation_policy.free_cancellation_hours is missing or invalid.');
  }
  return hours;
}

export interface RefundDecision {
  refund: number;
  forfeit: number;
  /** Plain explanation for the customer and staff. */
  explanation: string;
}

/** The agreed policy, as a pure function. */
export function decideRefund(advancePaid: number, pickupAt: Date, now: Date, fault: CancellationFault, freeHours: number): RefundDecision {
  const advance = Math.max(0, Number(advancePaid) || 0);
  if (advance === 0) return { refund: 0, forfeit: 0, explanation: 'No advance was paid, so there is nothing to refund.' };
  if (fault === 'BIHARCABS') return { refund: advance, forfeit: 0, explanation: `Cancelled by BiharCabs: the ₹${advance.toLocaleString('en-IN')} advance is refunded in full.` };
  const early = pickupAt.getTime() - now.getTime() >= freeHours * 60 * 60 * 1000;
  return early
    ? { refund: advance, forfeit: 0, explanation: `Cancelled ${freeHours}+ hours before pickup: the ₹${advance.toLocaleString('en-IN')} advance is refunded in full.` }
    : { refund: 0, forfeit: advance, explanation: `Cancelled less than ${freeHours} hours before pickup: the ₹${advance.toLocaleString('en-IN')} advance is not refundable.` };
}

/** What cancelling now would mean, for the customer's confirmation message. */
export async function previewCancellation(bookingId: number, fault: CancellationFault): Promise<{ bookingCode: string; decision: RefundDecision }> {
  const b = (await query(`SELECT * FROM crm_bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b) throw new CancelError('Booking not found.', 404);
  if (!CANCELLABLE_STATUSES.includes(b.booking_status)) {
    throw new CancelError(`Booking #${b.booking_code} cannot be cancelled (status ${b.booking_status}).`, 409);
  }
  return { bookingCode: b.booking_code, decision: decideRefund(Number(b.advance_paid), bookingPickupAt(b), new Date(), fault, await getFreeCancellationHours()) };
}

export interface CancelResult {
  bookingCode: string;
  refundAmount: number;
  forfeitedAmount: number;
  /** NONE, PENDING (with Razorpay), PROCESSED, FAILED (finance can retry), or MANUAL (no Razorpay payment to refund). */
  refundStatus: string;
  explanation: string;
}

export async function cancelBooking(input: {
  bookingId: number;
  by: 'CUSTOMER' | 'STAFF';
  fault: CancellationFault;
  reason: string;
  adminId?: number | null;
}): Promise<CancelResult> {
  const reason = String(input.reason || '').trim();
  if (reason.length < MIN_REASON_LENGTH) throw new CancelError(`A cancellation needs a reason of at least ${MIN_REASON_LENGTH} characters.`, 400);
  if (input.fault !== 'CUSTOMER' && input.fault !== 'BIHARCABS') throw new CancelError('fault must be CUSTOMER or BIHARCABS.', 400);
  const freeHours = await getFreeCancellationHours();

  const first = (await query(`SELECT booking_status, booking_code FROM crm_bookings WHERE id = $1`, [input.bookingId])).rows[0];
  if (!first) throw new CancelError('Booking not found.', 404);
  if (!CANCELLABLE_STATUSES.includes(first.booking_status)) {
    throw new CancelError(`Booking #${first.booking_code} cannot be cancelled (status ${first.booking_status}).`, 409);
  }
  // An unpaid advance link must be closed first, so the customer cannot pay after cancelling.
  const openLinks = await query(`SELECT provider_link_id FROM crm_payment_links WHERE booking_id = $1 AND status = 'CREATED'`, [input.bookingId]);
  for (const l of openLinks.rows) {
    try {
      await closeLinkAtRazorpay(l.provider_link_id);
    } catch (err: any) {
      throw new CancelError(err?.message || 'Could not close the payment link at Razorpay; nothing was changed.', err?.status || 502);
    }
  }

  const outcome = await withTransaction(async (client) => {
    const b = (await client.query(
      `SELECT b.*, c.phone AS customer_phone FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE b.id = $1 FOR UPDATE OF b`,
      [input.bookingId]
    )).rows[0];
    if (!CANCELLABLE_STATUSES.includes(b.booking_status)) {
      throw new CancelError(`Booking #${b.booking_code} cannot be cancelled (status ${b.booking_status}).`, 409);
    }
    const decision = decideRefund(Number(b.advance_paid), bookingPickupAt(b), new Date(), input.fault, freeHours);
    const paid = (await client.query(
      `SELECT id, provider_payment_id FROM crm_payment_links WHERE booking_id = $1 AND status = 'PAID' AND provider_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [b.id]
    )).rows[0];

    await client.query(`UPDATE crm_payment_links SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND status = 'CREATED'`, [b.id]);
    await client.query(`UPDATE crm_dispatch_offers SET offer_status = 'EXPIRED', responded_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND offer_status = 'PENDING'`, [b.id]);
    await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = $1, cancelled_by_admin = $2,
           cancellation_fault = $3, cancellation_reason = $4, refund_due_amount = $5, forfeited_amount = $6,
           start_otp_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [input.by, input.adminId ?? null, input.fault, reason, decision.refund, decision.forfeit, b.id]
    );

    let refundId: number | null = null;
    let refundStatus = 'NONE';
    if (decision.refund > 0) {
      if (paid) {
        const r = await client.query(
          `INSERT INTO crm_refunds (booking_id, provider_payment_id, amount_paise, status, reason, requested_by_admin)
           VALUES ($1, $2, $3, 'REQUESTING', $4, $5) RETURNING id`,
          [b.id, paid.provider_payment_id, Math.round(decision.refund * 100), reason, input.adminId ?? null]
        );
        refundId = Number(r.rows[0].id);
        refundStatus = 'PENDING';
      } else {
        // An advance with no Razorpay payment behind it (e.g. a legacy booking): finance must refund it by hand.
        refundStatus = 'MANUAL';
      }
    }
    return { b, decision, refundId, refundStatus };
  });

  const { b, decision } = outcome;
  let refundStatus = outcome.refundStatus;
  if (outcome.refundId) refundStatus = await requestRefund(outcome.refundId);
  if (refundStatus === 'MANUAL' || refundStatus === 'FAILED') {
    await notifyAdmins(`⚠️ Booking #${b.booking_code} was cancelled with ₹${decision.refund.toFixed(2)} to refund, but the refund ${refundStatus === 'MANUAL' ? 'has no Razorpay payment and must be made by hand' : 'request failed'}. See Finance → Refunds.`);
  }
  console.info(`[Cancel] ${b.booking_code} cancelled by ${input.by}${input.adminId ? ` (admin #${input.adminId})` : ''}, fault ${input.fault}; refund ₹${decision.refund}, kept ₹${decision.forfeit}`);

  // Tell the customer, and a driver who was assigned.
  if (b.customer_phone) {
    const refundLine = decision.refund > 0 ? ` ₹${decision.refund.toLocaleString('en-IN')} will be refunded to your original payment method (usually 5-7 working days).` : '';
    const text = `Cancelled. ${decision.explanation}${refundLine}`;
    await notify(b.customer_phone, 'customer_booking_update', {
      params: [`#${b.booking_code}`, text],
      freeform: () => sendWhatsAppText(b.customer_phone, `❌ Booking #${b.booking_code} is cancelled.\n${decision.explanation}${refundLine}`),
    }).catch((err) => console.error('[Cancel] Customer notification failed:', err?.message));
  }
  if (b.assigned_driver_id) {
    const d = (await query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [b.assigned_driver_id])).rows[0];
    const phone = d?.whatsapp_phone || d?.phone;
    if (phone) {
      const text = `Ride #${b.booking_code} has been cancelled. You no longer need to do this trip.`;
      await notify(phone, 'driver_account_notice', { params: [text], freeform: () => sendWhatsAppText(phone, `❌ ${text}`) })
        .catch((err) => console.error('[Cancel] Driver notification failed:', err?.message));
    }
  }

  return { bookingCode: b.booking_code, refundAmount: decision.refund, forfeitedAmount: decision.forfeit, refundStatus, explanation: decision.explanation };
}
