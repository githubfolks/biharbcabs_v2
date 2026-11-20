/** Pure tests for driver and vehicle edit validation. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { diffValues, maskAccount, parseDriverDetails, parsePayoutDetails, parseVehicleInput } from '../lib/driver-edits';

describe('parseDriverDetails', () => {
  it('keeps only the fields sent, cleaned', () => {
    const r = parseDriverDetails({ phone: '+91 70709-92170', license_number: ' br-01 ', full_name: ' Sunil ' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.value, { phone: '917070992170', license_number: 'BR-01', full_name: 'Sunil' });
  });
  it('rejects bad phones, empty names, bad dates and empty requests', () => {
    assert.ok(!parseDriverDetails({ phone: '12345' }).ok);
    assert.ok(!parseDriverDetails({ full_name: '   ' }).ok);
    assert.ok(!parseDriverDetails({ license_expiry: '' }).ok);
    assert.ok(!parseDriverDetails({ license_expiry: '2027-02-30' }).ok);
    assert.ok(!parseDriverDetails({}).ok);
  });
  it('ignores payout fields, which have their own permission', () => {
    const r = parseDriverDetails({ base_city: 'Gaya', bank_upi_id: 'x@y' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.value, { base_city: 'Gaya' });
  });
  it('lets the licence number be cleared', () => {
    const r = parseDriverDetails({ license_number: '' });
    assert.ok(r.ok);
    assert.strictEqual(r.value.license_number, null);
  });
});

describe('parsePayoutDetails', () => {
  it('accepts valid values and clears empty ones', () => {
    const r = parsePayoutDetails({ bank_upi_id: 'ramesh@okaxis', bank_account_number: '1234 5678 9012', bank_ifsc: 'sbin0001234' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.value, { bank_upi_id: 'ramesh@okaxis', bank_account_number: '123456789012', bank_ifsc: 'SBIN0001234' });
    const cleared = parsePayoutDetails({ bank_upi_id: '' });
    assert.ok(cleared.ok);
    assert.strictEqual(cleared.value.bank_upi_id, null);
  });
  it('rejects malformed UPI, account and IFSC', () => {
    assert.ok(!parsePayoutDetails({ bank_upi_id: 'ramesh' }).ok);
    assert.ok(!parsePayoutDetails({ bank_account_number: '12AB' }).ok);
    assert.ok(!parsePayoutDetails({ bank_ifsc: 'SBIN1001234' }).ok);
    assert.ok(!parsePayoutDetails({ full_name: 'x' }).ok, 'no payout fields sent');
  });
});

describe('parseVehicleInput', () => {
  const add = { registration_no: 'br-01-pk-9821', wp_vehicle_code: 'Sedan', model_name: 'Dzire', insurance_expiry: '2027-01-01', fitness_expiry: '2027-01-02', permit_expiry: '2027-01-03' };
  it('needs every field to add a vehicle, normalised', () => {
    const r = parseVehicleInput(add, 'add');
    assert.ok(r.ok);
    assert.strictEqual(r.value.registration_no, 'BR-01-PK-9821');
    assert.strictEqual(r.value.wp_vehicle_code, 'sedan');
    for (const f of Object.keys(add)) {
      assert.ok(!parseVehicleInput({ ...add, [f]: '' }, 'add').ok, f);
    }
  });
  it('edits only the fields sent and never the registration number', () => {
    const r = parseVehicleInput({ permit_expiry: '2028-05-05' }, 'edit');
    assert.ok(r.ok);
    assert.deepStrictEqual(r.value, { permit_expiry: '2028-05-05' });
    assert.ok(!parseVehicleInput({ registration_no: 'BR01X1' }, 'edit').ok);
    assert.ok(!parseVehicleInput({ fitness_expiry: '' }, 'edit').ok);
    assert.ok(!parseVehicleInput({}, 'edit').ok);
  });
});

describe('diffValues and maskAccount', () => {
  it('lists only changed fields', () => {
    assert.deepStrictEqual(diffValues({ a: 'x', b: null, c: 'z' }, { a: 'x', b: 'y', c: null }), {
      b: { from: null, to: 'y' },
      c: { from: 'z', to: null },
    });
    assert.deepStrictEqual(diffValues({ a: 'x' }, { a: 'x' }), {});
  });
  it('shows only the last 4 digits of an account', () => {
    assert.strictEqual(maskAccount('123456789012'), '****9012');
    assert.strictEqual(maskAccount(null), null);
  });
});
