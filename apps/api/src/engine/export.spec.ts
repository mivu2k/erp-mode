import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from './export';

test('csv escapes quotes, commas, formulas and uses ref titles', () => {
  const csv = toCsv(['a', 'b', 'c'], [{ a: 'x,"y"', b: '=SUM(A1)', c: 'id1', _refs: { c: 'Sales' } }]);
  assert.equal(csv, '﻿a,b,c\r\n"x,""y""",\'=SUM(A1),Sales');
});

test('cell formats booleans, dates and string lists for humans', async () => {
  const { cell } = await import('./export');
  assert.equal(cell({ a: true, b: false }, 'a'), 'Yes');
  assert.equal(cell({ d: new Date('2026-09-25T00:00:00Z') }, 'd'), '2026-09-25');
  assert.equal(cell({ d: new Date('2026-09-25T09:27:13.890Z') }, 'd'), '2026-09-25 09:27');
  assert.equal(cell({ l: ['Battery', 'Antenna'] }, 'l'), 'Battery, Antenna');
});
