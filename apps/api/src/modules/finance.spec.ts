import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDues } from './finance';

test('summarizeDues: balances, buckets, totals, settled dropped', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const r = summarizeDues([
    { source: 'x', id: '1', number: 'A', direction: 'receivable', party: 'C', description: '', dueDate: d('2026-09-20'), amount: 1000, paid: 250.5 },
    { source: 'x', id: '2', number: 'B', direction: 'payable', party: 'V', description: '', dueDate: d('2026-09-28'), amount: 400, paid: 0 },
    { source: 'x', id: '3', number: 'C', direction: 'payable', party: 'V', description: '', dueDate: d('2026-11-01'), amount: 100, paid: 0 },
    { source: 'x', id: '4', number: 'D', direction: 'receivable', party: 'C', description: '', dueDate: d('2026-09-01'), amount: 50, paid: 50 },
  ], now);
  assert.deepEqual(r.rows.map((x) => [x.number, x.bucket, x.balance]), [['A', 'overdue', 749.5], ['B', 'this_week', 400], ['C', 'later', 100]]);
  assert.deepEqual(r.totals, { receivable: 749.5, payable: 500, overdueReceivable: 749.5, overduePayable: 0, net: 249.5, cash: 0, projected: 249.5, beyondForecast: { in: 0, out: 0 } });
});

test('summarizeDues: days overdue, aging, 8-week forecast from cash, parties', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const it = (id: string, direction: 'receivable' | 'payable', party: string, due: string, amount: number) => ({ source: 'x', id, number: id, direction, party, description: '', dueDate: d(due), amount, paid: 0 });
  const r = summarizeDues([
    it('A', 'receivable', 'Acme', '2026-07-01', 300), // 86 days overdue
    it('B', 'receivable', 'Acme', '2026-09-20', 200), // 5 days overdue
    it('C', 'payable', 'Parts Co', '2026-10-05', 1000), // due in 10 days → week 1
    it('D', 'receivable', 'Beta', '2026-12-31', 50), // beyond 8 weeks
  ], now, 400);
  assert.deepEqual(r.rows.map((x) => [x.id, x.daysOverdue, x.aging]), [['A', 86, '61-90'], ['B', 5, '1-30'], ['C', -10, 'current'], ['D', -97, 'current']]);
  assert.deepEqual(r.aging.receivable, { current: 50, '1-30': 200, '31-60': 0, '61-90': 300, '90+': 0 });
  assert.deepEqual(r.forecast.slice(0, 2).map((w) => [w.in, w.out, w.balance]), [[500, 0, 900], [0, 1000, -100]], 'overdue lands in week 0; balance runs from cash');
  assert.deepEqual(r.totals.beyondForecast, { in: 50, out: 0 });
  assert.equal(r.totals.projected, -50);
  assert.deepEqual(r.parties.map((p) => [p.party, p.balance, p.count, p.maxOverdue]), [['Parts Co', 1000, 1, -10], ['Acme', 500, 2, 86], ['Beta', 50, 1, -97]]);
});
