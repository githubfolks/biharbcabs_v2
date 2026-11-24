/** Pure tests for the fare split and GST arithmetic. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gstIncluded, gstOnTop, splitFare, splitPreGstFare } from '../lib/fare-split';
import { financialYearCode } from '../lib/gst-documents';

// 10% commission on pre-GST Total Fair (deducted from driver), 5% Ride GST + ₹10 Platform Charge added to customer bill.
const rules = { platform_commission_pct: 10, gst_on_commission_pct: 0, ride_fare_gst_pct: 5, tech_fee_amount: 10 };

describe('fare split with GST, 10% commission & ₹10 platform charge', () => {
  it('Patna to Darbhanga (Total Fair ₹3,000): GST ₹150, Platform ₹10, Customer ₹3,160, Comm ₹300, Driver ₹2,700', () => {
    const s = splitPreGstFare(3000, rules);
    assert.strictEqual(s.rideTaxableValue, 3000);
    assert.strictEqual(s.rideGstAmount, 150);
    assert.strictEqual(s.techFeeAmount, 10);
    assert.strictEqual(s.customerTotalFare, 3160);
    assert.strictEqual(s.platformCommission, 300);
    assert.strictEqual(s.gstAmount, 0);
    assert.strictEqual(s.totalCompanyDuesZ, 460);
    assert.strictEqual(s.driverGrossEarnings, 2700);

    // Inverse splitFare(3160) recovers the exact same breakdown
    const inv = splitFare(3160, rules);
    assert.deepStrictEqual(inv, s);
  });

  it('pre-GST ₹240 (Mini 1hr/10km): GST ₹12, Platform ₹10, Customer ₹262, Comm ₹24, Driver ₹216', () => {
    const s = splitPreGstFare(240, rules);
    assert.strictEqual(s.rideTaxableValue, 240);
    assert.strictEqual(s.rideGstAmount, 12);
    assert.strictEqual(s.techFeeAmount, 10);
    assert.strictEqual(s.customerTotalFare, 262);
    assert.strictEqual(s.platformCommission, 24);
    assert.strictEqual(s.gstAmount, 0);
    assert.strictEqual(s.totalCompanyDuesZ, 46);
    assert.strictEqual(s.driverGrossEarnings, 216);
  });

  it('the parts always add up to customerTotalFare, and driver earns Total Fair - Admin Commission', () => {
    for (const preGst of [240, 500, 1250, 3000, 8750]) {
      const s = splitPreGstFare(preGst, rules);
      assert.strictEqual(Math.round((s.totalCompanyDuesZ + s.driverGrossEarnings) * 100) / 100, s.customerTotalFare);
      assert.strictEqual(s.driverGrossEarnings, Math.round((s.rideTaxableValue - s.platformCommission) * 100) / 100);
    }
  });

  it('GST helpers: included vs on top', () => {
    assert.strictEqual(gstIncluded(10, 18), 1.53);
    assert.strictEqual(gstOnTop(10, 18), 1.8);
    assert.strictEqual(gstIncluded(3150, 5), 150);
  });
});

describe('receipt voucher financial year', () => {
  it('switches on 1 April, India time', () => {
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:00:00Z')), '2627', '31 Mar 23:30 IST');
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:31:00Z')), '2728', '1 Apr 00:01 IST');
    assert.strictEqual(financialYearCode(new Date('2026-11-18T10:00:00Z')), '2627');
  });
});
