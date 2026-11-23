import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceAdjustedPricing, calculatePackagePricing } from '../lib/pricing-engine';
import { SplitRules } from '../lib/fare-split';
import { normalizePlanTripType, planDeductionForRide } from '../lib/driver-plans';

const EXCEL_RULES: SplitRules = {
  platform_commission_pct: 12,
  gst_on_commission_pct: 18,
  ride_fare_gst_pct: 5,
  tech_fee_amount: 10,
};

test('calculatePackagePricing matches Biharcabs Cab Plans.xlsx rows', () => {
  // MINI: 1 hr, 10 km, mileage 10, Petrol ₹115, PDCRG ₹1000, buffer 30m, TA ₹0
  const mini = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1000,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: EXCEL_RULES,
  });
  assert.equal(mini.fuelCost, 115);
  assert.equal(mini.cabTimeCharge, 125);
  assert.equal(mini.totalFairPreGst, 240);
  assert.equal(mini.gstCharge, 12);
  assert.equal(mini.totalPayment, 252);
  assert.equal(mini.adminCommission, 28.8);
  // CA rule: tech fee ₹10 + 18% GST on (28.80 + 10) = 6.98
  assert.equal(mini.gstOnCommissionAndTechFee, 6.98);
  assert.equal(mini.totalCompanyDuesZ, 57.78);

  // SEDAN: 1 hr, 10 km, mileage 10, Petrol ₹115, PDCRG ₹1100, buffer 30m, TA ₹0
  const sedan = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1100,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: EXCEL_RULES,
  });
  assert.equal(sedan.cabTimeCharge, 137.5);
  assert.equal(sedan.totalFairPreGst, 252.5);
  assert.equal(sedan.gstCharge, 12.63);
  assert.equal(sedan.totalPayment, 265.13);
  assert.equal(sedan.adminCommission, 30.3);

  // PRIME SEDAN: 1 hr, 10 km, mileage 10, Petrol ₹115, PDCRG ₹1200, buffer 30m, TA ₹50
  const prime = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1200,
    baseBufferMinutes: 30,
    driverTa: 50,
    splitRules: EXCEL_RULES,
  });
  assert.equal(prime.totalFairPreGst, 315);
  assert.equal(prime.gstCharge, 15.75);
  assert.equal(prime.totalPayment, 330.75);
  assert.equal(prime.adminCommission, 37.8);

  // SUV: 1 hr, 10 km, mileage 8, Petrol ₹115, PDCRG ₹1500, buffer 30m, TA ₹50
  const suv = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 8,
    fuelPricePerUnit: 115,
    perDayCharge: 1500,
    baseBufferMinutes: 30,
    driverTa: 50,
    splitRules: EXCEL_RULES,
  });
  assert.equal(suv.fuelCost, 143.75);
  assert.equal(suv.cabTimeCharge, 187.5);
  assert.equal(suv.totalFairPreGst, 381.25);
  assert.equal(suv.gstCharge, 19.06);
  assert.equal(suv.totalPayment, 400.31);
  assert.equal(suv.adminCommission, 45.75);

  // LUX: 1 hr, 10 km, mileage 8, Diesel ₹98, PDCRG ₹2000, buffer 30m, TA ₹50
  const lux = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 8,
    fuelPricePerUnit: 98,
    perDayCharge: 2000,
    baseBufferMinutes: 30,
    driverTa: 50,
    splitRules: EXCEL_RULES,
  });
  assert.equal(lux.fuelCost, 122.5);
  assert.equal(lux.cabTimeCharge, 250);
  assert.equal(lux.totalFairPreGst, 422.5);
  assert.equal(lux.gstCharge, 21.13);
  assert.equal(lux.totalPayment, 443.63);
  assert.equal(lux.adminCommission, 50.7);
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
        splitRules: EXCEL_RULES,
      }),
    /Fuel price/
  );
});

test('planDeductionForRide deducts pre-GST commission + tech fee + ride GST', () => {
  const deduction = planDeductionForRide({
    platformCommission: 28.8,
    techFeeAmount: 10,
    rideGstAmount: 12,
  });
  assert.equal(deduction, 50.8);
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
    splitRules: EXCEL_RULES,
  });

  const within = calculateDistanceAdjustedPricing(mini, 10, 12, 8.5, EXCEL_RULES);
  assert.equal(within.extraKm, 0);
  assert.equal(within.extraKmChargePreGst, 0);
  assert.equal(within.billedKm, 10);
  assert.equal(within.roadDistanceKm, 8.5);
  assert.equal(within.totalFairPreGst, 240);
  assert.equal(within.totalPayment, 252);
  assert.equal(within.adminCommission, 28.8);
});

test('calculateDistanceAdjustedPricing adds extra KM charge pre-GST and recalculates CA tax & commission split', () => {
  const mini = calculatePackagePricing({
    includedKm: 10,
    includedHours: 1,
    mileageKmpl: 10,
    fuelPricePerUnit: 115,
    perDayCharge: 1000,
    baseBufferMinutes: 30,
    driverTa: 0,
    splitRules: EXCEL_RULES,
  });

  // Road distance 25 km vs 10 km included => 15 extra km * ₹12/km = ₹180 pre-GST
  // Adjusted pre-GST Total Fair = 240 + 180 = 420
  // Ride GST (5%) = 21.00 => Total Payment = 441.00
  // Admin Comm (12% of 420) = 50.40
  // GST on (50.40 + 10) @ 18% = 10.87
  // Total Company Dues Z = 21 + 50.40 + 10 + 10.87 = 92.27
  // Driver Gross Earnings = 441 - 92.27 = 348.73
  const over = calculateDistanceAdjustedPricing(mini, 10, 12, 25, EXCEL_RULES);
  assert.equal(over.extraKm, 15);
  assert.equal(over.extraKmChargePreGst, 180);
  assert.equal(over.billedKm, 25);
  assert.equal(over.roadDistanceKm, 25);
  assert.equal(over.totalFairPreGst, 420);
  assert.equal(over.gstCharge, 21);
  assert.equal(over.totalPayment, 441);
  assert.equal(over.adminCommission, 50.4);
  assert.equal(over.gstOnCommissionAndTechFee, 10.87);
  assert.equal(over.totalCompanyDuesZ, 92.27);
  assert.equal(over.driverGrossEarnings, 348.73);
});
