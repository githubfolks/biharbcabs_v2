import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { getSetting } from './settings';
import { nextDocumentNumber } from './gst-documents';

/**
 * An advance kept on a late customer cancellation is a taxable cancellation charge (per BiharCabs' CA).
 * The charge is recorded when the booking is cancelled, with the receipt voucher that covered the advance.
 * Its tax document (consecutive CC series, GST included in the kept amount) is issued only once
 * cancellation_policy.cancellation_charge_gst_pct is set, because the rate awaits the CA's confirmation.
 */

/** The configured rate, or null while it is not set yet. A set but invalid rate is an error. */
export async function getCancellationChargeGstPct(): Promise<number | null> {
  const raw = (await getSetting<any>('cancellation_policy', {})).cancellation_charge_gst_pct;
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 28) {
    throw new Error('[Settings] cancellation_policy.cancellation_charge_gst_pct is invalid.');
  }
  return pct;
}

/** Record the kept advance as a cancellation charge (inside the cancellation transaction). Once per booking. */
export async function recordCancellationCharge(client: PoolClient, bookingId: number, amount: number): Promise<void> {
  const link = (await client.query(
    `SELECT receipt_voucher_number, (paid_at AT TIME ZONE 'Asia/Kolkata')::date AS receipt_date
     FROM crm_payment_links WHERE booking_id = $1 AND status = 'PAID' ORDER BY id DESC LIMIT 1`,
    [bookingId]
  )).rows[0];
  await client.query(
    `INSERT INTO crm_cancellation_charges (booking_id, amount, receipt_voucher_number, receipt_voucher_date)
     VALUES ($1, $2, $3, $4) ON CONFLICT (booking_id) DO NOTHING`,
    [bookingId, amount, link?.receipt_voucher_number ?? null, link?.receipt_date ?? null]
  );
}

/**
 * Issue the tax document for every charge still waiting for the rate, if the rate is now set.
 * Each charge is locked while it is issued, so two runs cannot number the same charge twice.
 */
export async function issuePendingCancellationDocuments(): Promise<number> {
  const pct = await getCancellationChargeGstPct();
  if (pct === null) return 0;
  const pending = (await query(`SELECT id FROM crm_cancellation_charges WHERE status = 'PENDING_RATE' ORDER BY id`)).rows;
  let issued = 0;
  for (const { id } of pending) {
    const done = await withTransaction(async (client) => {
      const c = (await client.query(
        `SELECT * FROM crm_cancellation_charges WHERE id = $1 AND status = 'PENDING_RATE' FOR UPDATE SKIP LOCKED`,
        [id]
      )).rows[0];
      if (!c) return false;
      const amount = Number(c.amount);
      const taxable = Math.round((amount * 100 / (100 + pct)) * 100) / 100;
      const gst = Math.round((amount - taxable) * 100) / 100;
      const number = await nextDocumentNumber(client, 'CC');
      await client.query(
        `UPDATE crm_cancellation_charges
         SET status = 'ISSUED', gst_pct = $1, taxable_value = $2, gst_amount = $3, invoice_number = $4,
             invoice_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [pct, taxable, gst, number, id]
      );
      return true;
    });
    if (done) issued++;
  }
  return issued;
}

/** Charges still waiting for the rate (for the finance page). */
export async function countPendingCancellationCharges(): Promise<number> {
  return Number((await query(`SELECT COUNT(*) FROM crm_cancellation_charges WHERE status = 'PENDING_RATE'`)).rows[0].count);
}
