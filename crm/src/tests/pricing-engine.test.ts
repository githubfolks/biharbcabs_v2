import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceAdjustedPricing, calculatePackagePricing } from '../lib/pricing-engine';
import { SplitRules } from '../lib/fare-split';
import { normalizePlanTripType, planDeductionForRide } from '../lib/driver-plans';

const PRICING_RULES: SplitRules = {
  platform_commission_pct: 10,
  gst_on_commission_pct: 0,
  ride_fare_gst_pct: 5,
  tech_fee_amount: 10,
};

test('calculatePackagePricing computes Total Fair + 5% GST + ₹10 Platform Charge with 10% driver commission', () => {
  // MINI: 1 hr, 10 km, mileage 10, Petrol ₹115, PDCRG ₹1000, buffer 30m, TA ₹0
  const mini = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1000,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: PRICING_RULES,
  });
  assert.equal(mini.fuelCost, 115);
  assert.equal(mini.cabTimeCharge, 125);
  assert.equal(mini.totalFairPreGst, 240);
  assert.equal(mini.gstCharge, 12);
  assert.equal(mini.techFeeAmount, 10);
  assert.equal(mini.totalPayment, 262); // 240 + 12 + 10
  assert.equal(mini.adminCommission, 24); // 10% of 240
  assert.equal(mini.gstOnCommissionAndTechFee, 0);
  assert.equal(mini.totalCompanyDuesZ, 46); // 12 + 24 + 10
  assert.equal(mini.driverGrossEarnings, 216); // 240 - 24

  // SEDAN: 1 hr, 10 km, mileage 10, Petrol ₹115, PDCRG ₹1100, buffer 30m, TA ₹0
  const sedan = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1100,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: PRICING_RULES,
  });
  assert.equal(sedan.cabTimeCharge, 137.5);
  assert.equal(sedan.totalFairPreGst, 252.5);
  assert.equal(sedan.gstCharge, 12.63);
  assert.equal(sedan.totalPayment, 275.13); // 252.5 + 12.63 + 10
  assert.equal(sedan.adminCommission, 25.25);
  assert.equal(sedan.driverGrossEarnings, 227.25);

  // SUV: 1 hr, 10 km, mileage 8, Petrol ₹115, PDCRG ₹1500, buffer 30m, TA ₹50
  const suv = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 8,
    fuelPricePerUnit: 115,
    perDayCharge: 1500,
    baseBufferMinutes: 30,
    driverTa: 50,
    splitRules: PRICING_RULES,
  });
  assert.equal(suv.fuelCost, 143.75);
  assert.equal(suv.cabTimeCharge, 187.5);
  assert.equal(suv.totalFairPreGst, 381.25);
  assert.equal(suv.gstCharge, 19.06);
  assert.equal(suv.totalPayment, 410.31); // 381.25 + 19.06 + 10
  assert.equal(suv.adminCommission, 38.13);
  assert.equal(suv.driverGrossEarnings, 343.12);
});

test('calculatePackagePricing rejects unconfigured fuel price (<= 0)', () => {
  assert.throws(
    () =>
      calculatePackagePricing({
        includedKm: 10,
        includedHours: 1,
        mileageKmpl: 15,
        fuelPricePerUnit: 0,
        perDayCharge: 800,
        baseBufferMinutes: 30,
        driverTa: 0,
        splitRules: PRICING_RULES,
      }),
    /Fuel price/
  );
});

test('planDeductionForRide deducts pre-GST commission + platform charge + ride GST', () => {
  const deduction = planDeductionForRide({
    platformCommission: 300,
    techFeeAmount: 10,
    rideGstAmount: 150,
  });
  assert.equal(deduction, 460);
  assert.equal(normalizePlanTripType('oneway'), 'OUTSTATION');
  assert.equal(normalizePlanTripType('airport'), 'LOCAL');
  assert.equal(normalizePlanTripType('rental'), 'RENTAL');
});

test('calculateDistanceAdjustedPricing leaves fare unchanged when road distance <= included KM', () => {
  const mini = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1000,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: PRICING_RULES,
  });

  const within = calculateDistanceAdjustedPricing(mini, 10, 12, 8.5, PRICING_RULES);
  assert.equal(within.extraKm, 0);
  assert.equal(within.extraKmChargePreGst, 0);
  assert.equal(within.billedKm, 10);
  assert.equal(within.roadDistanceKm, 8.5);
  assert.equal(within.totalFairPreGst, 240);
  assert.equal(within.totalPayment, 262);
  assert.equal(within.adminCommission, 24);
  assert.equal(within.driverGrossEarnings, 216);
});

test('calculateDistanceAdjustedPricing adds extra KM charge pre-GST and recalculates GST, Platform Charge & 10% commission', () => {
  const mini = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1000,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: PRICING_RULES,
  });

  // Road distance 25 km vs 10 km included => 15 extra km * ₹12/km = ₹180 pre-GST
  // Adjusted pre-GST Total Fair = 240 + 180 = 420
  // Ride GST (5%) = 21.00, Platform Charge = 10.00 => Customer Final Payment = 451.00
  // Admin Comm (10% of 420) = 42.00
  // Total Company Dues Z = 21 + 42 + 10 = 73.00
  // Driver Final Payment = 420 - 42 = 378.00
  const over = calculateDistanceAdjustedPricing(mini, 10, 12, 25, PRICING_RULES);
  assert.equal(over.extraKm, 15);
  assert.equal(over.extraKmChargePreGst, 180);
  assert.equal(over.billedKm, 25);
  assert.equal(over.roadDistanceKm, 25);
  assert.equal(over.totalFairPreGst, 420);
  assert.equal(over.gstCharge, 21);
  assert.equal(over.techFeeAmount, 10);
  assert.equal(over.totalPayment, 451);
  assert.equal(over.adminCommission, 42);
  assert.equal(over.gstOnCommissionAndTechFee, 0);
  assert.equal(over.totalCompanyDuesZ, 73);
  assert.equal(over.driverGrossEarnings, 378);
});
