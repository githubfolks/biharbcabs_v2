import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAgingBucket,
  computeNetPlatformRevenue,
  resolveDateRange,
  toCsv,
} from '../lib/financial-reports';

test('classifyAgingBucket maps overdue days into exact AR buckets', () => {
  assert.equal(classifyAgingBucket(0), '0-7d');
  assert.equal(classifyAgingBucket(7), '0-7d');
  assert.equal(classifyAgingBucket(8), '8-15d');
  assert.equal(classifyAgingBucket(15), '8-15d');
  assert.equal(classifyAgingBucket(16), '16-30d');
  assert.equal(classifyAgingBucket(30), '16-30d');
  assert.equal(classifyAgingBucket(31), '30+d');
});

test('computeNetPlatformRevenue excludes GST liability and deducts incentives', () => {
  assert.equal(
    computeNetPlatformRevenue({
      commissionRevenue: 1200.5,
      techFeeRevenue: 150,
      forfeitedCharges: 200,
      incentivesPaid: 100.25,
    }),
    1450.25
  );
});

test('resolveDateRange swaps inverted ranges and preserves valid dates', () => {
  assert.deepEqual(resolveDateRange('2026-11-20', '2026-11-01'), {
    from: '2026-11-01',
    to: '2026-11-20',
  });
  assert.deepEqual(resolveDateRange('2026-04-01', '2026-04-30'), {
    from: '2026-04-01',
    to: '2026-04-30',
  });
});

test('toCsv escapes quotes/commas and neutralizes spreadsheet formula injection', () => {
  const csv = toCsv(
    ['Name', 'Amount', 'Note'],
    [
      ['Ravi, "Kumar"', 1250.5, '=HYPERLINK("http://evil")'],
      ['Amit', -50, '+cmd'],
    ]
  );
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Name,Amount,Note');
  assert.equal(lines[1], '"Ravi, ""Kumar""",1250.5,"\'=HYPERLINK(""http://evil"")"');
  assert.equal(lines[2], "Amit,-50,'+cmd");
});
