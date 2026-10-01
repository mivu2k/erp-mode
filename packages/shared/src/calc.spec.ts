import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDay, computePayslip, docTotals, formatNumber, isBalanced, nextInstallment, periodKey, settleClaim, weightedAvg } from './calc';

test('formatNumber', () => {
  const d = new Date(Date.UTC(2026, 8, 5));
  assert.equal(formatNumber('JOB-{YYYY}-{SEQ:6}', 123, d), 'JOB-2026-000123');
  assert.equal(formatNumber('INV-{BR}-{YY}{MM}-{SEQ:4}', 45, d, 'ISB'), 'INV-ISB-2609-0045');
  assert.equal(periodKey('monthly', d), '2026-09');
  assert.equal(periodKey('never', d), '');
});

test('docTotals applies discount before tax', () => {
  assert.deepEqual(docTotals([{ qty: 2, price: 100, taxRate: 10 }, { qty: 1, price: 50 }], 25), { subtotal: 25000, discount: 2500, tax: 1800, total: 24300 });
});

test('settleClaim', () => {
  assert.deepEqual(settleClaim(8000, 10000), { fromAdvance: 8000, reimburse: 0, refundDue: 2000 });
  assert.deepEqual(settleClaim(12000, 10000), { fromAdvance: 10000, reimburse: 2000, refundDue: 0 });
  assert.deepEqual(settleClaim(5000, 0), { fromAdvance: 0, reimburse: 5000, refundDue: 0 });
});

test('isBalanced', () => {
  assert.ok(isBalanced([{ accountId: 'a', debit: 10.1 }, { accountId: 'b', credit: 10.1 }]));
  assert.ok(!isBalanced([{ accountId: 'a', debit: 10 }, { accountId: 'b', credit: 9.99 }]));
  assert.ok(!isBalanced([]));
});

test('weightedAvg', () => {
  assert.equal(weightedAvg(10, 100, 10, 200), 150);
  assert.equal(weightedAvg(0, 100, 5, 80), 80);
  assert.equal(weightedAvg(-2, 100, 5, 80), 80);
});

test('classifyDay', () => {
  const s = { start: '09:00', end: '17:00', graceMin: 10, halfDayMin: 240, absentMin: 120, otAfterMin: 30, weekend: [0] };
  assert.equal(classifyDay(s, 1, [9 * 60 + 5, 17 * 60]).status, 'present');
  const late = classifyDay(s, 1, [9 * 60 + 20, 18 * 60]);
  assert.equal(late.status, 'late');
  assert.equal(late.lateMin, 20);
  assert.equal(late.overtimeMin, 60);
  assert.equal(classifyDay(s, 1, [9 * 60, 12 * 60]).status, 'half_day');
  assert.equal(classifyDay(s, 1, []).status, 'absent');
  assert.equal(classifyDay(s, 0, []).status, 'weekend');
  assert.equal(classifyDay(s, 0, [600, 720]).overtimeMin, 120);
  assert.equal(classifyDay(s, 1, [], { leave: true }).status, 'leave');
  const night = { ...s, start: '22:00', end: '06:00' };
  assert.equal(classifyDay(night, 1, [22 * 60, 30 * 60]).status, 'present');
});

test('computePayslip', () => {
  const p = computePayslip({
    basic: 30000, components: [{ name: 'House', kind: 'allowance', mode: 'percent', value: 10 }, { name: 'EOBI', kind: 'deduction', mode: 'fixed', value: 370 }],
    taxPercent: 0, workingDays: 30, absentDays: 1, overtimeMin: 0, overtimeMultiplier: 1.5, hoursPerDay: 8, advanceInstallments: 5000,
  });
  assert.equal(p.gross, 3300000);
  assert.equal(p.advanceDeduction, 500000);
  assert.equal(p.net, 3300000 - 37000 - 100000 - 500000);
  const capped = computePayslip({ basic: 1000, components: [], taxPercent: 0, workingDays: 30, absentDays: 0, overtimeMin: 0, overtimeMultiplier: 1, hoursPerDay: 8, advanceInstallments: 5000 });
  assert.equal(capped.net, 0);
});

test('nextInstallment: number, split and part payments', () => {
  assert.deepEqual(nextInstallment({ amount: 10000, installments: 4, recovered: 0 }), { no: 1, of: 4, per: 2500, due: 2500, outstanding: 10000 });
  assert.deepEqual(nextInstallment({ amount: 10000, installments: 4, recovered: 3000 }), { no: 2, of: 4, per: 2500, due: 2000, outstanding: 7000 }, 'part-paid installment 2');
  assert.equal(nextInstallment({ amount: 10001, installments: 3, recovered: 6668 }).due, 3333, 'last installment absorbs rounding');
  assert.deepEqual(nextInstallment({ amount: 500, installments: 0, recovered: 500 }), { no: 1, of: 1, per: 500, due: 0, outstanding: 0 });
});
