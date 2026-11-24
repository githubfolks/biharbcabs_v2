/**
 * How a ride fare is split. Pure arithmetic (no database), used for every booking and for
 * return-trip discounts, so there is one formula.
 *
 * Confirmed BiharCabs Pricing & Deduction Rules:
 * - Total Fair (rideTaxableValue) = Pre-GST ride fare.
 * - Ride GST = Total Fair * ride_fare_gst_pct / 100 (e.g. 5%).
 * - Platform Charge (techFeeAmount) = flat fee added to customer final payment (e.g. Rs 10).
 * - Customer Final Payment = Total Fair + Ride GST + Platform Charge.
 * - Admin Commission = Total Fair * platform_commission_pct / 100 (e.g. 10%), deducted from driver.
 * - Driver Final Earnings = Total Fair - Admin Commission.
 * - Total Company Dues (Z) = Ride GST + Admin Commission + Platform Charge
 *   (so Driver Final Earnings = Customer Final Payment - Z = Total Fair - Admin Commission).
 */

export interface SplitRules {
  /** Commission as a percentage of the pre-GST ride fare (e.g. 10%). */
  platform_commission_pct: number;
  /** Optional extra GST % on commission (default 0 — not deducted from driver). */
  gst_on_commission_pct: number;
  /** Ride GST rate (e.g. 5%). */
  ride_fare_gst_pct: number;
  /** Flat platform charge added to customer final payment (e.g. Rs 10). */
  tech_fee_amount: number;
}

export interface FareSplit {
  /** Total customer payable = rideTaxableValue + rideGstAmount + techFeeAmount. */
  customerTotalFare: number;
  /** Fare before ride GST & platform charge (Total Fair). */
  rideTaxableValue: number;
  /** Ride GST (e.g. 5% of Total Fair). */
  rideGstAmount: number;
  /** Admin commission = rideTaxableValue * platform_commission_pct / 100. */
  platformCommission: number;
  /** Extra GST on commission (0 under current policy). */
  gstAmount: number;
  /** Flat platform charge added to customer final payment. */
  techFeeAmount: number;
  /** Total amount driver remits to company: ride GST + admin commission + platform charge. */
  totalCompanyDuesZ: number;
  /** Driver's final earnings = Total Fair - Admin Commission. */
  driverGrossEarnings: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** GST contained in a GST-inclusive amount. */
export const gstIncluded = (amount: number, pct: number) => round2((amount * pct) / (100 + pct));

/** GST added on top of an amount. */
export const gstOnTop = (amount: number, pct: number) => round2((amount * pct) / 100);

/**
 * Split a customer final payment (which includes Total Fair + Ride GST + Platform Charge).
 * `commission` overrides the percentage commission (used when a return-trip discount reduces it).
 */
export function splitFare(fare: number, rules: SplitRules, commission?: number): FareSplit {
  const totalFare = round2(fare);
  const techFeeAmount = round2(Math.max(0, Number(rules.tech_fee_amount || 0)));
  const fareExclPlatformFee = Math.max(0, round2(totalFare - techFeeAmount));
  const rideGstAmount = gstIncluded(fareExclPlatformFee, rules.ride_fare_gst_pct);
  const rideTaxableValue = round2(fareExclPlatformFee - rideGstAmount);
  const platformCommission =
    commission !== undefined ? round2(commission) : round2((rideTaxableValue * rules.platform_commission_pct) / 100);
  const gstAmount = 0;
  const totalCompanyDuesZ = round2(rideGstAmount + platformCommission + techFeeAmount);

  return {
    customerTotalFare: totalFare,
    rideTaxableValue,
    rideGstAmount,
    platformCommission,
    gstAmount,
    techFeeAmount,
    totalCompanyDuesZ,
    driverGrossEarnings: round2(totalFare - totalCompanyDuesZ),
  };
}

/**
 * Split a pre-GST ride fare (Total Fair from the package pricing engine).
 * GST Charge = Total Fair * GST / 100
 * Platform Charge = tech_fee_amount
 * Final Payment = Total Fair + GST Charge + Platform Charge
 * Admin Commission = Total Fair * platform_commission_pct / 100 (deducted from driver)
 * Driver Final Payment = Total Fair - Admin Commission
 */
export function splitPreGstFare(preGstFare: number, rules: SplitRules): FareSplit {
  const rideTaxableValue = round2(preGstFare);
  const rideGstAmount = gstOnTop(rideTaxableValue, rules.ride_fare_gst_pct);
  const techFeeAmount = round2(Math.max(0, Number(rules.tech_fee_amount || 0)));
  const customerTotalFare = round2(rideTaxableValue + rideGstAmount + techFeeAmount);
  const platformCommission = round2((rideTaxableValue * rules.platform_commission_pct) / 100);
  const gstAmount = 0;
  const totalCompanyDuesZ = round2(rideGstAmount + platformCommission + techFeeAmount);

  return {
    customerTotalFare,
    rideTaxableValue,
    rideGstAmount,
    platformCommission,
    gstAmount,
    techFeeAmount,
    totalCompanyDuesZ,
    driverGrossEarnings: round2(customerTotalFare - totalCompanyDuesZ),
  };
}
