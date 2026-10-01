/** Pure business math. Money is handled in integer minor units (paisa/cents) to avoid float drift. */

export const toMinor = (v: number | string | { toString(): string } | null | undefined): number =>
  Math.round(Number(v ?? 0) * 100);
export const fromMinor = (m: number): number => m / 100;

// ─── Numbering ───────────────────────────────────────────────

export function periodKey(reset: string, d: Date): string {
  const y = String(d.getUTCFullYear());
  if (reset === 'yearly') return y;
  if (reset === 'monthly') return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return '';
}

/** Tokens: {BR} {YYYY} {YY} {MM} {DD} {SEQ:n} */
export function formatNumber(pattern: string, seq: number, d: Date, branchCode = ''): string {
  const y = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return pattern
    .replace('{BR}', branchCode)
    .replace('{YYYY}', y)
    .replace('{YY}', y.slice(2))
    .replace('{MM}', mm)
    .replace('{DD}', dd)
    .replace(/\{SEQ(?::(\d+))?\}/, (_, n) => String(seq).padStart(Number(n ?? 1), '0'));
}

// ─── Documents ───────────────────────────────────────────────

export interface DocLine { qty: number; price: number; taxRate?: number }

/** Discount is applied pro-rata before tax. Returns minor units. */
export function docTotals(lines: DocLine[], discount = 0) {
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * toMinor(l.price)), 0);
  const disc = Math.min(toMinor(discount), subtotal);
  const factor = subtotal ? (subtotal - disc) / subtotal : 0;
  const tax = lines.reduce((s, l) => s + Math.round(l.qty * toMinor(l.price) * factor * ((l.taxRate ?? 0) / 100)), 0);
  return { subtotal, discount: disc, tax, total: subtotal - disc + tax };
}

// ─── Inventory ───────────────────────────────────────────────

/** Weighted average cost after receiving `inQty` at `inCost`. */
export function weightedAvg(qty: number, avg: number, inQty: number, inCost: number): number {
  const total = qty + inQty;
  if (total <= 0) return inCost;
  if (qty <= 0) return inCost;
  return (qty * avg + inQty * inCost) / total;
}

// ─── Finance ─────────────────────────────────────────────────

/**
 * Expense claim against an advance (minor units).
 * fromAdvance: part covered by the advance; reimburse: company pays the excess; refundDue: employee returns the rest.
 */
export function settleClaim(claimTotal: number, advanceOutstanding: number) {
  const fromAdvance = Math.min(claimTotal, Math.max(advanceOutstanding, 0));
  return { fromAdvance, reimburse: claimTotal - fromAdvance, refundDue: Math.max(advanceOutstanding, 0) - fromAdvance };
}

/**
 * Where an advance/loan stands in its installment plan (all amounts in minor units).
 * The installment size is amount ÷ installments rounded up; `due` is what's left of the current installment,
 * so a part payment is completed by the next one rather than skipping ahead.
 */
export function nextInstallment(a: { amount: number; installments: number; recovered: number }) {
  const of = Math.max(1, Math.floor(a.installments) || 1);
  const per = Math.ceil(a.amount / of);
  const outstanding = Math.max(0, a.amount - a.recovered);
  const no = Math.min(of, Math.floor(a.recovered / per) + 1);
  return { no, of, per, due: Math.max(0, Math.min(outstanding, no * per - a.recovered)), outstanding };
}

export interface JournalLineInput { accountId: string; debit?: number; credit?: number }
export function isBalanced(lines: JournalLineInput[]): boolean {
  const d = lines.reduce((s, l) => s + toMinor(l.debit), 0);
  const c = lines.reduce((s, l) => s + toMinor(l.credit), 0);
  return d === c && d > 0;
}

// ─── Attendance ──────────────────────────────────────────────

export interface ShiftRule { start: string; end: string; graceMin: number; halfDayMin: number; absentMin: number; otAfterMin: number; weekend: number[] }

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Classify one day. `punches` are minutes-from-local-midnight (already converted to company timezone).
 * Overnight shifts (end < start) add 24h to end.
 */
export function classifyDay(shift: ShiftRule, weekday: number, punches: number[], opts: { holiday?: boolean; leave?: boolean } = {}) {
  const empty = { inMin: null as number | null, outMin: null as number | null, workedMin: 0, lateMin: 0, earlyMin: 0, overtimeMin: 0 };
  if (opts.leave) return { status: 'leave', ...empty };
  const sorted = [...punches].sort((a, b) => a - b);
  const off = opts.holiday ? 'holiday' : shift.weekend.includes(weekday) ? 'weekend' : null;
  if (sorted.length === 0) return { status: off ?? 'absent', ...empty };

  const start = minutesOf(shift.start);
  let end = minutesOf(shift.end);
  if (end <= start) end += 24 * 60;
  const inMin = sorted[0];
  const outMin = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  const workedMin = outMin === null ? 0 : outMin - inMin;
  const lateMin = inMin - start > shift.graceMin ? inMin - start : 0;
  const earlyMin = outMin === null ? 0 : Math.max(0, end - outMin);
  const beyond = outMin === null ? 0 : outMin - end;
  const overtimeMin = off ? workedMin : beyond > shift.otAfterMin ? beyond : 0;

  let status: string;
  if (off) status = off;
  else if (outMin !== null && workedMin < shift.absentMin) status = 'absent';
  else if (outMin !== null && workedMin < shift.halfDayMin) status = 'half_day';
  else status = lateMin > 0 ? 'late' : 'present';
  return { status, inMin, outMin, workedMin, lateMin, earlyMin, overtimeMin };
}

// ─── Payroll ─────────────────────────────────────────────────

export interface SalaryComponent { name: string; kind: 'allowance' | 'deduction'; mode: 'fixed' | 'percent'; value: number }
export interface PayrollInput {
  basic: number; // major units
  components: SalaryComponent[];
  taxPercent: number;
  workingDays: number; // divisor for per-day rate (e.g. 30)
  absentDays: number; // unpaid days (absent + unpaid leave + half days * 0.5)
  overtimeMin: number;
  overtimeMultiplier: number; // e.g. 1.5 of hourly rate
  hoursPerDay: number;
  advanceInstallments: number; // major units to recover this month
  fines?: number;
}

/** Returns minor units. Net is never negative: advance recovery is capped to what's left. */
export function computePayslip(i: PayrollInput) {
  const basic = toMinor(i.basic);
  const lines: { name: string; kind: 'earning' | 'deduction'; amount: number }[] = [{ name: 'Basic', kind: 'earning', amount: basic }];
  for (const c of i.components) {
    const amount = c.mode === 'percent' ? Math.round((basic * c.value) / 100) : toMinor(c.value);
    lines.push({ name: c.name, kind: c.kind === 'allowance' ? 'earning' : 'deduction', amount });
  }
  const perDay = basic / i.workingDays;
  if (i.overtimeMin > 0) {
    lines.push({ name: 'Overtime', kind: 'earning', amount: Math.round((perDay / i.hoursPerDay / 60) * i.overtimeMin * i.overtimeMultiplier) });
  }
  if (i.absentDays > 0) lines.push({ name: 'Absent deduction', kind: 'deduction', amount: Math.round(perDay * i.absentDays) });
  if (i.fines) lines.push({ name: 'Fines', kind: 'deduction', amount: toMinor(i.fines) });

  const gross = lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0);
  const tax = Math.round((gross * i.taxPercent) / 100);
  if (tax) lines.push({ name: 'Income tax', kind: 'deduction', amount: tax });
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0);
  const advanceDeduction = Math.max(0, Math.min(toMinor(i.advanceInstallments), gross - deductions));
  if (advanceDeduction) lines.push({ name: 'Advance recovery', kind: 'deduction', amount: advanceDeduction });
  return { lines, gross, deductions: deductions + advanceDeduction, advanceDeduction, net: gross - deductions - advanceDeduction };
}

// ─── Geo ─────────────────────────────────────────────────────

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
