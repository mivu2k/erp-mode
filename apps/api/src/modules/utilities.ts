import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { fromMinor, toMinor } from '@erp/shared';
import { z } from 'zod';
import { HookCtx, HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { NumberingService } from '../platform/numbering.service';
import type { Tx } from '../platform/audit.service';
import { PrismaService } from '../platform/prisma.service';
import { assertCan, AuthUser, CurrentUser, Permissions } from '../rbac/rbac';
import { FinanceController } from './finance';

const DAY = 86_400_000;
const utc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const ym = (d: Date) => d.toISOString().slice(0, 7);

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────

/** Consumption since the previous reading; a replaced meter restarts the count. A lower reading is a typo, not negative use. */
export function consumption(previous: number | null, reading: number, meterReplaced = false): number {
  if (previous === null || meterReplaced) return meterReplaced ? reading : 0;
  if (reading < previous) throw new BadRequestException(`Reading ${reading} is lower than the previous ${previous} — tick "New meter" if the meter was replaced`);
  return Math.round((reading - previous) * 1000) / 1000;
}

/** Units used in a period = sum of the consumption of readings taken after `from` up to and including `to`. */
export function unitsBetween(readings: { date: Date; consumption: number }[], from: Date | null, to: Date): number {
  const f = from ? utc(from) : -Infinity;
  return Math.round(readings.filter((r) => utc(r.date) > f && utc(r.date) <= utc(to)).reduce((s, r) => s + r.consumption, 0) * 1000) / 1000;
}

/** The bill's charges: usage defaults to units × tariff, fixed charge to the connection's; total is the sum (in minor units to avoid float drift). */
export function billAmounts(b: { units?: number | null; tariff?: number | null; energyCharge?: number | null; fixedCharge?: number | null; defaultFixed?: number | null; tax?: number; otherCharges?: number; arrears?: number }) {
  const energy = b.energyCharge ?? (b.units != null && b.tariff != null ? Math.round(b.units * b.tariff * 100) / 100 : 0);
  const fixed = b.fixedCharge ?? b.defaultFixed ?? 0;
  const total = fromMinor([energy, fixed, b.tax ?? 0, b.otherCharges ?? 0, b.arrears ?? 0].reduce((s, x) => s + toMinor(x), 0));
  return { energyCharge: energy, fixedCharge: fixed, total };
}

/** Day the bill is normally issued in a given month (billing day 31 → last day of short months). */
export function expectedDate(month: string, billingDay: number): Date {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(Math.max(1, billingDay), last)));
}

export type Cell = { month: string; status: 'paid' | 'partially_paid' | 'unpaid' | 'overdue' | 'disputed' | 'missing' | 'expected' | 'na'; billId?: string; total?: number; expected: string };
/**
 * One cell per month for the tracker: the bill issued that month and its state, or — when there is none —
 * "missing" once the usual billing day plus a grace period has passed, "expected" before that, "na" before the connection existed.
 */
export function monthCells(bills: { id: string; billDate: Date; dueDate: Date | null; status: string; total: number }[], billingDay: number, months: string[], today: Date, since: Date, graceDays = 7): Cell[] {
  return months.map((month) => {
    const exp = expectedDate(month, billingDay);
    const bill = bills.find((b) => ym(b.billDate) === month);
    if (bill) {
      const overdue = bill.status !== 'paid' && bill.status !== 'disputed' && bill.dueDate && utc(bill.dueDate) < utc(today);
      return { month, status: overdue ? 'overdue' : (bill.status as Cell['status']), billId: bill.id, total: bill.total, expected: exp.toISOString().slice(0, 10) };
    }
    if (month < ym(since)) return { month, status: 'na', expected: exp.toISOString().slice(0, 10) };
    return { month, status: utc(exp) + graceDays * DAY < utc(today) ? 'missing' : 'expected', expected: exp.toISOString().slice(0, 10) };
  });
}

const readingBody = z.object({ date: z.coerce.date(), reading: z.coerce.number().min(0), meterReplaced: z.boolean().optional(), notes: z.string().max(500).nullish(), photo: z.string().nullish() });

@Controller('utilities')
export class UtilitiesController {
  constructor(private prisma: PrismaService, private resources: ResourceService, private numbering: NumberingService, private finance: FinanceController, hooks: HooksService) {
    const conn = async ({ tx, user }: HookCtx, id: unknown) => {
      const c = await tx.utilityConnection.findFirst({ where: { id: String(id ?? ''), companyId: user.companyId, deletedAt: null } });
      if (!c) throw new BadRequestException('Pick a utility connection');
      return c;
    };
    hooks.on('utilities.connection', {
      beforeCreate: async ({ tx, user }, data) => {
        const site = await tx.utilitySite.findFirst({ where: { id: String(data.siteId ?? ''), companyId: user.companyId, deletedAt: null } });
        if (!site) throw new BadRequestException('Pick a site');
        data.branchId ??= site.branchId;
        if (data.vendorId && !data.provider) data.provider = (await tx.vendor.findFirst({ where: { id: String(data.vendorId), companyId: user.companyId } }))?.name ?? null;
        const acc = await tx.account.findFirst({ where: { id: String(data.accountId ?? ''), companyId: user.companyId, isGroup: false } });
        if (!acc) throw new BadRequestException('Pick the expense account (a posting, non-group account) the bills go to');
      },
    });
    hooks.on('utilities.reading', {
      // Previous reading and consumption are derived; readings must move forward in time.
      beforeCreate: async (ctx, data) => {
        const c = await conn(ctx, data.connectionId);
        data.branchId = c.branchId;
        const last = await ctx.tx.utilityReading.findFirst({ where: { connectionId: c.id, deletedAt: null }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
        if (last && utc(last.date) > utc(data.date as Date)) throw new BadRequestException(`A later reading (${last.date.toISOString().slice(0, 10)}) already exists`);
        const prev = last ? Number(last.reading) : null;
        data.previous = prev;
        data.consumption = consumption(prev, Number(data.reading), !!data.meterReplaced);
      },
    });
    hooks.on('utilities.bill', {
      beforeCreate: async (ctx, data) => {
        const c = await conn(ctx, data.connectionId);
        if (c.status === 'disconnected') throw new BadRequestException(`${c.name} is disconnected`);
        const billDate = data.billDate as Date;
        if (await ctx.tx.utilityBill.count({ where: { connectionId: c.id, deletedAt: null, billDate: { gte: new Date(Date.UTC(billDate.getUTCFullYear(), billDate.getUTCMonth(), 1)), lt: new Date(Date.UTC(billDate.getUTCFullYear(), billDate.getUTCMonth() + 1, 1)) } } })) {
          throw new BadRequestException(`${c.name} already has a bill for ${ym(billDate)}`);
        }
        data.siteId = c.siteId;
        data.branchId = c.branchId;
        await this.fillDefaults(ctx.tx, c, data);
        if (!(Number(data.total) > 0)) throw new BadRequestException('The bill total is zero — enter the charges or the units');
      },
      // Book the bill as a payable on P & R (expense → payable) in the same transaction.
      afterCreate: async ({ tx, user }, rec) => {
        const c = await tx.utilityConnection.findUniqueOrThrow({ where: { id: String(rec.connectionId) } });
        const vendor = c.vendorId ? await tx.vendor.findFirst({ where: { id: c.vendorId, companyId: user.companyId } }) : null;
        const due = await tx.due.create({
          data: {
            companyId: user.companyId, branchId: rec.branchId as string | null, direction: 'payable', partyType: vendor ? 'vendor' : 'other', vendorId: vendor?.id ?? null,
            partyName: vendor?.name ?? c.provider ?? c.name, description: `Utility bill ${rec.number} · ${c.name}${rec.billRef ? ` (${rec.billRef})` : ''}`,
            amount: rec.total as never, dueDate: rec.dueDate as Date, accountId: c.accountId, status: 'open', createdById: user.id,
            number: await this.numbering.next(tx, user.companyId, rec.branchId as string | null, 'DUE', 'DUE-{YYYY}-{SEQ:5}', rec.dueDate as Date),
          },
        });
        await this.finance.postDue(tx, user, due as unknown as Row);
        await tx.utilityBill.update({ where: { id: String(rec.id) }, data: { dueId: due.id } });
      },
    });
  }

  /** Bill defaults: period from the previous bill, units from readings, usage = units × tariff, fixed from the connection, due = date + due days. */
  async fillDefaults(tx: Tx, c: { id: string; tariff: unknown; fixedCharge: unknown; dueDays: number }, data: Row) {
    const billDate = data.billDate as Date;
    const prevBill = await tx.utilityBill.findFirst({ where: { connectionId: c.id, deletedAt: null, billDate: { lt: billDate } }, orderBy: { billDate: 'desc' } });
    data.periodTo ??= billDate;
    data.periodFrom ??= prevBill ? (prevBill.periodTo ?? prevBill.billDate) : null;
    if (data.units == null) {
      const rs = await tx.utilityReading.findMany({ where: { connectionId: c.id, deletedAt: null }, select: { date: true, consumption: true } });
      data.units = rs.length ? unitsBetween(rs.map((r) => ({ date: r.date, consumption: Number(r.consumption ?? 0) })), data.periodFrom as Date | null, data.periodTo as Date) : null;
    }
    const n = (k: string) => (data[k] == null || data[k] === '' ? null : Number(data[k]));
    Object.assign(data, billAmounts({ units: n('units'), tariff: c.tariff == null ? null : Number(c.tariff), energyCharge: n('energyCharge'), fixedCharge: n('fixedCharge'), defaultFixed: c.fixedCharge == null ? null : Number(c.fixedCharge), tax: n('tax') ?? 0, otherCharges: n('otherCharges') ?? 0, arrears: n('arrears') ?? 0 }));
    data.dueDate ??= new Date(utc(billDate) + c.dueDays * DAY);
    return data;
  }

  /** What "Record bill" will save, before saving it — so the form can show suggested units and the total live. */
  @Post('connections/:id/bill-preview')
  @Permissions('utilities.bill.create')
  async billPreview(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const c = await this.prisma.utilityConnection.findFirst({ where: { id, companyId: user.companyId, deletedAt: null } });
    if (!c) throw new BadRequestException('Unknown connection');
    const date = (v: unknown) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`) : undefined);
    const num = (v: unknown) => (v === '' || v == null ? undefined : Number(v));
    const d = await this.fillDefaults(this.prisma, c, {
      billDate: date(body.billDate) ?? new Date(utc(new Date())), periodFrom: date(body.periodFrom), periodTo: date(body.periodTo), dueDate: date(body.dueDate),
      units: num(body.units), energyCharge: num(body.energyCharge), fixedCharge: num(body.fixedCharge), tax: num(body.tax), otherCharges: num(body.otherCharges), arrears: num(body.arrears),
    });
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : null);
    return { ...d, billDate: iso(d.billDate), periodFrom: iso(d.periodFrom), periodTo: iso(d.periodTo), dueDate: iso(d.dueDate), unit: c.unit, tariff: c.tariff == null ? null : Number(c.tariff), name: c.name };
  }

  @Post('connections/:id/reading')
  @Permissions('utilities.reading.create')
  reading(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(readingBody, body);
    return this.resources.create(user, 'utilities.reading', { ...b, date: b.date.toISOString().slice(0, 10), connectionId: id });
  }

  @Post('connections/:id/bill')
  @Permissions('utilities.bill.create')
  bill(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.resources.create(user, 'utilities.bill', { ...body, connectionId: id });
  }

  /** Pays the bill's payable; the bill's paid/status follow automatically (see FinanceController.payDue). */
  @Post('bills/:id/pay')
  @Permissions('finance.payment.create')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const bill = await this.resources.get(user, 'utilities.bill', id);
    if (bill.status === 'disputed') throw new BadRequestException('Resolve the dispute before paying');
    if (!bill.dueId) throw new BadRequestException('This bill has no payable booked');
    const r = await this.finance.payDue(user, String(bill.dueId), body);
    return { ...r, bill: await this.resources.get(user, 'utilities.bill', id) };
  }

  /** Toggle "disputed": holds payment while the provider corrects the bill. */
  @Post('bills/:id/dispute')
  @Permissions('utilities.bill.update')
  async dispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const b = await this.resources.load(tx, user, 'utilities.bill', id, 'update');
      const disputed = b.status === 'disputed';
      if (!disputed && !body?.reason?.trim()) throw new BadRequestException('Give the reason for the dispute');
      const paid = toMinor(b.paid as string);
      const notes = disputed ? b.notes : [b.notes, `Disputed ${new Date().toISOString().slice(0, 10)}: ${body.reason}`].filter(Boolean).join('\n');
      return this.resources.setStatus(tx, user, 'utilities.bill', id, disputed ? (paid ? 'partially_paid' : 'unpaid') : 'disputed', { notes });
    });
  }

  /**
   * The tracker: every connection with its site, last reading, average use, open balance, next expected bill,
   * and a month-by-month strip (paid / unpaid / overdue / missing / expected) for the last N months.
   */
  @Get('tracker')
  async tracker(@CurrentUser() user: AuthUser, @Query() q: { months?: string; siteId?: string; type?: string }) {
    assertCan(user, 'utilities.connection.view');
    const today = new Date();
    const n = Math.min(Math.max(Number(q.months) || 12, 3), 24);
    const months = Array.from({ length: n }, (_, i) => ym(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (n - 1 - i), 1))));
    const where = await this.resources.where(user, this.resources.meta('utilities.connection'), { filters: { ...(q.siteId ? { siteId: q.siteId } : {}), ...(q.type ? { type: q.type } : {}) } });
    const conns = await this.prisma.utilityConnection.findMany({ where: where as never, orderBy: [{ siteId: 'asc' }, { name: 'asc' }], take: 500 });
    const ids = conns.map((c) => c.id);
    const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, 1));
    const [sites, bills, readings] = await Promise.all([
      this.prisma.utilitySite.findMany({ where: { id: { in: conns.map((c) => c.siteId) } }, select: { id: true, name: true } }),
      this.prisma.utilityBill.findMany({ where: { connectionId: { in: ids }, deletedAt: null, OR: [{ billDate: { gte: since } }, { status: { in: ['unpaid', 'partially_paid', 'disputed'] } }] }, orderBy: { billDate: 'asc' } }),
      this.prisma.utilityReading.findMany({ where: { connectionId: { in: ids }, deletedAt: null, date: { gte: new Date(+since - 31 * DAY) } }, orderBy: { date: 'asc' } }),
    ]);
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    const rows = conns.map((c) => {
      const cb = bills.filter((b) => b.connectionId === c.id);
      const cr = readings.filter((r) => r.connectionId === c.id);
      const cells = monthCells(cb.map((b) => ({ id: b.id, billDate: b.billDate, dueDate: b.dueDate, status: b.status, total: Number(b.total) })), c.billingDay, months, today, c.createdAt);
      const open = cb.filter((b) => b.status !== 'paid').reduce((s, b) => s + toMinor(b.total) - toMinor(b.paid), 0);
      const last = cb.at(-1);
      const lastReading = cr.at(-1);
      const recentBills = cb.filter((b) => b.units != null).slice(-6);
      const thisMonth = cells.at(-1)!;
      const next = thisMonth.status === 'expected' || thisMonth.status === 'missing' ? thisMonth.expected : expectedDate(ym(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))), c.billingDay).toISOString().slice(0, 10);
      return {
        id: c.id, name: c.name, type: c.type, provider: c.provider, accountNo: c.accountNo, meterNo: c.meterNo, unit: c.unit, status: c.status,
        siteId: c.siteId, site: siteName.get(c.siteId) ?? '', billingDay: c.billingDay,
        lastReading: lastReading ? { date: lastReading.date.toISOString().slice(0, 10), reading: Number(lastReading.reading) } : null,
        avgUnits: recentBills.length ? Math.round(recentBills.reduce((s, b) => s + Number(b.units), 0) / recentBills.length) : null,
        avgAmount: cb.length ? Math.round(cb.slice(-6).reduce((s, b) => s + Number(b.total), 0) / Math.min(6, cb.length)) : null,
        lastBill: last ? { id: last.id, number: last.number, billDate: last.billDate.toISOString().slice(0, 10), total: Number(last.total), status: last.status } : null,
        open: fromMinor(open), nextExpected: c.status === 'active' ? next : null,
        overdue: cells.filter((x) => x.status === 'overdue').length, missing: cells.filter((x) => x.status === 'missing').length,
        cells,
      };
    });
    const openBills = bills.filter((b) => b.status !== 'paid');
    return {
      months, rows,
      totals: {
        connections: rows.length,
        open: fromMinor(openBills.reduce((s, b) => s + toMinor(b.total) - toMinor(b.paid), 0)),
        overdue: fromMinor(openBills.filter((b) => b.status !== 'disputed' && b.dueDate && utc(b.dueDate) < utc(today)).reduce((s, b) => s + toMinor(b.total) - toMinor(b.paid), 0)),
        dueSoon: fromMinor(openBills.filter((b) => b.status !== 'disputed' && b.dueDate && utc(b.dueDate) >= utc(today) && utc(b.dueDate) <= utc(today) + 7 * DAY).reduce((s, b) => s + toMinor(b.total) - toMinor(b.paid), 0)),
        missing: rows.reduce((s, r) => s + r.missing, 0),
        thisMonth: fromMinor(bills.filter((b) => ym(b.billDate) === ym(today)).reduce((s, b) => s + toMinor(b.total), 0)),
      },
    };
  }
}
