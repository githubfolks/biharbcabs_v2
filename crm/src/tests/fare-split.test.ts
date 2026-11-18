/** Pure tests for the fare split and GST arithmetic. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gstIncluded, gstOnTop, splitFare } from '../lib/fare-split';
import { financialYearCode } from '../lib/advance-payments';

// The figures agreed with the owner: 3% commission, ₹10 tech fee + 18% GST, 5% ride GST borne by the driver.
const rules = { platform_commission_pct: 3, gst_on_commission_pct: 18, ride_fare_gst_pct: 5, tech_fee_amount: 10, advance_token_percentage: 10, min_advance_amount: 200 };

describe('fare split with GST (CA rules)', () => {
  it('₹2,500 ride: BiharCabs share ₹219.35, driver keeps ₹2,280.65', () => {
    const s = splitFare(2500, rules);
    assert.strictEqual(s.rideGstAmount, 119.05, '5% included in the fare');
    assert.strictEqual(s.rideTaxableValue, 2380.95);
    assert.strictEqual(s.platformCommission, 75);
    assert.strictEqual(s.techFeeAmount, 10);
    assert.strictEqual(s.gstAmount, 15.3, '18% on commission + tech fee together');
    assert.strictEqual(s.totalCompanyDuesZ, 219.35);
    assert.strictEqual(s.driverGrossEarnings, 2280.65);
  });

  it('the parts always add up to the fare, and BiharCabs keeps commission + fee after paying all GST', () => {
    for (const fare of [100, 499, 2500, 3333, 10000]) {
      const s = splitFare(fare, rules);
      assert.strictEqual(Math.round((s.totalCompanyDuesZ + s.driverGrossEarnings) * 100) / 100, fare);
      const keptAfterGst = Math.round((s.totalCompanyDuesZ - s.rideGstAmount - s.gstAmount) * 100) / 100;
      assert.strictEqual(keptAfterGst, s.platformCommission + s.techFeeAmount, `fare ${fare}`);
    }
  });

  it('the advance still covers BiharCabs share on advance rides', () => {
    for (const fare of [500, 2500, 10000]) {
      const s = splitFare(fare, rules);
      assert.ok(s.advanceTokenAmount >= s.totalCompanyDuesZ, `fare ${fare}: advance ${s.advanceTokenAmount} vs share ${s.totalCompanyDuesZ}`);
    }
  });

  it('GST helpers: included vs on top', () => {
    assert.strictEqual(gstIncluded(10, 18), 1.53);
    assert.strictEqual(gstOnTop(10, 18), 1.8);
    assert.strictEqual(gstIncluded(200, 5), 9.52);
    assert.strictEqual(gstIncluded(250, 18), 38.14, '18% GST inside a ₹250 advance');
  });
});

describe('receipt voucher financial year', () => {
  it('switches on 1 April, India time', () => {
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:00:00Z')), '2627', '31 Mar 23:30 IST');
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:31:00Z')), '2728', '1 Apr 00:01 IST');
    assert.strictEqual(financialYearCode(new Date('2026-11-18T10:00:00Z')), '2627');
  });
});
