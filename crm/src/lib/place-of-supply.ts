import { DomainError } from './route-errors';
import { query, withTransaction } from './db';
import { getCompanyBillingInfo, getSetting, invalidateSettingsCache } from './settings';
import { isGstStateCode, stateCodeFromGstin } from './gst-states';
import { round2 } from './fare-split';

/**
 * Place of supply for a ride and the GST split, per BiharCabs' CA (Rule 46, CGST Rules; Section 12(9),
 * IGST Act): to a registered person, the person's location (the state in their GSTIN); to anyone
 * else, the state where the passenger is picked up. In the supplier's own state the tax is shown as
 * CGST + SGST, half each; in another state as IGST.
 *
 * Nothing is guessed: a pickup city missing from place_of_supply_cities, or a customer GSTIN that is not
 * well formed, leaves the place of supply unknown, and staff choose it on the Finance page.
 */

export type PlaceOfSupplyBasis = 'RECIPIENT_GSTIN' | 'PICKUP_CITY' | 'STAFF';

export class PlaceOfSupplyError extends DomainError {
  constructor(message: string, status = 409) {
    super(message, status);
  }
}

/** BiharCabs' state: from its GSTIN once set, otherwise company_billing_info.state_code. They must agree. */
export async function supplierStateCode(): Promise<string> {
  const company: any = await getCompanyBillingInfo();
  const configured = String(company?.state_code ?? '').trim();
  const fromGstin = company?.gstin ? stateCodeFromGstin(company.gstin) : null;
  if (company?.gstin && !fromGstin) throw new PlaceOfSupplyError('company_billing_info.gstin is not a valid GSTIN.');
  if (fromGstin && isGstStateCode(configured) && configured !== fromGstin) {
    throw new PlaceOfSupplyError(`company_billing_info.state_code ${configured} does not match the GSTIN's state ${fromGstin}.`);
  }
  const code = fromGstin ?? configured;
  if (!isGstStateCode(code)) throw new PlaceOfSupplyError('BiharCabs\' state is not set (company_billing_info.state_code or gstin).');
  return code;
}

/** "Patna, Bihar" and " PATNA " both look up "patna". */
export const cityKey = (city: unknown) => String(city ?? '').split(',')[0].trim().replace(/\s+/g, ' ').toLowerCase();

/** City (cityKey) to GST state code, from settings; entries with an unknown code are ignored. */
export async function placeOfSupplyCities(): Promise<Record<string, string>> {
  const raw = await getSetting<Record<string, unknown>>('place_of_supply_cities', {});
  const out: Record<string, string> = {};
  for (const [city, code] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (cityKey(city) && isGstStateCode(code)) out[cityKey(city)] = code;
  }
  return out;
}

/** The place of supply under the rules above, or null when it cannot be known without staff. */
export async function resolvePlaceOfSupply(input: { customerGstin?: string | null; pickupCity?: string | null }):
  Promise<{ code: string; basis: PlaceOfSupplyBasis } | null> {
  if (String(input.customerGstin ?? '').trim()) {
    const code = stateCodeFromGstin(input.customerGstin);
    return code ? { code, basis: 'RECIPIENT_GSTIN' } : null;
  }
  const code = (await placeOfSupplyCities())[cityKey(input.pickupCity)];
  return code ? { code, basis: 'PICKUP_CITY' } : null;
}

export interface GstSplit {
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  cgst: number;
  sgst: number;
  igst: number;
}

/** Split the GST on an invoice; the parts always add up to the tax. */
export function splitGst(tax: number, supplierCode: string, placeOfSupplyCode: string): GstSplit {
  const total = round2(tax);
  if (supplierCode === placeOfSupplyCode) {
    const cgst = round2(total / 2);
    return { supplyType: 'INTRA_STATE', cgst, sgst: round2(total - cgst), igst: 0 };
  }
  return { supplyType: 'INTER_STATE', cgst: 0, sgst: 0, igst: total };
}

/** Fields a GST document stores for its place of supply and split. */
export interface DocumentTax {
  supplierCode: string;
  placeOfSupply: { code: string; basis: PlaceOfSupplyBasis | 'RECEIPT_VOUCHER' };
  split: GstSplit;
}

/**
 * Place of supply and split for a document about to be issued, or null when staff must choose the state.
 * A configuration problem (BiharCabs' state or GSTIN) also returns null: issuing the document, and the
 * money movement it belongs to, must not fail because of it.
 */
export async function documentTaxSplit(customerGstin: string | null, pickupCity: string | null, tax: number): Promise<DocumentTax | null> {
  try {
    const placeOfSupply = await resolvePlaceOfSupply({ customerGstin, pickupCity });
    if (!placeOfSupply) return null;
    const supplierCode = await supplierStateCode();
    return { supplierCode, placeOfSupply, split: splitGst(tax, supplierCode, placeOfSupply.code) };
  } catch (err: any) {
    console.error('[GST] Place of supply not set:', err?.message);
    return null;
  }
}

/** A refund voucher or cancellation charge takes the place of supply of its receipt voucher. */
export function inheritedTax(rv: { supplier_state_code?: string | null; place_of_supply_code?: string | null } | undefined, tax: number): DocumentTax | null {
  if (!rv?.supplier_state_code || !rv.place_of_supply_code) return null;
  return {
    supplierCode: rv.supplier_state_code,
    placeOfSupply: { code: rv.place_of_supply_code, basis: 'RECEIPT_VOUCHER' },
    split: splitGst(tax, rv.supplier_state_code, rv.place_of_supply_code),
  };
}

/** SQL values for a document's place-of-supply columns, in the order supplier, code, basis, cgst, sgst, igst. */
export const taxColumns = (t: DocumentTax | null) => [
  t?.supplierCode ?? null, t?.placeOfSupply.code ?? null, t?.placeOfSupply.basis ?? null,
  t?.split.cgst ?? null, t?.split.sgst ?? null, t?.split.igst ?? null,
];

/** Documents staff can choose a place of supply for. Refund vouchers follow their receipt voucher. */
export const SETTABLE_KINDS = ['TI', 'RV', 'CC'] as const;
export type SettableKind = (typeof SETTABLE_KINDS)[number];

/** Each kind: its table, number column and taxed amount. Fixed identifiers, never from input. */
const KIND_SQL: Record<SettableKind, { table: string; number: string; tax: string; issued: string }> = {
  TI: { table: 'crm_invoices', number: 'invoice_number', tax: 'tax_amount', issued: 'TRUE' },
  RV: { table: 'crm_payment_links', number: 'receipt_voucher_number', tax: 'gst_amount', issued: 'd.receipt_voucher_number IS NOT NULL AND d.gst_amount IS NOT NULL' },
  CC: { table: 'crm_cancellation_charges', number: 'invoice_number', tax: 'gst_amount', issued: "d.status = 'ISSUED' AND d.receipt_voucher_number IS NULL" },
};

export interface DocumentAwaitingPlaceOfSupply {
  kind: SettableKind;
  id: number;
  number: string;
  bookingCode: string;
  pickupCity: string;
  /** The customer gave a GSTIN that is not well formed (otherwise the pickup city is not listed). */
  customerGstin: string | null;
  tax: number;
  createdAt: string;
}

/**
 * Documents whose place of supply staff must choose, oldest first. A cancellation charge with a receipt
 * voucher is not listed: it follows that voucher.
 */
export async function listDocumentsAwaitingPlaceOfSupply(): Promise<DocumentAwaitingPlaceOfSupply[]> {
  const parts = SETTABLE_KINDS.map((kind) => {
    const k = KIND_SQL[kind];
    return `SELECT '${kind}' AS kind, d.id, d.${k.number} AS number, d.${k.tax} AS tax, d.created_at,
                   b.booking_code, b.origin_city, NULLIF(TRIM(c.gstin), '') AS gstin
            FROM ${k.table} d JOIN crm_bookings b ON b.id = d.booking_id JOIN crm_customers c ON c.id = b.customer_id
            WHERE d.place_of_supply_code IS NULL AND ${k.issued}`;
  });
  const r = await query(`${parts.join(' UNION ALL ')} ORDER BY created_at, kind, id LIMIT 200`);
  return r.rows.map((x) => ({
    kind: x.kind, id: Number(x.id), number: x.number, bookingCode: x.booking_code, pickupCity: x.origin_city,
    customerGstin: x.gstin, tax: Number(x.tax), createdAt: x.created_at,
  }));
}

/**
 * Staff choose the place of supply for a waiting document, which sets its GST split. A place of supply
 * already set is never changed. For a receipt voucher, its refund vouchers and cancellation charges
 * waiting for it get the same place of supply. With rememberCity, the pickup city is added to
 * place_of_supply_cities for later rides (a city already listed is never changed).
 */
export async function setDocumentPlaceOfSupply(input: { kind: string; id: number; stateCode: string; rememberCity: boolean; adminId: number }):
  Promise<{ number: string; split: GstSplit; cityRemembered: boolean; documentsUpdated: number }> {
  if (!(SETTABLE_KINDS as readonly string[]).includes(input.kind)) throw new PlaceOfSupplyError('Unknown document type', 400);
  const kind = input.kind as SettableKind;
  if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new PlaceOfSupplyError('Invalid document', 400);
  if (!isGstStateCode(input.stateCode)) throw new PlaceOfSupplyError('Choose a valid state', 400);
  const supplierCode = await supplierStateCode();
  const k = KIND_SQL[kind];

  const result = await withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT d.id, d.${k.number} AS number, d.${k.tax} AS tax, d.place_of_supply_code, b.origin_city
       FROM ${k.table} d JOIN crm_bookings b ON b.id = d.booking_id WHERE d.id = $1 AND ${k.issued} FOR UPDATE OF d`,
      [input.id]
    )).rows[0];
    if (!doc) throw new PlaceOfSupplyError('Document not found', 404);
    if (doc.place_of_supply_code) throw new PlaceOfSupplyError(`${doc.number} already has its place of supply`, 409);
    const split = splitGst(Number(doc.tax), supplierCode, input.stateCode);
    await client.query(
      `UPDATE ${k.table}
       SET supplier_state_code = $2, place_of_supply_code = $3, place_of_supply_basis = 'STAFF',
           cgst_amount = $4, sgst_amount = $5, igst_amount = $6,
           place_of_supply_set_by = $7, place_of_supply_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [doc.id, supplierCode, input.stateCode, split.cgst, split.sgst, split.igst, input.adminId]
    );
    let documentsUpdated = 1;
    if (kind === 'RV') {
      // Its refund vouchers and cancellation charges follow it.
      for (const [table, tax, issued] of [
        ['crm_refunds', 'gst_reversed', 'refund_voucher_number IS NOT NULL'],
        ['crm_cancellation_charges', 'gst_amount', "status = 'ISSUED'"],
      ]) {
        const followers = (await client.query(
          `SELECT id, ${tax} AS tax FROM ${table} WHERE receipt_voucher_number = $1 AND place_of_supply_code IS NULL AND ${tax} IS NOT NULL AND ${issued} FOR UPDATE`,
          [doc.number]
        )).rows;
        for (const f of followers) {
          const s = splitGst(Number(f.tax), supplierCode, input.stateCode);
          await client.query(
            `UPDATE ${table} SET supplier_state_code = $2, place_of_supply_code = $3, place_of_supply_basis = 'RECEIPT_VOUCHER',
               cgst_amount = $4, sgst_amount = $5, igst_amount = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [f.id, supplierCode, input.stateCode, s.cgst, s.sgst, s.igst]
          );
          documentsUpdated++;
        }
      }
    }
    return { number: doc.number as string, split, city: cityKey(doc.origin_city), documentsUpdated };
  });

  let cityRemembered = false;
  if (input.rememberCity && result.city) {
    // Added in one statement, so two staff remembering cities at once cannot overwrite each other.
    const r = await query(
      `UPDATE crm_settings SET setting_value = setting_value || jsonb_build_object($1::text, $2::text), updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = 'place_of_supply_cities' AND NOT (setting_value ? $1::text)`,
      [result.city, input.stateCode]
    );
    cityRemembered = (r.rowCount ?? 0) > 0;
    invalidateSettingsCache();
  }
  return { number: result.number, split: result.split, cityRemembered, documentsUpdated: result.documentsUpdated };
}
