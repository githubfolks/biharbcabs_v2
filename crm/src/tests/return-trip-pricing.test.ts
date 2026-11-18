/** Pure tests for return-trip money rules and pickup-time parsing. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { applyReturnDiscount, checkReturnTripPolicy, companyAbsorbsDiscount, returnDiscountAmount } from '../lib/return-trip-pricing';
import { formatPickup, parsePickupTime, pickupMoment } from '../lib/pickup-time';
import { splitFare } from '../lib/fare-split';

// Sample figures for checking arithmetic only; they are not BiharCabs settings.
const rules = { platform_commission_pct: 3, gst_on_commission_pct: 18, ride_fare_gst_pct: 5, tech_fee_amount: 10, advance_token_percentage: 10, min_advance_amount: 200 };
const split = (fare: number) => splitFare(fare, rules);
const policy = (over: any = {}) => checkReturnTripPolicy({ enabled: true, discount_type: 'PERCENT', discount_value: 10, exclusive_window_minutes: 10, return_status_hours: 6, ...over }).policy;

describe('return trip policy', () => {
  it('is inactive until every number is set', () => {
    assert.strictEqual(checkReturnTripPolicy({ enabled: true }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ enabled: true, discount_value: 10, exclusive_window_minutes: 10 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ enabled: true, discount_value: 10, exclusive_window_minutes: 10, return_status_hours: 6 }).active, true);
  });
  it('stays inactive when switched off', () => {
    assert.strictEqual(checkReturnTripPolicy({ enabled: false, discount_value: 10, exclusive_window_minutes: 10, return_status_hours: 6 }).active, false);
  });
  it('rejects bad values', () => {
    const base = { enabled: true, exclusive_window_minutes: 10, return_status_hours: 6 };
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: 0 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: -5 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: 100 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: 'abc' }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: 10, exclusive_window_minutes: 0 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_value: 10, return_status_hours: 72 }).active, false);
    assert.strictEqual(checkReturnTripPolicy({ ...base, discount_type: 'FLAT', discount_value: 500 }).active, true);
  });
  it('accepts numbers saved as text', () => {
    assert.strictEqual(checkReturnTripPolicy({ enabled: true, discount_value: '10', exclusive_window_minutes: '10', return_status_hours: '6' }).active, true);
  });
});

describe('return trip discount', () => {
  it('works out percentage and flat amounts', () => {
    assert.strictEqual(returnDiscountAmount(3000, policy()), 300);
    assert.strictEqual(returnDiscountAmount(3000, policy({ discount_type: 'FLAT', discount_value: 250 })), 250);
  });

  it('company pays up to its commission and the driver covers the rest', () => {
    // Full fare 3000: ride GST 142.86, commission 90, fee 10, GST on both 18 -> share 260.86, driver 2739.14
    const s = split(3000);
    assert.strictEqual(s.totalCompanyDuesZ, 260.86);
    const r = applyReturnDiscount(s, policy(), rules)!;
    assert.strictEqual(r.discountAmount, 300);
    assert.strictEqual(r.companyShare, 90);
    assert.strictEqual(r.split.platformCommission, 0);
    assert.strictEqual(r.split.gstAmount, 1.8, 'GST on the tech fee remains');
    assert.strictEqual(r.split.customerTotalFare, 2700);
    assert.strictEqual(r.split.rideGstAmount, 128.57, 'ride GST on the discounted fare');
    assert.strictEqual(r.split.totalCompanyDuesZ, 140.37);
    assert.strictEqual(r.split.driverGrossEarnings, 2559.63);
    assert.strictEqual(r.driverShare, 179.51);
    // The discount is covered by BiharCabs' commission, the driver, and the GST that falls with the fare.
    const taxSaved = (s.gstAmount - r.split.gstAmount) + (s.rideGstAmount - r.split.rideGstAmount);
    assert.strictEqual(Math.round((r.companyShare + r.driverShare + taxSaved) * 100) / 100, 300);
  });

  it('a small discount comes entirely from company commission', () => {
    const s = split(3000);
    const r = applyReturnDiscount(s, policy({ discount_type: 'FLAT', discount_value: 50 }), rules)!;
    assert.strictEqual(r.companyShare, 50);
    assert.strictEqual(r.split.platformCommission, 40);
    assert.strictEqual(r.split.gstAmount, 9, '18% of commission 40 + fee 10');
    assert.ok(r.driverShare < 0, 'driver gains slightly because GST falls with the commission and the fare');
  });

  it('customer pays exactly the discounted fare, and money adds up', () => {
    for (const fare of [800, 1500, 3000, 7777, 20000]) {
      const s = split(fare);
      const r = applyReturnDiscount(s, policy(), rules)!;
      assert.strictEqual(r.split.customerTotalFare, fare - r.discountAmount);
      assert.strictEqual(Math.round((r.split.totalCompanyDuesZ + r.split.driverGrossEarnings) * 100) / 100, r.split.customerTotalFare);
      assert.strictEqual(r.split.advanceTokenAmount + r.split.balanceCashDueFromCustomer, r.split.customerTotalFare);
      assert.ok(r.split.platformCommission >= 0);
    }
  });

  it('advance token is recalculated on the discounted fare', () => {
    const r = applyReturnDiscount(split(5000), policy(), rules)!;
    assert.strictEqual(r.split.advanceTokenAmount, 450);
  });

  it('refuses discounts that would wipe out the fare or the driver payout', () => {
    assert.strictEqual(applyReturnDiscount(split(500), policy({ discount_type: 'FLAT', discount_value: 500 }), rules), null);
    assert.strictEqual(applyReturnDiscount(split(500), policy({ discount_type: 'FLAT', discount_value: 495 }), rules), null);
    assert.strictEqual(applyReturnDiscount(split(0), policy(), rules), null);
  });

  it('company absorbs the whole discount for a regular driver', () => {
    const s = split(3000);
    const r = applyReturnDiscount(s, policy(), rules)!;
    const absorbed = companyAbsorbsDiscount(r.split.driverGrossEarnings, r.split.totalCompanyDuesZ, r.driverShare);
    assert.strictEqual(absorbed.driverPayout, s.driverGrossEarnings);
    assert.strictEqual(Math.round((absorbed.driverPayout + absorbed.companyDues) * 100) / 100, r.split.customerTotalFare);
  });
});

describe('pickup time', () => {
  // 2026-11-07 10:00 IST
  const now = new Date(Date.UTC(2026, 10, 7, 4, 30));
  const t = (s: string) => { const p = parsePickupTime(s, now); return p ? `${p.date} ${p.time}` : null; };

  it('reads common replies', () => {
    assert.strictEqual(t('now'), '2026-11-07 10:00');
    assert.strictEqual(t('NOW'), '2026-11-07 10:00');
    assert.strictEqual(t('today 6:30 pm'), '2026-11-07 18:30');
    assert.strictEqual(t('today 6.30pm'), '2026-11-07 18:30');
    assert.strictEqual(t('tomorrow 9 am'), '2026-11-08 09:00');
    assert.strictEqual(t('Tomorrow 09:30'), '2026-11-08 09:30');
    assert.strictEqual(t('12/11 7:30 pm'), '2026-11-12 19:30');
    assert.strictEqual(t('12-11-2026 18:30'), '2026-11-12 18:30');
    assert.strictEqual(t('2026-11-12 18:30'), '2026-11-12 18:30');
    assert.strictEqual(t('12 pm'), '2026-11-07 12:00');
    assert.strictEqual(t('12 am'), '2026-11-08 00:00');
  });

  it('a time already passed today means tomorrow', () => {
    assert.strictEqual(t('8 am'), '2026-11-08 08:00');
  });

  it('a day-month already passed means next year, within the booking limit', () => {
    const dec28 = new Date(Date.UTC(2026, 11, 28, 4, 30));
    const p = parsePickupTime('02/01 9 am', dec28);
    assert.strictEqual(p ? `${p.date} ${p.time}` : null, '2027-01-02 09:00');
    assert.strictEqual(t('01/02 9 am'), null, 'February is beyond the 60-day limit');
  });

  it('rejects unclear or impossible times', () => {
    for (const bad of ['', 'soon', '6', 'today', 'today 25:00', '13 pm', '31/02 9 am', '2026-11-01 09:00', 'today 8 am', '2027-06-01 09:00', 'kal subah']) {
      assert.strictEqual(t(bad), null, bad);
    }
  });

  it('round-trips through stored date and time', () => {
    const p = parsePickupTime('tomorrow 9 am', now)!;
    assert.strictEqual(pickupMoment(p.date, p.time)?.getTime(), p.at.getTime());
    assert.strictEqual(pickupMoment('2026-11-08', '09:00:00')?.getTime(), p.at.getTime());
    assert.strictEqual(formatPickup(p.at), 'Sun 8 Nov, 9:00 AM');
  });
});
