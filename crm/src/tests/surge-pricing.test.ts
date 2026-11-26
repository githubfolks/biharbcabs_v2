import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSurgeRules, isTimeInWindow, PricingRule } from '../lib/surge-pricing';

const nightRule: PricingRule = {
  id: 1,
  name: 'Late Night Surcharge (10 PM - 5 AM)',
  rule_type: 'NIGHT',
  booking_type: null,
  origin_city: null,
  cab_category: null,
  start_date: null,
  end_date: null,
  start_time: '22:00',
  end_time: '05:00',
  adjustment_type: 'FLAT',
  adjustment_value: 250,
  priority: 10,
  is_active: true,
};

const festivalRule: PricingRule = {
  id: 2,
  name: 'Chhath Puja Peak (+20%)',
  rule_type: 'FESTIVAL',
  booking_type: 'OUTSTATION',
  origin_city: 'Patna',
  cab_category: null,
  start_date: '2026-11-14',
  end_date: '2026-11-18',
  start_time: null,
  end_time: null,
  adjustment_type: 'PERCENT',
  adjustment_value: 20,
  priority: 20,
  is_active: true,
};

test('isTimeInWindow handles overnight windows crossing midnight', () => {
  assert.equal(isTimeInWindow('23:30', '22:00', '05:00'), true);
  assert.equal(isTimeInWindow('03:15', '22:00', '05:00'), true);
  assert.equal(isTimeInWindow('14:00', '22:00', '05:00'), false);
});

test('evaluateSurgeRules stacks matching festival and night rules cleanly', () => {
  const res = evaluateSurgeRules(2000, [nightRule, festivalRule], {
    bookingType: 'OUTSTATION',
    originCity: 'Patna',
    pickupDate: '2026-11-15',
    pickupTime: '23:00',
  });
  // +20% (400) + flat 250 = 650
  assert.equal(res.surgeAmountPreGst, 650);
  assert.equal(res.adjustedPreGst, 2650);
  assert.equal(res.appliedRules.length, 2);

  // Daytime outside festival window -> 0 surge
  const normal = evaluateSurgeRules(2000, [nightRule, festivalRule], {
    bookingType: 'OUTSTATION',
    originCity: 'Patna',
    pickupDate: '2026-11-26',
    pickupTime: '11:00',
  });
  assert.equal(normal.surgeAmountPreGst, 0);
  assert.equal(normal.adjustedPreGst, 2000);
});
