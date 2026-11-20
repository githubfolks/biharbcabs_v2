import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { getSetting } from './settings';
import { nextDocumentNumber } from './gst-documents';
import { documentTaxSplit, inheritedTax, taxColumns } from './place-of-supply';

/**
 * An advance kept on a late customer cancellation is a taxable cancellation charge (per BiharCabs' CA).
 * The charge is recorded when the booking is cancelled, with the receipt voucher that covered the advance.
 * Its tax document (consecutive CC series, GST included in the kept amount) is issued at
 * cancellation_policy.cancellation_charge_gst_pct: 5%, the rate of the ride itself (per CA); without a
 * rate, documents wait.
 *
 * GST on the advance was already paid at 18% when it was received. Per CA, the excess cannot be adjusted
 * in GSTR-3B; it is reclaimed with Form GST RFD-01 (Section 54, CGST Act). Each issued charge records the
 * GST paid at receipt on the kept amount and the excess, for that claim.
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
      // GST paid at receipt on the part of the advance kept (as refunds reverse it). Unknown when the
      // receipt voucher has no GST recorded: then nothing is claimed rather than a guessed amount.
      const link = c.receipt_voucher_number
        ? (await client.query(`SELECT gst_amount, amount_paise, supplier_state_code, place_of_supply_code FROM crm_payment_links WHERE receipt_voucher_number = $1`, [c.receipt_voucher_number])).rows[0]
        : undefined;
      // Place of supply: its receipt voucher's; worked out for the booking only when there is no voucher.
      let tax = inheritedTax(link, gst);
      if (!c.receipt_voucher_number) {
        const bk = (await client.query(
          `SELECT b.origin_city, c.gstin FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE b.id = $1`, [c.booking_id]
        )).rows[0];
        tax = await documentTaxSplit(bk?.gstin ?? null, bk?.origin_city ?? null, gst);
      }
      const advanceGstPaid = link?.gst_amount != null && Number(link.amount_paise) > 0
        ? Math.round((Number(link.gst_amount) * amount * 100 / Number(link.amount_paise)) * 100) / 100
        : null;
      const excessGst = advanceGstPaid === null ? null : Math.round((advanceGstPaid - gst) * 100) / 100;
      const number = await nextDocumentNumber(client, 'CC');
      await client.query(
        `UPDATE crm_cancellation_charges
         SET status = 'ISSUED', gst_pct = $1, taxable_value = $2, gst_amount = $3, invoice_number = $4,
             invoice_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
             advance_gst_paid = $6, excess_gst = $7,
             supplier_state_code = $8, place_of_supply_code = $9, place_of_supply_basis = $10,
             cgst_amount = $11, sgst_amount = $12, igst_amount = $13, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [pct, taxable, gst, number, id, advanceGstPaid, excessGst, ...taxColumns(tax)]
      );
      return true;
    });
    if (done) issued++;
  }
  return issued;
}

export interface ExcessGstMonth {
  /** Month the cancellation charge document was issued (India time), YYYY-MM. */
  month: string;
  charges: number;
  advanceGstPaid: number;
  gstDue: number;
  /** To reclaim with Form GST RFD-01. */
  excessGst: number;
  /** Charges whose GST paid at receipt is not recorded, so their excess is not known. */
  unknown: number;
}

/** Excess GST on kept advances, per month of issue, for the Form GST RFD-01 claim. Newest first. */
export async function excessGstByMonth(): Promise<ExcessGstMonth[]> {
  const r = await query(
    `SELECT to_char(invoice_date, 'YYYY-MM') AS month, COUNT(*)::int AS charges,
            COALESCE(SUM(advance_gst_paid), 0) AS advance_gst_paid,
            COALESCE(SUM(gst_amount) FILTER (WHERE advance_gst_paid IS NOT NULL), 0) AS gst_due,
            COALESCE(SUM(excess_gst), 0) AS excess_gst,
            (COUNT(*) FILTER (WHERE advance_gst_paid IS NULL))::int AS unknown
     FROM crm_cancellation_charges WHERE status = 'ISSUED'
     GROUP BY 1 ORDER BY 1 DESC`
  );
  return r.rows.map((x) => ({
    month: x.month, charges: x.charges, advanceGstPaid: Number(x.advance_gst_paid), gstDue: Number(x.gst_due),
    excessGst: Number(x.excess_gst), unknown: x.unknown,
  }));
}

/** Charges still waiting for the rate (for the finance page). */
export async function countPendingCancellationCharges(): Promise<number> {
  return Number((await query(`SELECT COUNT(*) FROM crm_cancellation_charges WHERE status = 'PENDING_RATE'`)).rows[0].count);
}
