/**
 * How a ride fare is split. Pure arithmetic (no database), used for every booking and for
 * return-trip discounts, so there is one formula.
 *
 * GST treatment (confirmed by BiharCabs' CA):
 * - Ride fare: BiharCabs is liable under CGST Sec 9(5) for GST on the full ride fare.
 *   Ride GST is borne by the driver, so it is part of what the driver owes BiharCabs.
 * - Commission and tech fee charged to the driver: one B2B tax invoice, GST on both together,
 *   added on top (tech_fee + gst_on_commission_pct%).
 *
 * BiharCabs' share of a ride (totalCompanyDuesZ) = ride GST + commission + tech fee + GST on
 * (commission + tech fee). The driver keeps the rest of the fare.
 */

export interface SplitRules {
  /** Commission as a percentage of the pre-GST ride fare (ACP). */
  platform_commission_pct: number;
  /** GST on commission + tech fee, added on top (e.g. 18%). */
  gst_on_commission_pct: number;
  /** Ride GST rate (e.g. 5%), paid by BiharCabs under Sec 9(5), borne by the driver. */
  ride_fare_gst_pct: number;
  /** Flat platform tech fee (from crm_settings). */
  tech_fee_amount: number;
}

export interface FareSplit {
  /** Total customer payable including ride GST. */
  customerTotalFare: number;
  /** Fare before ride GST (Total Fair). */
  rideTaxableValue: number;
  /** Ride GST (Sec 9(5)). */
  rideGstAmount: number;
  /** Admin commission = rideTaxableValue * platform_commission_pct / 100. */
  platformCommission: number;
  /** GST on (commission + tech fee). */
  gstAmount: number;
  techFeeAmount: number;
  /** BiharCabs' share: ride GST + commission + tech fee + GST on both. */
  totalCompanyDuesZ: number;
  /** Driver's gross earnings after BiharCabs' share. */
  driverGrossEarnings: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** GST contained in a GST-inclusive amount. */
export const gstIncluded = (amount: number, pct: number) => round2((amount * pct) / (100 + pct));

/** GST added on top of an amount. */
export const gstOnTop = (amount: number, pct: number) => round2((amount * pct) / 100);

/**
 * Split a GST-inclusive customer fare.
 * `commission` overrides the percentage commission (used when a return-trip discount reduces it).
 */
export function splitFare(fare: number, rules: SplitRules, commission?: number): FareSplit {
  const totalFare = round2(fare);
  const rideGstAmount = gstIncluded(totalFare, rules.ride_fare_gst_pct);
  const rideTaxableValue = round2(totalFare - rideGstAmount);
  const platformCommission =
    commission !== undefined ? round2(commission) : round2((rideTaxableValue * rules.platform_commission_pct) / 100);
  const techFeeAmount = Number(rules.tech_fee_amount);
  const gstAmount = gstOnTop(platformCommission + techFeeAmount, rules.gst_on_commission_pct);
  const totalCompanyDuesZ = round2(rideGstAmount + platformCommission + techFeeAmount + gstAmount);

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
 * Total Payment = Total Fair + GST Charge
 * Admin Commission = Total Fair * ACP / 100
 */
export function splitPreGstFare(preGstFare: number, rules: SplitRules): FareSplit {
  const rideTaxableValue = round2(preGstFare);
  const rideGstAmount = gstOnTop(rideTaxableValue, rules.ride_fare_gst_pct);
  const customerTotalFare = round2(rideTaxableValue + rideGstAmount);
  const platformCommission = round2((rideTaxableValue * rules.platform_commission_pct) / 100);
  const techFeeAmount = Number(rules.tech_fee_amount);
  const gstAmount = gstOnTop(platformCommission + techFeeAmount, rules.gst_on_commission_pct);
  const totalCompanyDuesZ = round2(rideGstAmount + platformCommission + techFeeAmount + gstAmount);

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
