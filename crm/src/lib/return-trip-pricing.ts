/**
 * Return-trip discount rules. Pure functions with no database access, so the money maths can be tested directly.
 *
 * Business rules (owner decisions, 2026-11-07):
 * - The discount is configurable as a percentage of the fare or a flat amount, and is off until configured.
 * - The company funds the discount up to its platform commission; the returning driver funds the rest.
 * - If no returning driver takes the ride and a regular driver does, the company absorbs the whole discount.
 */

export type DiscountType = 'PERCENT' | 'FLAT';

export interface ReturnTripPolicy {
  enabled: boolean;
  discount_type: DiscountType;
  discount_value: number | null;
  exclusive_window_minutes: number | null;
  return_status_hours: number | null;
}

export interface ReturnTripPolicyCheck {
  policy: ReturnTripPolicy;
  active: boolean;
  errors: string[];
}

/** Validate a stored policy. Anything invalid or incomplete leaves the feature inactive. */
export function checkReturnTripPolicy(raw: any): ReturnTripPolicyCheck {
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const policy: ReturnTripPolicy = {
    enabled: raw?.enabled === true,
    discount_type: raw?.discount_type === 'FLAT' ? 'FLAT' : 'PERCENT',
    discount_value: num(raw?.discount_value),
    exclusive_window_minutes: num(raw?.exclusive_window_minutes),
    return_status_hours: num(raw?.return_status_hours),
  };
  const errors: string[] = [];
  if (policy.discount_value === null || policy.discount_value <= 0) errors.push('Set a discount greater than zero.');
  if (policy.discount_type === 'PERCENT' && policy.discount_value !== null && policy.discount_value >= 100) errors.push('A percentage discount must be below 100.');
  if (policy.exclusive_window_minutes === null || policy.exclusive_window_minutes < 1 || policy.exclusive_window_minutes > 120) errors.push('Priority window must be 1 to 120 minutes.');
  if (policy.return_status_hours === null || policy.return_status_hours <= 0 || policy.return_status_hours > 48) errors.push('Return status must last more than 0 and at most 48 hours.');
  return { policy, active: policy.enabled && errors.length === 0, errors };
}

export interface FareSplit {
  customerTotalFare: number;
  platformCommission: number;
  gstAmount: number;
  techFeeAmount: number;
  totalCompanyDuesZ: number;
  advanceTokenAmount: number;
  balanceCashDueFromCustomer: number;
  driverGrossEarnings: number;
}

export interface SplitRules {
  gst_on_commission_pct: number;
  advance_token_percentage: number;
  min_advance_amount: number;
}

export interface DiscountedSplit {
  split: FareSplit;
  discountAmount: number;
  companyShare: number;
  driverShare: number;
  originalFare: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Discount in whole rupees for a fare, before any checks. */
export function returnDiscountAmount(fare: number, policy: ReturnTripPolicy): number {
  const value = Number(policy.discount_value || 0);
  return Math.round(policy.discount_type === 'FLAT' ? value : (fare * value) / 100);
}

/**
 * Apply the return-trip discount to a fare split worked out on the full fare.
 * The company gives up commission first, GST is recalculated on what remains, and the driver covers the rest.
 * Returns null when no discount can be offered safely, so the ride is simply priced normally.
 */
export function applyReturnDiscount(split: FareSplit, policy: ReturnTripPolicy, rules: SplitLike): DiscountedSplit | null {
  const fare = split.customerTotalFare;
  const discount = returnDiscountAmount(fare, policy);
  if (!(fare > 0) || !(discount > 0) || discount >= fare) return null;

  const companyShare = Math.min(discount, split.platformCommission);
  const commission = split.platformCommission - companyShare;
  const gst = round2((commission * rules.gst_on_commission_pct) / 100);
  const dues = round2(commission + gst + split.techFeeAmount);
  const newFare = fare - discount;
  const advance = Math.min(newFare, Math.max(rules.min_advance_amount, Math.round((newFare * rules.advance_token_percentage) / 100)));
  const driverGross = round2(newFare - dues);
  if (!(driverGross > 0)) return null;

  return {
    split: {
      customerTotalFare: newFare,
      platformCommission: commission,
      gstAmount: gst,
      techFeeAmount: split.techFeeAmount,
      totalCompanyDuesZ: dues,
      advanceTokenAmount: advance,
      balanceCashDueFromCustomer: Math.max(0, newFare - advance),
      driverGrossEarnings: driverGross,
    },
    discountAmount: discount,
    companyShare,
    driverShare: round2(split.driverGrossEarnings - driverGross),
    originalFare: fare,
  };
}

type SplitLike = SplitRules;

/**
 * When a regular driver takes a discounted ride, the company absorbs the whole discount:
 * the driver is paid as if there were no discount. Returns the adjusted payout and company dues.
 */
export function companyAbsorbsDiscount(driverPayout: number, companyDues: number, driverShare: number) {
  return { driverPayout: round2(driverPayout + driverShare), companyDues: round2(companyDues - driverShare) };
}
