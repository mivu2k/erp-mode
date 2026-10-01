import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIncome } from './repair';

test('splitIncome spreads discount across labor and parts', () => {
  const s = splitIncome([{ kind: 'labor', refId: 'l', description: 'Labor', qty: 1, price: 1000, taxRate: 0 }, { kind: 'part', refId: 'p', description: 'Screen', qty: 1, price: 3000, taxRate: 0 }], 400);
  assert.equal(s.laborNet, 90000);
  assert.equal(s.partsNet, 270000);
  assert.equal(s.laborNet + s.partsNet + s.tax, s.total);
});
