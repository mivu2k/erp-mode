import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalated, matches, stepComplete } from './workflow.service';

test('workflow condition matching', () => {
  assert.ok(matches(null, {}, 0));
  assert.ok(matches({ minAmount: 1000, maxAmount: 5000 }, {}, 1000));
  assert.ok(!matches({ minAmount: 1000 }, {}, 999));
  assert.ok(!matches({ maxAmount: 5000 }, {}, 5000.01));
  assert.ok(matches({ equals: { kind: 'salary' }, branchId: 'b' }, { kind: 'salary', branchId: 'b' }, 0));
  assert.ok(!matches({ equals: { kind: 'salary' } }, { kind: 'expense' }, 0));
});

test('parallel (all) steps, delegation and escalation', () => {
  const all = { name: 's', approverType: 'role' as const, mode: 'all' as const };
  const none = new Map<string, string>();
  assert.ok(!stepComplete(all, ['a', 'b'], new Set(['a']), none, []));
  assert.ok(stepComplete(all, ['a', 'b'], new Set(['a', 'b']), none, []));
  assert.ok(stepComplete(all, ['a', 'b'], new Set(['a', 'd']), new Map([['b', 'd']]), [])); // d covers for b
  assert.ok(stepComplete(all, ['a', 'b'], new Set(['x']), none, ['x'])); // escalation closes it
  assert.ok(stepComplete({ ...all, mode: 'any' }, ['a', 'b'], new Set(['b']), none, []));
  const esc = { ...all, escalateAfterHours: 2, escalateToRoleId: 'r' };
  assert.ok(!escalated(esc, new Date(0), 3_600_000));
  assert.ok(escalated(esc, new Date(0), 2 * 3_600_000));
  assert.ok(!escalated(all, new Date(0), 1e12));
});
