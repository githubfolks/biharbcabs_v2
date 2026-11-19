/**
 * GST state codes, as in the State Codes master of the GST e-invoice portal
 * (https://einvoice1.gst.gov.in/Others/MasterCodes, checked 2026-11-19). Code 28 is no longer listed.
 * Codes for places outside India (96, 99) are left out: BiharCabs' rides are within India.
 * The first two digits of a GSTIN are the registered person's state code.
 * No server-only imports, so client components can use it too.
 */
export const GST_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

export const isGstStateCode = (code: unknown): code is string => typeof code === 'string' && code in GST_STATES;

/** "Bihar (10)", or the bare code if unknown. */
export const stateLabel = (code: string) => (GST_STATES[code] ? `${GST_STATES[code]} (${code})` : code);

/**
 * GSTIN layout: 2-digit state code, 10-character PAN (5 letters, 4 digits, 1 letter), entity number,
 * the letter Z, and a check character. The check character itself is not verified here.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The state code of a well-formed GSTIN with a known state, otherwise null. */
export function stateCodeFromGstin(gstin: unknown): string | null {
  const g = String(gstin ?? '').trim().toUpperCase();
  if (!GSTIN_PATTERN.test(g)) return null;
  const code = g.slice(0, 2);
  return isGstStateCode(code) ? code : null;
}
