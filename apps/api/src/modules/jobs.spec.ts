import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recurrenceDue, reportDue } from './jobs';

test('recurrenceDue', () => {
  const d = (s: string) => new Date(`${s}T10:00:00Z`);
  assert.ok(recurrenceDue('daily', d('2026-09-24'), '2026-09-25'));
  assert.ok(!recurrenceDue('daily', d('2026-09-25'), '2026-09-25'));
  assert.ok(!recurrenceDue('weekly', d('2026-09-20'), '2026-09-25'));
  assert.ok(recurrenceDue('weekly', d('2026-09-18'), '2026-09-25'));
  assert.ok(recurrenceDue('monthly', d('2026-08-31'), '2026-09-01'));
  assert.ok(!recurrenceDue(null, d('2020-01-01'), '2026-09-25'));
});

test('reportDue', () => {
  assert.ok(reportDue('daily', null, '2026-09-25', 5));
  assert.ok(!reportDue('daily', new Date('2026-09-25T02:00:00Z'), '2026-09-25', 5));
  assert.ok(reportDue('weekly', null, '2026-09-28', 1));
  assert.ok(!reportDue('weekly', null, '2026-09-25', 5));
  assert.ok(reportDue('monthly', null, '2026-10-01', 4));
});
