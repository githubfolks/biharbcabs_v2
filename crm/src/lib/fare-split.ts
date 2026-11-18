/**
 * How a ride fare is split. Pure arithmetic (no database), used for every booking and for
 * return-trip discounts, so there is one formula.
 *
 * GST treatment (confirmed by BiharCabs' CA):
 * - Ride fare: BiharCabs is liable under CGST Sec 9(5) for GST on the full fare. Quoted fares
 *   include it; it is borne by the driver, so it is part of what the driver owes BiharCabs.
 * - Commission and tech fee charged to the driver: one B2B tax invoice, GST on both together,
 *   added on top (₹10 fee + 18% = ₹11.80).
 *
 * BiharCabs' share of a ride (totalCompanyDuesZ) = ride GST + commission + tech fee + GST on
 * (commission + tech fee). The driver keeps the rest of the fare.
 */

export interface SplitRules {
  /** Commission as a percentage of the quoted fare. */
  platform_commission_pct: number;
  /** GST on commission + tech fee, added on top. */
  gst_on_commission_pct: number;
  /** GST included in the ride fare, paid by BiharCabs under Sec 9(5), borne by the driver. */
  ride_fare_gst_pct: number;
  tech_fee_amount: number;
  advance_token_percentage: number;
  min_advance_amount: number;
}

export interface FareSplit {
  customerTotalFare: number;
  /** Fare before GST. */
  rideTaxableValue: number;
  /** GST included in the fare. */
  rideGstAmount: number;
  platformCommission: number;
  /** GST on commission + tech fee. */
  gstAmount: number;
  techFeeAmount: number;
  /** BiharCabs' share: ride GST + commission + tech fee + GST on both. */
  totalCompanyDuesZ: number;
  advanceTokenAmount: number;
  balanceCashDueFromCustomer: number;
  driverGrossEarnings: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** GST contained in a GST-inclusive amount. */
export const gstIncluded = (amount: number, pct: number) => round2((amount * pct) / (100 + pct));

/** GST added on top of an amount. */
export const gstOnTop = (amount: number, pct: number) => round2((amount * pct) / 100);

/**
 * Split a fare. `commission` overrides the percentage commission (used when a return-trip
 * discount reduces it); everything else is recalculated on this fare.
 */
export function splitFare(fare: number, rules: SplitRules, commission?: number): FareSplit {
  const platformCommission = commission ?? Math.round((fare * rules.platform_commission_pct) / 100);
  const techFeeAmount = Number(rules.tech_fee_amount);
  const rideGstAmount = gstIncluded(fare, rules.ride_fare_gst_pct);
  const gstAmount = gstOnTop(platformCommission + techFeeAmount, rules.gst_on_commission_pct);
  const totalCompanyDuesZ = round2(rideGstAmount + platformCommission + techFeeAmount + gstAmount);
  const advanceTokenAmount = Math.min(fare, Math.max(rules.min_advance_amount, Math.round((fare * rules.advance_token_percentage) / 100)));

  return {
    customerTotalFare: fare,
    rideTaxableValue: round2(fare - rideGstAmount),
    rideGstAmount,
    platformCommission,
    gstAmount,
    techFeeAmount,
    totalCompanyDuesZ,
    advanceTokenAmount,
    balanceCashDueFromCustomer: Math.max(0, fare - advanceTokenAmount),
    driverGrossEarnings: round2(fare - totalCompanyDuesZ),
  };
}
