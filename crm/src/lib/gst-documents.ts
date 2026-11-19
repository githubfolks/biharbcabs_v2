import { PoolClient } from 'pg';

/**
 * Consecutive numbers for GST documents (Rule 46(b), CGST Rules: one consecutive series, at most 16
 * characters, unique for the financial year). Format: <series><financial year><6-digit serial>, e.g.
 * TI2627000001 (12 characters). Each series restarts at 000001 on 1 April (per CA, so a year's serials
 * match the documents reported in GSTR-1).
 *   TI: tax invoice for a ride
 *   RV: receipt voucher (advance received)
 *   RF: refund voucher (advance refunded; quotes the receipt voucher)
 *   CC: tax document for a cancellation charge (advance kept on a late cancellation)
 */
export const DOCUMENT_SERIES = ['TI', 'RV', 'RF', 'CC'] as const;
export type DocumentSeries = (typeof DOCUMENT_SERIES)[number];
const MAX_SERIAL = 999999;

/** Indian financial year (April–March) as "2627" for 2026-27, in India time. */
export function financialYearCode(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The next number in a series for the financial year of `at` (India time). Call it inside the
 * transaction that issues the document: the counter row stays locked until that transaction ends, so
 * numbers are issued in order, and a transaction that fails gives its number back (no gaps).
 */
export async function nextDocumentNumber(client: PoolClient, series: DocumentSeries, at = new Date()): Promise<string> {
  if (!DOCUMENT_SERIES.includes(series)) throw new Error(`Unknown document series ${series}`);
  const fy = financialYearCode(at);
  const r = await client.query(
    `INSERT INTO crm_document_counters (series, financial_year, last_number) VALUES ($1, $2, 1)
     ON CONFLICT (series, financial_year) DO UPDATE
     SET last_number = crm_document_counters.last_number + 1, updated_at = CURRENT_TIMESTAMP
     RETURNING last_number`,
    [series, fy]
  );
  const n = Number(r.rows[0].last_number);
  if (n > MAX_SERIAL) throw new Error(`Document series ${series}${fy} is full (${MAX_SERIAL} documents)`);
  return `${series}${fy}${String(n).padStart(6, '0')}`;
}
