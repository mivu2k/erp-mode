import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackChanges, warrantyEnd, warrantyStatus } from './serials';

test('warranty end and status', () => {
  assert.equal(warrantyEnd(new Date('2026-01-31T10:00:00Z'), 12).toISOString().slice(0, 10), '2027-01-31');
  const now = new Date('2026-09-25T12:00:00Z');
  assert.deepEqual(warrantyStatus(null, now), { state: 'none', daysLeft: null });
  assert.equal(warrantyStatus(new Date('2027-01-01T00:00:00Z'), now).state, 'active');
  assert.deepEqual(warrantyStatus(new Date('2026-10-10T00:00:00Z'), now), { state: 'expiring', daysLeft: 15 });
  assert.equal(warrantyStatus(new Date('2026-09-25T00:00:00Z'), now).state, 'expiring', 'last day still covered');
  assert.equal(warrantyStatus(new Date('2026-09-24T00:00:00Z'), now).state, 'expired');
});

test('trackChanges lists only changed tracked fields', () => {
  assert.equal(trackChanges({ status: 'in_stock', location: null, notes: 'a' }, { status: 'demo', location: 'Site B', notes: 'b' }), 'Status: in stock → demo · Location: — → Site B');
  assert.equal(trackChanges({ status: 'demo', location: '' }, { status: 'demo', location: null }), '');
});
