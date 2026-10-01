import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billAmounts, consumption, expectedDate, monthCells, unitsBetween } from './utilities';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test('consumption: first reading, normal, meter replaced, lower reading rejected', () => {
  assert.equal(consumption(null, 1200), 0);
  assert.equal(consumption(1200, 1450.5), 250.5);
  assert.equal(consumption(98000, 35, true), 35);
  assert.throws(() => consumption(1450, 1400), /lower than the previous/);
});

test('unitsBetween: readings after period start up to period end', () => {
  const rs = [{ date: d('2026-07-31'), consumption: 100 }, { date: d('2026-08-15'), consumption: 40 }, { date: d('2026-08-31'), consumption: 60 }, { date: d('2026-09-10'), consumption: 30 }];
  assert.equal(unitsBetween(rs, d('2026-07-31'), d('2026-08-31')), 100);
  assert.equal(unitsBetween(rs, null, d('2026-07-31')), 100);
});

test('billAmounts: units × tariff + default fixed + tax, or explicit charges', () => {
  assert.deepEqual(billAmounts({ units: 350, tariff: 42.5, defaultFixed: 500, tax: 1800.25 }), { energyCharge: 14875, fixedCharge: 500, total: 17175.25 });
  assert.deepEqual(billAmounts({ energyCharge: 9000, fixedCharge: 0, arrears: 1000 }), { energyCharge: 9000, fixedCharge: 0, total: 10000 });
});

test('expectedDate clamps to month end; monthCells: paid, overdue, missing, expected, n/a', () => {
  assert.equal(expectedDate('2026-02', 31).toISOString().slice(0, 10), '2026-02-28');
  const today = d('2026-09-26');
  const cells = monthCells([
    { id: 'a', billDate: d('2026-06-05'), dueDate: d('2026-06-19'), status: 'paid', total: 100 },
    { id: 'b', billDate: d('2026-07-05'), dueDate: d('2026-07-19'), status: 'unpaid', total: 120 },
    { id: 'c', billDate: d('2026-09-05'), dueDate: d('2026-09-30'), status: 'unpaid', total: 90 },
  ], 5, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], today, d('2026-06-01'));
  assert.deepEqual(cells.map((c) => c.status), ['na', 'paid', 'overdue', 'missing', 'unpaid', 'expected']);
});
