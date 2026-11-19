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

export class PlaceOfSupplyError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
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

export interface InvoiceAwaitingPlaceOfSupply {
  id: number;
  invoiceNumber: string;
  bookingCode: string;
  pickupCity: string;
  /** The customer gave a GSTIN that is not well formed (otherwise the pickup city is not listed). */
  customerGstin: string | null;
  totalAmount: number;
  createdAt: string;
}

/** Ride invoices whose place of supply staff must choose, oldest first. */
export async function listInvoicesAwaitingPlaceOfSupply(): Promise<InvoiceAwaitingPlaceOfSupply[]> {
  const r = await query(
    `SELECT i.id, i.invoice_number, i.total_amount, i.created_at, b.booking_code, b.origin_city, NULLIF(TRIM(c.gstin), '') AS gstin
     FROM crm_invoices i
     JOIN crm_bookings b ON b.id = i.booking_id
     JOIN crm_customers c ON c.id = b.customer_id
     WHERE i.place_of_supply_code IS NULL
     ORDER BY i.created_at, i.id LIMIT 200`
  );
  return r.rows.map((x) => ({
    id: Number(x.id), invoiceNumber: x.invoice_number, bookingCode: x.booking_code, pickupCity: x.origin_city,
    customerGstin: x.gstin, totalAmount: Number(x.total_amount), createdAt: x.created_at,
  }));
}

/**
 * Staff choose the place of supply for a waiting invoice, which sets its GST split. An invoice whose place
 * of supply is already set is never changed. With rememberCity, the pickup city is added to
 * place_of_supply_cities for later rides (a city already listed is never changed).
 */
export async function setInvoicePlaceOfSupply(input: { invoiceId: number; stateCode: string; rememberCity: boolean; adminId: number }):
  Promise<{ invoiceNumber: string; split: GstSplit; cityRemembered: boolean }> {
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0) throw new PlaceOfSupplyError('Invalid invoice', 400);
  if (!isGstStateCode(input.stateCode)) throw new PlaceOfSupplyError('Choose a valid state', 400);
  const supplierCode = await supplierStateCode();

  const result = await withTransaction(async (client) => {
    const inv = (await client.query(
      `SELECT i.id, i.invoice_number, i.tax_amount, i.place_of_supply_code, b.origin_city
       FROM crm_invoices i JOIN crm_bookings b ON b.id = i.booking_id WHERE i.id = $1 FOR UPDATE OF i`,
      [input.invoiceId]
    )).rows[0];
    if (!inv) throw new PlaceOfSupplyError('Invoice not found', 404);
    if (inv.place_of_supply_code) throw new PlaceOfSupplyError(`Invoice ${inv.invoice_number} already has its place of supply`, 409);
    const split = splitGst(Number(inv.tax_amount), supplierCode, input.stateCode);
    await client.query(
      `UPDATE crm_invoices
       SET supplier_state_code = $2, place_of_supply_code = $3, place_of_supply_basis = 'STAFF',
           cgst_amount = $4, sgst_amount = $5, igst_amount = $6,
           place_of_supply_set_by = $7, place_of_supply_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [inv.id, supplierCode, input.stateCode, split.cgst, split.sgst, split.igst, input.adminId]
    );
    return { invoiceNumber: inv.invoice_number as string, split, city: cityKey(inv.origin_city) };
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
  return { invoiceNumber: result.invoiceNumber, split: result.split, cityRemembered };
}
