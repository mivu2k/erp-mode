import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCalc, bindParams, reportSchema } from './reports';

test('bindParams replaces $params deeply', () => {
  assert.deepEqual(bindParams({ date: { gte: '$from', lte: '$to' }, status: 'paid' }, { from: '2026-01-01', to: '2026-01-31' }), { date: { gte: '2026-01-01', lte: '2026-01-31' }, status: 'paid' });
});

test('applyCalc', () => {
  assert.deepEqual(applyCalc([{ a: 10, b: 4 }, { a: 1, b: 0 }], [{ name: 'r', a: 'a', op: '/', b: 'b' }]).map((r) => r.r), [2.5, null]);
});

test('report schema rejects unsafe calc names', () => {
  assert.throws(() => reportSchema.parse({ resource: 'x', calc: [{ name: 'a; drop', a: 1, op: '+', b: 2 }] }));
});
