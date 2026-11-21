/** Pure tests for which manual driver status changes are allowed and how requests are checked. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { allowedActions, isActionAllowed } from '../lib/driver-status-rules';
import { parseStatusChange } from '../lib/driver-status';

describe('allowed driver status actions', () => {
  it('lets staff activate pending, document-, quality- and manually-suspended and offboarded drivers', () => {
    for (const s of ['PENDING_DOCS', 'SUSPENDED_DOC_EXPIRED', 'SUSPENDED_QUALITY', 'SUSPENDED_MANUAL', 'OFFBOARDED']) {
      assert.ok(isActionAllowed('ACTIVATE', s), s);
    }
  });
  it('never activates by hand a driver restricted for dues, or one already active', () => {
    for (const s of ['RESTRICTED_DIGITAL_ONLY', 'SUSPENDED_UNPAID_DUES', 'APPROVED_ACTIVE', 'SOMETHING_UNKNOWN']) {
      assert.strictEqual(isActionAllowed('ACTIVATE', s), false, s);
    }
  });
  it('does not repeat a suspension or offboarding', () => {
    assert.deepStrictEqual(allowedActions('SUSPENDED_MANUAL'), ['ACTIVATE', 'OFFBOARD']);
    assert.deepStrictEqual(allowedActions('OFFBOARDED'), ['ACTIVATE']);
    assert.deepStrictEqual(allowedActions('APPROVED_ACTIVE'), ['SUSPEND', 'OFFBOARD']);
    assert.deepStrictEqual(allowedActions('SUSPENDED_UNPAID_DUES'), ['SUSPEND', 'OFFBOARD']);
  });
});

describe('parseStatusChange', () => {
  it('requires a known action and a reason of sensible length', () => {
    assert.ok(!parseStatusChange({ action: 'DELETE', reason: 'Some reason' }).ok);
    assert.ok(!parseStatusChange({ action: 'SUSPEND', reason: '   ab  ' }).ok);
    assert.ok(!parseStatusChange({ action: 'SUSPEND', reason: 'x'.repeat(501) }).ok);
    const r = parseStatusChange({ action: 'SUSPEND', reason: '  Complaint under review  ' });
    assert.ok(r.ok);
    assert.strictEqual(r.change.reason, 'Complaint under review');
  });
  it('ignores document dates for suspend and offboard', () => {
    const r = parseStatusChange({ action: 'OFFBOARD', reason: 'Left the fleet', license_expiry: 'bad' });
    assert.ok(r.ok);
    assert.strictEqual(r.change.license_expiry, undefined);
  });
  it('checks document dates sent with an activation', () => {
    assert.ok(!parseStatusChange({ action: 'ACTIVATE', reason: 'Docs checked', license_expiry: '2027-02-30' }).ok);
    assert.ok(!parseStatusChange({ action: 'ACTIVATE', reason: 'Docs checked', vehicles: [{ id: 0 }] }).ok);
    assert.ok(!parseStatusChange({ action: 'ACTIVATE', reason: 'Docs checked', vehicles: [{ id: 4, insurance_expiry: '2027-01-01', fitness_expiry: '', permit_expiry: '2027-01-01' }] }).ok);
    const r = parseStatusChange({
      action: 'ACTIVATE',
      reason: 'Docs checked',
      license_expiry: '2030-01-01',
      vehicles: [{ id: '4', insurance_expiry: '2027-01-01', fitness_expiry: '2027-02-01', permit_expiry: '2027-03-01' }],
    });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.change.vehicles, [{ id: 4, insurance_expiry: '2027-01-01', fitness_expiry: '2027-02-01', permit_expiry: '2027-03-01' }]);
  });
});
