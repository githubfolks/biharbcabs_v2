/** Pure tests for booking codes. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { insertWithBookingCode, newBookingCode } from '../lib/booking-code';

const duplicate = () => Object.assign(new Error('duplicate key value violates unique constraint "crm_bookings_booking_code_key"'), {
  code: '23505', constraint: 'crm_bookings_booking_code_key',
});

describe('booking codes', () => {
  it('are BC- plus 6 characters without look-alikes', () => {
    for (let i = 0; i < 500; i++) {
      const code = newBookingCode();
      assert.match(code, /^BC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      assert.ok(code.length <= 30, 'fits crm_bookings.booking_code');
    }
  });

  it('collide rarely (old scheme: 9,000 values) and use the whole alphabet', () => {
    // 32^6 ≈ 1.07 billion codes. Expected repeats in 2,000 draws ≈ 2000² / (2 × 32^6) ≈ 0.002, so more than
    // one repeat happens by chance about once in 500,000 runs. Any repeat in real use is retried on insert.
    const draws = Array.from({ length: 2000 }, () => newBookingCode());
    assert.ok(draws.length - new Set(draws).size <= 1);
    const chars = new Set(draws.join('').replace(/BC-/g, ''));
    assert.strictEqual(chars.size, 32, 'every character of the alphabet appears');
  });

  it('an insert that hits a taken code is retried with a new code', async () => {
    const tried: string[] = [];
    const result = await insertWithBookingCode(async (code) => {
      tried.push(code);
      if (tried.length < 3) throw duplicate();
      return code;
    });
    assert.strictEqual(tried.length, 3);
    assert.strictEqual(new Set(tried).size, 3, 'a fresh code each time');
    assert.strictEqual(result, tried[2]);
  });

  it('other errors are not retried, and it gives up after 5 taken codes', async () => {
    let calls = 0;
    await assert.rejects(() => insertWithBookingCode(async () => { calls++; throw Object.assign(new Error('other'), { code: '23503' }); }), /other/);
    assert.strictEqual(calls, 1);
    calls = 0;
    await assert.rejects(() => insertWithBookingCode(async () => { calls++; throw duplicate(); }), /duplicate key/);
    assert.strictEqual(calls, 5);
  });
});
