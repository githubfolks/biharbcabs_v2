/** Pure tests for the document dates and UPI ID checked at driver onboarding. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isIsoDate, validateOnboardingDocs } from '../lib/driver-onboarding';

const vehicle = { wp_vehicle_code: 'sedan', registration_no: 'BR01AB1234', insurance_expiry: '2027-03-31', fitness_expiry: '2027-04-30', permit_expiry: '2027-05-31' };
const valid = { license_expiry: '2029-06-15', bank_upi_id: '', vehicle };

describe('isIsoDate', () => {
  it('accepts real YYYY-MM-DD dates', () => {
    assert.ok(isIsoDate('2028-02-29'));
  });
  it('rejects impossible, empty and other formats', () => {
    for (const v of ['2027-02-29', '2027-13-01', '', '31-12-2027', '2027/12/31', null, undefined, 20271231]) {
      assert.strictEqual(isIsoDate(v), false, String(v));
    }
  });
});

describe('validateOnboardingDocs', () => {
  it('passes through the dates the admin entered', () => {
    const r = validateOnboardingDocs(valid);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.docs, {
      license_expiry: '2029-06-15',
      bank_upi_id: null,
      vehicle: { insurance_expiry: '2027-03-31', fitness_expiry: '2027-04-30', permit_expiry: '2027-05-31' },
    });
  });

  it('rejects a missing licence expiry', () => {
    const r = validateOnboardingDocs({ ...valid, license_expiry: '' });
    assert.ok(!r.ok);
    assert.match(r.error, /license_expiry/);
  });

  it('rejects a vehicle with any missing document date', () => {
    for (const field of ['insurance_expiry', 'fitness_expiry', 'permit_expiry']) {
      const r = validateOnboardingDocs({ ...valid, vehicle: { ...vehicle, [field]: '' } });
      assert.ok(!r.ok, field);
      assert.match(r.error, new RegExp(`vehicle.${field}`));
    }
  });

  it('needs no vehicle dates when no vehicle is sent', () => {
    const r = validateOnboardingDocs({ license_expiry: '2029-06-15' });
    assert.ok(r.ok);
    assert.strictEqual(r.docs.vehicle, null);
  });

  it('keeps a valid UPI ID trimmed and rejects a malformed one', () => {
    const good = validateOnboardingDocs({ ...valid, bank_upi_id: '  ramesh.k@okaxis ' });
    assert.ok(good.ok);
    assert.strictEqual(good.docs.bank_upi_id, 'ramesh.k@okaxis');

    for (const bad of ['ramesh', 'ramesh@', '@okaxis', 'a@b c']) {
      const r = validateOnboardingDocs({ ...valid, bank_upi_id: bad });
      assert.ok(!r.ok, bad);
      assert.match(r.error, /bank_upi_id/);
    }
  });
});
