import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeRateLimit, _resetRateLimitBucketsForTest } from '../lib/rate-limit';
import { sanitizeAuditPayload } from '../lib/audit-log';

test('consumeRateLimit allows up to limit and blocks subsequent hits with Retry-After', () => {
  _resetRateLimitBucketsForTest();
  const r1 = consumeRateLimit('test:ip:1.2.3.4', 2, 60_000);
  const r2 = consumeRateLimit('test:ip:1.2.3.4', 2, 60_000);
  const r3 = consumeRateLimit('test:ip:1.2.3.4', 2, 60_000);

  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
  assert.ok(r3.retryAfterSeconds >= 1);

  // Different key is unaffected
  const other = consumeRateLimit('test:ip:5.6.7.8', 2, 60_000);
  assert.equal(other.allowed, true);
});

test('sanitizeAuditPayload redacts secrets recursively while keeping non-sensitive fields', () => {
  const input = {
    email: 'admin@biharcabs.com',
    password_hash: 'supersecret',
    nested: {
      access_token: 'EAAB...',
      api_key: 'pk_live_123',
      safe_label: 'LocationIQ',
    },
  };
  const out = sanitizeAuditPayload(input) as Record<string, any>;
  assert.equal(out.email, 'admin@biharcabs.com');
  assert.equal(out.password_hash, '[REDACTED]');
  assert.equal(out.nested.access_token, '[REDACTED]');
  assert.equal(out.nested.api_key, '[REDACTED]');
  assert.equal(out.nested.safe_label, 'LocationIQ');
});
