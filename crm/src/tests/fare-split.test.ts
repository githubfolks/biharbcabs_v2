/** Pure tests for the fare split and GST arithmetic. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gstIncluded, gstOnTop, splitFare, splitPreGstFare } from '../lib/fare-split';
import { financialYearCode } from '../lib/gst-documents';

// 12% commission on pre-GST fare, ₹10 tech fee + 18% GST, 5% ride GST borne by the driver.
const rules = { platform_commission_pct: 12, gst_on_commission_pct: 18, ride_fare_gst_pct: 5, tech_fee_amount: 10 };

describe('fare split with GST (CA rules + pre-GST commission)', () => {
  it('pre-GST ₹240 (Mini 1hr/10km): GST ₹12, Total ₹252, Commission ₹28.80, CA share ₹57.78', () => {
    const s = splitPreGstFare(240, rules);
    assert.strictEqual(s.rideTaxableValue, 240);
    assert.strictEqual(s.rideGstAmount, 12);
    assert.strictEqual(s.customerTotalFare, 252);
    assert.strictEqual(s.platformCommission, 28.8);
    assert.strictEqual(s.techFeeAmount, 10);
    assert.strictEqual(s.gstAmount, 6.98, '18% on commission + tech fee together');
    assert.strictEqual(s.totalCompanyDuesZ, 57.78);
    assert.strictEqual(s.driverGrossEarnings, 194.22);
  });

  it('the parts always add up to the fare, and BiharCabs keeps commission + fee after paying all GST', () => {
    for (const fare of [100, 499, 2500, 3333, 10000]) {
      const s = splitFare(fare, rules);
      assert.strictEqual(Math.round((s.totalCompanyDuesZ + s.driverGrossEarnings) * 100) / 100, fare);
      const keptAfterGst = Math.round((s.totalCompanyDuesZ - s.rideGstAmount - s.gstAmount) * 100) / 100;
      assert.strictEqual(keptAfterGst, Math.round((s.platformCommission + s.techFeeAmount) * 100) / 100, `fare ${fare}`);
    }
  });

  it('GST helpers: included vs on top', () => {
    assert.strictEqual(gstIncluded(10, 18), 1.53);
    assert.strictEqual(gstOnTop(10, 18), 1.8);
    assert.strictEqual(gstIncluded(200, 5), 9.52);
  });
});

describe('receipt voucher financial year', () => {
  it('switches on 1 April, India time', () => {
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:00:00Z')), '2627', '31 Mar 23:30 IST');
    assert.strictEqual(financialYearCode(new Date('2027-03-31T18:31:00Z')), '2728', '1 Apr 00:01 IST');
    assert.strictEqual(financialYearCode(new Date('2026-11-18T10:00:00Z')), '2627');
  });
});
