import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { createRefund } from './razorpay';
import { nextDocumentNumber } from './gst-documents';
import { inheritedTax, taxColumns } from './place-of-supply';

/**
 * Advance refunds through Razorpay (see cancellations.ts for when a refund is due). A refund is claimed
 * (SUBMITTING) before Razorpay is called, so a retry can never refund twice, and is booked to the ledger
 * once Razorpay reports it processed.
 */

export class RefundError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Send (or resend) a refund to Razorpay. The refund is claimed first (REQUESTING/FAILED -> SUBMITTING),
 * so two attempts can never both reach Razorpay. A refund stuck in SUBMITTING (the process stopped
 * mid-request) is not retried automatically: check the Razorpay dashboard first.
 */
export async function requestRefund(refundId: number): Promise<string> {
  const claimed = (await query(
    `UPDATE crm_refunds SET status = 'SUBMITTING', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('REQUESTING', 'FAILED') RETURNING *`,
    [refundId]
  )).rows[0];
  if (!claimed) {
    const current = (await query(`SELECT status FROM crm_refunds WHERE id = $1`, [refundId])).rows[0];
    if (!current) throw new RefundError('Refund not found.', 404);
    return current.status;
  }
  try {
    const r = await createRefund({
      paymentId: claimed.provider_payment_id,
      amountPaise: claimed.amount_paise,
      receipt: `refund-${claimed.id}`,
      notes: { booking_id: String(claimed.booking_id), refund_id: String(claimed.id) },
    });
    return withTransaction(async (client) => {
      if (r.status === 'processed') {
        await markRefundProcessed(client, Number(claimed.id), r.id);
        return 'PROCESSED';
      }
      await client.query(
        `UPDATE crm_refunds SET status = 'PENDING', provider_refund_id = $1, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = 'SUBMITTING'`,
        [r.id, claimed.id]
      );
      return 'PENDING';
    });
  } catch (err: any) {
    await query(`UPDATE crm_refunds SET status = 'FAILED', last_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [String(err?.message || err).slice(0, 500), claimed.id]);
    console.error(`[Refund] Request failed for refund #${claimed.id}:`, err?.message);
    return 'FAILED';
  }
}

/** Mark a refund processed and book it to the ledger, once. */
export async function markRefundProcessed(client: PoolClient, refundId: number, providerRefundId: string): Promise<boolean> {
  const r = (await client.query(
    `UPDATE crm_refunds SET status = 'PROCESSED', provider_refund_id = COALESCE(provider_refund_id, $2), processed_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status <> 'PROCESSED' RETURNING *`,
    [refundId, providerRefundId]
  )).rows[0];
  if (!r) return false;
  const b = (await client.query(`SELECT customer_id, booking_code FROM crm_bookings WHERE id = $1`, [r.booking_id])).rows[0];

  // Refund Voucher (per CA): the advance was covered by a Receipt Voucher, not a tax invoice, so the refund
  // voucher quotes the receipt voucher's number and date, and records the GST it reverses.
  const link = (await client.query(
    `SELECT receipt_voucher_number, gst_amount, amount_paise, (paid_at AT TIME ZONE 'Asia/Kolkata')::date AS receipt_date,
            supplier_state_code, place_of_supply_code
     FROM crm_payment_links WHERE booking_id = $1 AND provider_payment_id = $2 ORDER BY id DESC LIMIT 1`,
    [r.booking_id, r.provider_payment_id]
  )).rows[0];
  const voucherNumber = await nextDocumentNumber(client, 'RF');
  const gstReversed = link?.gst_amount != null && Number(link.amount_paise) > 0
    ? Math.round((Number(link.gst_amount) * r.amount_paise / Number(link.amount_paise)) * 100) / 100
    : null;
  // The same place of supply and split as the receipt voucher it reverses (Rule 51); waits if that has none yet.
  const tax = gstReversed === null ? null : inheritedTax(link, gstReversed);
  await client.query(
    `UPDATE crm_refunds
     SET refund_voucher_number = $1, refund_voucher_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
         receipt_voucher_number = $2, receipt_voucher_date = $3, gst_reversed = $4,
         supplier_state_code = $6, place_of_supply_code = $7, place_of_supply_basis = $8,
         cgst_amount = $9, sgst_amount = $10, igst_amount = $11
     WHERE id = $5`,
    [voucherNumber, link?.receipt_voucher_number ?? null, link?.receipt_date ?? null, gstReversed, r.id, ...taxColumns(tax)]
  );
  if (!link?.receipt_voucher_number) {
    console.error(`[Refund] Refund voucher ${voucherNumber} for ${b.booking_code} has no receipt voucher to quote; finance must link it by hand.`);
  }

  await client.query(
    `INSERT INTO crm_payments_ledger (booking_id, customer_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
     VALUES ($1, $2, 'CUSTOMER_ADVANCE_REFUND', 'DEBIT', 'RAZORPAY', $3, $4, $5)`,
    [r.booking_id, b.customer_id, r.amount_paise / 100, providerRefundId,
     `Advance refund for cancelled booking ${b.booking_code}; refund voucher ${voucherNumber} against receipt voucher ${link?.receipt_voucher_number ?? 'n/a'}; GST reversed ₹${gstReversed ?? 'n/a'}`]
  );
  return true;
}

/** Refunds that need attention or are still with Razorpay, newest first. */
export async function listOpenRefunds() {
  const res = await query(
    `SELECT r.id, r.status, r.amount_paise, r.reason, r.last_error, r.provider_refund_id, r.created_at, b.booking_code
     FROM crm_refunds r JOIN crm_bookings b ON b.id = r.booking_id
     WHERE r.status <> 'PROCESSED'
     ORDER BY r.created_at DESC LIMIT 100`
  );
  return res.rows.map((r) => ({ ...r, amount: r.amount_paise / 100 }));
}
