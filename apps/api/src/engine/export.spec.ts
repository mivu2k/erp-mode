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

test('exports read in the company timezone, with worded headers and values', async () => {
  const { cell } = await import('./export');
  assert.equal(cell({ d: new Date('2026-09-25T04:25:00Z') }, 'd', { tz: 'Asia/Karachi' }), '2026-09-25 09:25', '04:25 UTC is 09:25 in Karachi');
  assert.equal(cell({ d: new Date('2026-09-25T00:00:00Z') }, 'd', { tz: 'Asia/Karachi' }), '2026-09-25', 'plain dates stay as they are');
  assert.equal(cell({ s: 'in_repair' }, 's', { values: { s: (v) => v.replace('_', ' ') } }), 'in repair');
  const csv = toCsv(['customerId'], [{ customerId: 'x', _refs: { customerId: 'Ali' } }], { headers: ['Customer'] });
  assert.equal(csv, '﻿Customer\r\nAli');
});
