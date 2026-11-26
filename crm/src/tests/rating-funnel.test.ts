import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRatingOutcome } from '../lib/support-tickets';

test('classifyRatingOutcome routes 4-5 stars to Google Review and 1-3 stars to Complaint Ticket', () => {
  assert.deepEqual(classifyRatingOutcome(5, 4), { route: 'GOOGLE_REVIEW', priority: 'NORMAL' });
  assert.deepEqual(classifyRatingOutcome(4, 4), { route: 'GOOGLE_REVIEW', priority: 'NORMAL' });
  assert.deepEqual(classifyRatingOutcome(3, 4), { route: 'COMPLAINT_TICKET', priority: 'NORMAL' });
  assert.deepEqual(classifyRatingOutcome(2, 4), { route: 'COMPLAINT_TICKET', priority: 'HIGH' });
  assert.deepEqual(classifyRatingOutcome(1, 4), { route: 'COMPLAINT_TICKET', priority: 'HIGH' });
});
