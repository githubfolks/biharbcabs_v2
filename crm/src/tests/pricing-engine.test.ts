import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWithinPackageDistanceRange,
  calculateDistanceAdjustedPricing,
  calculatePackagePricing,
  calculateTripDays,
} from '../lib/pricing-engine';
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

test('calculateTripDays and Round Trip pricing double road distance and add multi-day Cab + Driver TA', () => {
  assert.equal(calculateTripDays('2026-11-25', '2026-11-25', true), 1);
  assert.equal(calculateTripDays('2026-11-25', '2026-11-27', true), 3);
  assert.equal(calculateTripDays('2026-11-25', '2026-11-27', false), 1);
  assert.throws(() => calculateTripDays('2026-11-27', '2026-11-25', true), /earlier than pickup/);

  const suv = calculatePackagePricing({
    includedKm: 100,
    includedHours: 12,
    mileageKmpl: 10,
    fuelPricePerUnit: 100,
    perDayCharge: 1500,
    baseBufferMinutes: 0,
    driverTa: 300,
    splitRules: PRICING_RULES,
  });
  // Base Pre-GST = Fuel (1000) + Cab Time (1500) + TA (300) = 2800
  assert.equal(suv.totalFairPreGst, 2800);

  // Round Trip: 120 km one-way => 240 km round-trip => 140 extra km * ₹15/km = ₹2,100
  // 2-day trip (extraDays = 1) => +₹1,500 PDCRG + ₹300 Driver TA = ₹1,800
  // Adjusted Pre-GST = 2800 + 2100 + 1800 = 6700
  // Ride GST (5%) = 335, Platform Charge = 10 => Final Payment = 7045
  // Admin Comm (10% of 6700) = 670, Driver Final Payment = 6700 - 670 = 6030
  const rt = calculateDistanceAdjustedPricing(suv, 100, 15, 120, PRICING_RULES, {
    isRoundTrip: true,
    tripDays: 2,
    perDayCharge: 1500,
    driverTa: 300,
  });
  assert.equal(rt.isRoundTrip, true);
  assert.equal(rt.tripDays, 2);
  assert.equal(rt.extraDays, 1);
  assert.equal(rt.roadDistanceKm, 240);
  assert.equal(rt.billedKm, 240);
  assert.equal(rt.extraKm, 140);
  assert.equal(rt.extraKmChargePreGst, 2100);
  assert.equal(rt.extraDayCabChargePreGst, 1500);
  assert.equal(rt.extraDayDriverTaPreGst, 300);
  assert.equal(rt.totalFairPreGst, 6700);
  assert.equal(rt.gstCharge, 335);
  assert.equal(rt.techFeeAmount, 10);
  assert.equal(rt.totalPayment, 7045);
  assert.equal(rt.adminCommission, 670);
  assert.equal(rt.driverGrossEarnings, 6030);
});

test('package distance range enforces +20% soft tolerance and blocks routes above 120%', () => {
  const micro = calculatePackagePricing({
    includedKm: 10,
    includedHours: 2,
    mileageKmpl: 15,
    fuelPricePerUnit: 113.37,
    perDayCharge: 800,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: PRICING_RULES,
  });

  // 11.5 km is within 12 km (10 km + 20% tolerance) => allowed, 1.5 extra km billed
  const withinTol = calculateDistanceAdjustedPricing(micro, 10, 16, 11.5, PRICING_RULES, { tolerancePct: 20 });
  assert.equal(withinTol.maxAllowedKm, 12);
  assert.equal(withinTol.withinPackageRange, true);
  assert.equal(withinTol.extraKm, 1.5);
  assert.equal(withinTol.extraKmChargePreGst, 24);
  assert.doesNotThrow(() => assertWithinPackageDistanceRange('Micro-10KM-2Hr', 10, withinTol));

  // 15 km exceeds 12 km (120% of 10 km) => blocked
  const outOfRange = calculateDistanceAdjustedPricing(micro, 10, 16, 15, PRICING_RULES, { tolerancePct: 20 });
  assert.equal(outOfRange.maxAllowedKm, 12);
  assert.equal(outOfRange.withinPackageRange, false);
  assert.throws(
    () => assertWithinPackageDistanceRange('Micro-10KM-2Hr', 10, outOfRange),
    /exceeds the maximum allowed range of 12 km/
  );
});
