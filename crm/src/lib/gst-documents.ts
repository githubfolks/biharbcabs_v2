import { PoolClient } from 'pg';

/**
 * Consecutive numbers for GST documents, from database sequences, so a series never has gaps from
 * clashes or reuse. Format: <prefix><financial year><6-digit serial>, e.g. RV2627000001.
 *   RV: receipt voucher (advance received)
 *   RF: refund voucher (advance refunded; quotes the receipt voucher)
 *   CC: tax document for a cancellation charge (advance kept on a late cancellation)
 */

const SERIES = {
  RV: 'crm_receipt_voucher_seq',
  RF: 'crm_refund_voucher_seq',
  CC: 'crm_cancellation_invoice_seq',
} as const;

/** Indian financial year (April–March) as "2627" for 2026-27, in India time. */
export function financialYearCode(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

export async function nextDocumentNumber(client: PoolClient, series: keyof typeof SERIES, at = new Date()): Promise<string> {
  const r = await client.query(`SELECT nextval('${SERIES[series]}') AS n`);
  return `${series}${financialYearCode(at)}${String(r.rows[0].n).padStart(6, '0')}`;
}
