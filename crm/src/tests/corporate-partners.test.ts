import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCorporateCreditLimit,
  computePartnerCommission,
  normalizeReferralCode,
} from '../lib/b2b-partners';

test('checkCorporateCreditLimit enforces credit limit accurately', () => {
  assert.deepEqual(
    checkCorporateCreditLimit({ creditLimit: 50000, currentOutstanding: 45000, bookingFare: 4000 }),
    { allowed: true, projectedOutstanding: 49000, remainingCredit: 5000 }
  );
  assert.deepEqual(
    checkCorporateCreditLimit({ creditLimit: 50000, currentOutstanding: 48000, bookingFare: 4000 }),
    { allowed: false, projectedOutstanding: 52000, remainingCredit: 2000 }
  );
});

test('computePartnerCommission supports percentage and flat commissions', () => {
  assert.equal(computePartnerCommission({ farePreGst: 2500, commissionType: 'PERCENT', commissionValue: 5 }), 125);
  assert.equal(computePartnerCommission({ farePreGst: 2500, commissionType: 'FLAT', commissionValue: 150 }), 150);
  assert.equal(normalizeReferralCode('  hotel-maurya 01! '), 'HOTEL-MAURYA01');
});
