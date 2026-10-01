import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFields, evalExpr } from './autofill';

const meta = { resources: [] } as never;

test('evalExpr: field, chained difference, literal', async () => {
  assert.equal(await evalExpr('cost', { cost: '5000' }, 'x', meta), '5000');
  assert.equal(await evalExpr('qty-returnedQty-soldQty', { qty: '5', returnedQty: '1', soldQty: '1.5' }, 'x', meta), 2.5);
  assert.equal(await evalExpr('=ok', {}, 'x', meta), 'ok');
  assert.equal(await evalExpr('value.rate', { value: { rate: 18 } }, 'x', meta), 18);
});

test('computeFields: inclusive leave days', () => {
  assert.deepEqual(computeFields({ days: 'days(from,to)' }, { from: '2026-10-01', to: '2026-10-03' }), { days: '3' });
  assert.deepEqual(computeFields({ days: 'days(from,to)' }, { from: '2026-10-03', to: '2026-10-01' }), {});
});
