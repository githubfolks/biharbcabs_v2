/**
 * Pure business rules for Corporate B2B credit limits and Hotel/Partner commissions.
 */

export function checkCorporateCreditLimit(params: {
  creditLimit: number;
  currentOutstanding: number;
  bookingFare: number;
}): { allowed: boolean; projectedOutstanding: number; remainingCredit: number } {
  const projected = Math.round((params.currentOutstanding + params.bookingFare) * 100) / 100;
  const remaining = Math.round((params.creditLimit - params.currentOutstanding) * 100) / 100;
  return {
    allowed: projected <= params.creditLimit,
    projectedOutstanding: projected,
    remainingCredit: Math.max(0, remaining),
  };
}

export function computePartnerCommission(params: {
  farePreGst: number;
  commissionType: 'PERCENT' | 'FLAT';
  commissionValue: number;
}): number {
  const val = Number(params.commissionValue || 0);
  if (!Number.isFinite(val) || val <= 0) return 0;
  const raw = params.commissionType === 'PERCENT' ? (params.farePreGst * val) / 100 : val;
  return Math.round(raw * 100) / 100;
}

export function normalizeReferralCode(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 40);
}
