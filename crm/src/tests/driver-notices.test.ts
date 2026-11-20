/** Pure tests for which staff changes message the driver, and with what wording. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { driverNoticeText, statusChangeEvent, DriverNoticeEvent } from '../lib/driver-notices';

describe('driver notices', () => {
  it('approves from pending, reactivates from anything else, suspends, and skips offboarding', () => {
    assert.strictEqual(statusChangeEvent('ACTIVATE', 'PENDING_DOCS'), 'APPROVED');
    for (const s of ['SUSPENDED_DOC_EXPIRED', 'SUSPENDED_QUALITY', 'SUSPENDED_MANUAL', 'OFFBOARDED']) {
      assert.strictEqual(statusChangeEvent('ACTIVATE', s), 'REACTIVATED', s);
    }
    assert.strictEqual(statusChangeEvent('SUSPEND', 'APPROVED_ACTIVE'), 'SUSPENDED');
    assert.strictEqual(statusChangeEvent('OFFBOARD', 'APPROVED_ACTIVE'), null);
  });

  it('has a fixed, single-line message for every event', () => {
    const events: DriverNoticeEvent[] = ['APPROVED', 'REACTIVATED', 'SUSPENDED', 'OFFERS_PAUSED', 'OFFERS_RESUMED'];
    for (const e of events) {
      const text = driverNoticeText(e);
      assert.ok(text.length > 20 && text.length < 300, e);
      assert.doesNotMatch(text, /\n/, `${e} fits a template parameter`);
    }
    assert.notStrictEqual(driverNoticeText('APPROVED'), driverNoticeText('REACTIVATED'));
  });
});
