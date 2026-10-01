import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { STANDARD_REPORTS } from '@erp/shared';
import { sendReport } from '../engine/export';
import { delegate, Row } from '../engine/hooks';
import { FieldMeta } from '../engine/meta';
import { parse, ResourceService } from '../engine/resource.service';
import { PrismaService } from '../platform/prisma.service';
import { assertCan, AuthUser, can, CurrentUser } from '../rbac/rbac';

const AGG = ['sum', 'avg', 'min', 'max', 'count'] as const;

export const reportSchema = z.object({
  resource: z.string(),
  columns: z.array(z.string()).default([]),
  filters: z.record(z.unknown()).default({}),
  search: z.string().optional(),
  groupBy: z.array(z.string()).max(3).default([]),
  aggregates: z.array(z.object({ field: z.string(), fn: z.enum(AGG) })).default([]),
  /** Calculated columns: a op b, where a/b are column names (or aggregate aliases like sum_amount) or numbers. */
  calc: z.array(z.object({ name: z.string().regex(/^\w+$/), a: z.union([z.string(), z.number()]), op: z.enum(['+', '-', '*', '/']), b: z.union([z.string(), z.number()]) })).default([]),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
  chart: z.object({ type: z.enum(['table', 'bar', 'line', 'pie', 'area', 'kpi', 'pivot']), x: z.string().optional(), y: z.string().optional() }).optional(),
});
export type ReportDef = z.infer<typeof reportSchema>;

/** Replaces "$param" strings anywhere in filters with runtime values (e.g. $from, $to, $branchId). */
export function bindParams(v: unknown, params: Record<string, unknown>): unknown {
  if (typeof v === 'string' && v.startsWith('$')) return params[v.slice(1)] ?? '';
  if (Array.isArray(v)) return v.map((x) => bindParams(x, params));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bindParams(x, params)]));
  return v;
}

export function applyCalc(rows: Row[], calc: ReportDef['calc']) {
  const val = (r: Row, x: string | number) => (typeof x === 'number' ? x : Number(r[x] ?? 0));
  for (const r of rows) {
    for (const c of calc) {
      const a = val(r, c.a);
      const b = val(r, c.b);
      r[c.name] = c.op === '+' ? a + b : c.op === '-' ? a - b : c.op === '*' ? a * b : b === 0 ? null : a / b;
    }
  }
  return rows;
}

/**
 * Safe report builder: only whitelisted fields of registered resources, Prisma-parameterized queries,
 * RBAC data scope + field restrictions applied, hard row limit. No raw SQL from clients.
 */
@Controller('reports')
export class ReportsController {
  constructor(private prisma: PrismaService, private resources: ResourceService) {}

  async execute(user: AuthUser, def: ReportDef, params: Record<string, unknown> = {}) {
    const m = this.resources.meta(def.resource);
    const readable = new Set(Object.keys(this.resources.select(user, m)));
    const fields = new Map<string, FieldMeta>(m.fields.filter((f) => readable.has(f.name)).map((f) => [f.name, f]));
    for (const c of ['createdAt', 'updatedAt']) if (readable.has(c)) fields.set(c, { name: c, type: 'datetime', required: false });
    const bad = [...def.columns, ...def.groupBy, ...def.aggregates.filter((a) => a.fn !== 'count').map((a) => a.field)].filter((f) => !fields.has(f));
    if (bad.length) throw new BadRequestException(`Unknown or restricted fields: ${bad.join(', ')}`);
    const numeric = new Set(['int', 'float', 'money', 'decimal']);
    for (const a of def.aggregates) if (a.fn !== 'count' && !numeric.has(fields.get(a.field)!.type)) throw new BadRequestException(`${a.field} is not numeric`);

    const where = await this.resources.where(user, m, { filters: bindParams(def.filters, params) as Record<string, unknown>, search: def.search });
    const d = delegate(this.prisma, m.delegate);
    let rows: Row[];
    let columns: string[];
    if (def.groupBy.length) {
      const agg: Record<string, Record<string, true>> = {};
      for (const a of def.aggregates) if (a.fn !== 'count') agg[`_${a.fn}`] = { ...agg[`_${a.fn}`], [a.field]: true };
      const raw = await d.groupBy({ by: def.groupBy, where, _count: { _all: true }, ...agg, take: def.limit, orderBy: def.groupBy.map((g) => ({ [g]: 'asc' })) });
      rows = raw.map((r) => {
        const out: Row = Object.fromEntries(def.groupBy.map((g) => [g, r[g]]));
        out.count = (r._count as Row)._all;
        for (const a of def.aggregates) if (a.fn !== 'count') out[`${a.fn}_${a.field}`] = Number((r[`_${a.fn}`] as Row)[a.field] ?? 0);
        return out;
      });
      columns = [...def.groupBy, 'count', ...def.aggregates.filter((a) => a.fn !== 'count').map((a) => `${a.fn}_${a.field}`)];
    } else {
      columns = def.columns.length ? def.columns : m.def.list.filter((c) => fields.has(c));
      const sort = def.sort && (fields.has(def.sort.field) ? { [def.sort.field]: def.sort.dir } : undefined);
      rows = await d.findMany({ where, select: Object.fromEntries(columns.map((c) => [c, true])), take: def.limit, ...(sort ? { orderBy: sort } : {}) });
    }
    await this.resources.attachRefs(this.prisma, user, m, rows);
    applyCalc(rows, def.calc);
    columns.push(...def.calc.map((c) => c.name));
    if (def.groupBy.length && def.sort) rows.sort((a, b) => (Number(a[def.sort!.field]) - Number(b[def.sort!.field])) * (def.sort!.dir === 'asc' ? 1 : -1));
    return { columns, rows, truncated: rows.length >= def.limit };
  }

  @Post('run')
  async run(@CurrentUser() user: AuthUser, @Body() body: { definition?: unknown; params?: Record<string, unknown>; format?: string }, @Res() res: Response) {
    assertCan(user, 'reports.builder.view');
    const def = parse(reportSchema, body?.definition);
    return this.respond(user, res, 'Report', def, body?.params ?? {}, body?.format);
  }

  @Get(':id/run')
  async runSaved(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const saved = await this.prisma.savedReport.findFirst({ where: { id, companyId: user.companyId, deletedAt: null } });
    if (!saved) throw new BadRequestException('Unknown report');
    const shared = (saved.sharedRoles as string[] | null) ?? [];
    if (saved.createdById !== user.id && !can(user, 'reports.report.manage') && !shared.some((r) => user.roleIds.includes(r))) throw new ForbiddenException();
    const { format, ...params } = q;
    return this.respond(user, res, saved.name, parse(reportSchema, saved.definition), params, format);
  }

  /** The standard report library, limited to reports on data this user can see. */
  @Get('standard')
  standard(@CurrentUser() user: AuthUser) {
    return STANDARD_REPORTS.filter((r) => can(user, `${r.resource}.view`));
  }

  /** Runs a standard report for a date range (defaults: this month) and optional branch; same exports as the builder. */
  @Get('standard/:key')
  async runStandard(@CurrentUser() user: AuthUser, @Param('key') key: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const r = STANDARD_REPORTS.find((x) => x.key === key);
    if (!r) throw new BadRequestException('Unknown report');
    assertCan(user, `${r.resource}.view`);
    const today = new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : `${today.slice(0, 7)}-01`;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : today;
    const m = this.resources.meta(r.resource);
    const dateTime = r.dateField && ['createdAt', 'at', 'paidAt'].includes(r.dateField);
    const filters: Record<string, unknown> = {
      ...(r.filters ?? {}),
      ...(r.dateField ? { [r.dateField]: { gte: from, lte: dateTime ? `${to}T23:59:59.999Z` : to } } : {}),
      ...(q.branchId && m.columns.has('branchId') ? { branchId: q.branchId } : {}),
    };
    const def = parse(reportSchema, { resource: r.resource, columns: r.columns ?? [], groupBy: r.groupBy ?? [], aggregates: r.aggregates ?? [], calc: r.calc ?? [], filters, sort: r.sort, chart: r.chart ? { type: r.chart } : undefined });
    const shown = { ...(r.dateField ? { from, to } : { 'as of': today }), ...(q.branchId ? { branch: q.branchId } : {}) };
    return this.respond(user, res, r.name, def, shown, q.format);
  }

  /** Reports visible to the user (own, shared with one of their roles, or all for managers). */
  @Get('available')
  async available(@CurrentUser() user: AuthUser) {
    const all = await this.prisma.savedReport.findMany({ where: { companyId: user.companyId, deletedAt: null }, orderBy: { name: 'asc' } });
    return all.filter((r) => r.createdById === user.id || can(user, 'reports.report.manage') || ((r.sharedRoles as string[] | null) ?? []).some((x) => user.roleIds.includes(x)));
  }

  private async respond(user: AuthUser, res: Response, title: string, def: ReportDef, params: Record<string, unknown>, format?: string) {
    const out = await this.execute(user, def, params);
    if (!format || format === 'json') return res.json({ ...out, chart: def.chart });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, { title, company, columns: out.columns, rows: out.rows, fields: Object.entries(params).map(([k, v]) => [k, v]) });
  }
}
