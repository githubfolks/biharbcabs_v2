/**
 * Checks the document dates and UPI ID an admin enters when onboarding a driver.
 * Expiry dates must be real values the admin typed: a missing date would let the
 * driver pass the dispatch and expiry checks, which treat NULL as "not expired".
 */

export interface OnboardingDocs {
  license_expiry: string;
  bank_upi_id: string | null;
  vehicle: { insurance_expiry: string; fitness_expiry: string; permit_expiry: string } | null;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export function validateOnboardingDocs(body: any):
  | { ok: true; docs: OnboardingDocs }
  | { ok: false; error: string } {
  const errors: string[] = [];

  if (!isIsoDate(body?.license_expiry)) errors.push('license_expiry must be a date (YYYY-MM-DD)');

  let bank_upi_id: string | null = null;
  const rawUpi = typeof body?.bank_upi_id === 'string' ? body.bank_upi_id.trim() : '';
  if (rawUpi) {
    if (rawUpi.length > 100 || !UPI_ID.test(rawUpi)) errors.push('bank_upi_id is not a valid UPI ID (e.g. name@bank)');
    else bank_upi_id = rawUpi;
  }

  let vehicle: OnboardingDocs['vehicle'] = null;
  const v = body?.vehicle;
  if (v && (v.registration_no || v.wp_vehicle_code)) {
    for (const field of ['insurance_expiry', 'fitness_expiry', 'permit_expiry'] as const) {
      if (!isIsoDate(v[field])) errors.push(`vehicle.${field} must be a date (YYYY-MM-DD)`);
    }
    vehicle = { insurance_expiry: v.insurance_expiry, fitness_expiry: v.fitness_expiry, permit_expiry: v.permit_expiry };
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, docs: { license_expiry: body.license_expiry, bank_upi_id, vehicle } };
}
