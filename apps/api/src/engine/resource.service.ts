import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EMPLOYEE_OWNERS, IMMUTABLE, RESOURCE_MAP, ResourceDef } from '@erp/shared';
import { z, ZodError } from 'zod';
import { AuditService, diff, Tx } from '../platform/audit.service';
import { NumberingService } from '../platform/numbering.service';
import { PrismaService } from '../platform/prisma.service';
import { SearchService } from '../platform/search.service';
import { assertCan, AuthUser, can, inScope, scopeWhere } from '../rbac/rbac';
import { delegate, HooksService, Row } from './hooks';
import { customSchema, FieldMeta, meta, objectSchema, ResourceMeta } from './meta';

export interface ListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: string; // field:asc|desc
  filters?: string | Record<string, unknown>; // JSON
  trash?: boolean;
}

const OPS = ['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'null'] as const;
type Op = (typeof OPS)[number];

export function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  try {
    return schema.parse(v);
  } catch (e) {
    if (e instanceof ZodError) throw new BadRequestException(e.flatten());
    throw e;
  }
}

/** Converts `{ field: value | { op: value } }` into a Prisma where, allowing only known fields. */
export function buildFilters(fields: Map<string, FieldMeta>, filters: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  // `$or: [{...}, {...}]` — each branch uses the same field whitelist.
  if (Array.isArray(filters.$or)) {
    const branches = (filters.$or as unknown[]).filter((b): b is Record<string, unknown> => !!b && typeof b === 'object').map((b) => buildFilters(fields, b)).filter((b) => Object.keys(b).length);
    if (branches.length) where.OR = branches;
  }
  const coerce = (f: FieldMeta, v: unknown) => (f.type === 'date' || f.type === 'datetime') && typeof v === 'string' ? new Date(v) : v;
  for (const [name, cond] of Object.entries(filters)) {
    const f = fields.get(name);
    if (!f || f.type === 'json' || cond === '' || cond === undefined) continue;
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      where[name] = Array.isArray(cond) ? { in: cond.map((v) => coerce(f, v)) } : coerce(f, cond);
      continue;
    }
    const clause: Record<string, unknown> = {};
    for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
      if (!OPS.includes(op as Op) || v === '' || v === undefined) continue;
      if (op === 'eq') clause.equals = coerce(f, v);
      else if (op === 'ne') clause.not = coerce(f, v);
      else if (op === 'in') clause.in = (Array.isArray(v) ? v : [v]).map((x) => coerce(f, x));
      else if (op === 'contains') clause.contains = String(v);
      else if (op === 'null') Object.assign(clause, v ? { equals: null } : { not: null });
      else clause[op] = coerce(f, v);
    }
    if (Object.keys(clause).length) where[name] = clause;
  }
  return where;
}

@Injectable()
export class ResourceService {
  constructor(
    private prisma: PrismaService,
    private hooks: HooksService,
    private audit: AuditService,
    private numbering: NumberingService,
    private search: SearchService,
  ) {}

  meta(key: string): ResourceMeta {
    const m = meta(key);
    if (!m) throw new NotFoundException(`Unknown resource ${key}`);
    return m;
  }

  private scope(user: AuthUser, m: ResourceMeta, action: string) {
    return { ...scopeWhere(user, `${m.def.key}.${action}`, { owner: m.def.owner, columns: m.columns }), ...m.def.scope };
  }

  /** Columns the user may read. */
  select(user: AuthUser, m: ResourceMeta): Record<string, true> {
    const manage = can(user, `${m.def.key}.manage`);
    const hidden = new Set([...(m.def.hidden ?? []), ...(manage ? [] : m.def.restricted ?? [])]);
    return Object.fromEntries([...m.columns].filter((c) => !hidden.has(c)).map((c) => [c, true]));
  }

  async list(user: AuthUser, key: string, p: ListParams, db: Tx = this.prisma) {
    const m = this.meta(key);
    const where = await this.where(user, m, p);
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(Math.max(Number(p.pageSize) || 25, 1), 10_000);
    const [field, dir] = (p.sort ?? '').split(':');
    const sortable = m.columns.has(field) && !(m.def.restricted ?? []).includes(field) && !(m.def.hidden ?? []).includes(field);
    const orderBy = sortable ? { [field]: dir === 'asc' ? 'asc' : 'desc' } : m.columns.has('createdAt') ? { createdAt: 'desc' } : { id: 'desc' };
    const d = delegate(db, m.delegate);
    const [total, rows] = await Promise.all([
      d.count({ where }),
      d.findMany({ where, select: this.select(user, m), orderBy, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    await this.attachRefs(db, user, m, rows);
    return { total, page, pageSize, rows };
  }

  async where(user: AuthUser, m: ResourceMeta, p: ListParams) {
    const where: Record<string, unknown> = this.scope(user, m, 'view');
    if (m.columns.has('deletedAt')) {
      if (p.trash) assertCan(user, `${m.def.key}.manage`);
      where.deletedAt = p.trash ? { not: null } : null;
    }
    const manage = can(user, `${m.def.key}.manage`);
    const filterable = new Map(
      [...m.fields, { name: 'createdAt', type: 'datetime', required: false } as FieldMeta, { name: 'createdById', type: 'string', required: false } as FieldMeta]
        .filter((f) => manage || !f.restricted)
        .map((f) => [f.name, f]),
    );
    let filters: Record<string, unknown> = {};
    try {
      filters = typeof p.filters === 'string' && p.filters ? JSON.parse(p.filters) : (p.filters as Record<string, unknown>) ?? {};
    } catch {
      throw new BadRequestException('filters must be JSON');
    }
    Object.assign(where, buildFilters(filterable, filters));
    // Custom fields live in the `custom` JSON column: filter via JSON path, only for defined field names.
    const customKeys = Object.keys(filters).filter((k) => k.startsWith('custom.'));
    if (customKeys.length && m.columns.has('custom')) {
      const defs = new Set((await this.prisma.customField.findMany({ where: { companyId: user.companyId, resource: m.def.key, deletedAt: null } })).map((d) => d.name));
      const and: unknown[] = [];
      for (const k of customKeys) {
        const name = k.slice(7);
        const v = filters[k];
        if (!defs.has(name) || v === '' || v === null || v === undefined) continue;
        const contains = typeof v === 'object' && v && 'contains' in v ? String((v as { contains: unknown }).contains) : null;
        if (contains === '') continue;
        and.push({ custom: contains !== null ? { path: `$.${name}`, string_contains: contains } : { path: `$.${name}`, equals: v } });
      }
      if (and.length) where.AND = [...((where.AND as unknown[]) ?? []), ...and];
    }
    if (p.search?.trim()) {
      const q = p.search.trim();
      const fields = m.def.search ?? [m.def.title];
      where.AND = [...((where.AND as unknown[]) ?? []), { OR: fields.filter((f) => m.columns.has(f)).map((f) => ({ [f]: { contains: q } })) }];
    }
    return where;
  }

  async get(user: AuthUser, key: string, id: string, db: Tx = this.prisma) {
    const m = this.meta(key);
    const where = { ...this.scope(user, m, 'view'), id };
    const rec = await delegate(db, m.delegate).findFirst({
      where,
      select: { ...this.select(user, m), ...Object.fromEntries(Object.keys(m.children).map((c) => [c, true])) },
    });
    if (!rec) throw new NotFoundException();
    await this.attachRefs(db, user, m, [rec]);
    for (const [rel, child] of Object.entries(m.children)) if (Array.isArray(rec[rel])) await this.attachRefs(db, user, child, rec[rel] as Row[]);
    return rec;
  }

  /** Loads a record inside the caller's transaction, enforcing `action` scope. */
  async load(tx: Tx, user: AuthUser, key: string, id: string, action = 'update') {
    const m = this.meta(key);
    const rec = await delegate(tx, m.delegate).findFirst({ where: { ...this.scope(user, m, action), id, ...(m.columns.has('deletedAt') ? { deletedAt: null } : {}) } });
    if (!rec) throw new NotFoundException();
    return rec;
  }

  /** Super-admin override (core.record.manage): past workflow locks, action-only ops and read-only fields — never ledgers. */
  overrides(user: AuthUser, key: string) {
    return can(user, 'core.record.manage') && !IMMUTABLE.includes(key);
  }

  async create(user: AuthUser, key: string, body: Row) {
    const m = this.meta(key);
    this.ensureOp(m.def, 'create', this.overrides(user, key));
    assertCan(user, `${key}.create`);
    const ownEmployee = user.permissions[`${key}.create`] === 'own' && m.def.owner && EMPLOYEE_OWNERS.includes(m.def.owner);
    if (ownEmployee && !user.employeeId) throw new BadRequestException('Your login is not linked to an employee record. Ask HR to set your user on your employee profile (HR → Employees).');
    if (ownEmployee) body = { ...body, [m.def.owner!]: user.employeeId };
    const data = await this.validate(user, m, body, false);
    Object.assign(data, m.def.scope);
    if (m.columns.has('companyId')) data.companyId = user.companyId;
    if (m.columns.has('createdById')) data.createdById = user.id;
    if (m.columns.has('branchId') && !data.branchId) data.branchId = user.branchId;
    if (user.permissions[`${key}.create`] === 'own' && m.def.owner && EMPLOYEE_OWNERS.includes(m.def.owner)) data[m.def.owner] = user.employeeId;
    if (!inScope(user, `${key}.create`, data, { owner: m.def.owner, columns: m.columns })) throw new ForbiddenException('Outside your data scope');

    const id = await this.prisma.$transaction(async (tx) => {
      const ctx = { tx, user, def: m.def, body };
      if (m.def.number && !data[m.def.number.field]) {
        data[m.def.number.field] = await this.numbering.next(tx, user.companyId, data.branchId as string | null, m.def.number.docType, m.def.number.pattern);
      }
      await this.hooks.run(key, 'beforeCreate', ctx, data);
      const rec = await delegate(tx, m.delegate).create({ data: this.nest(m, data, false) });
      await this.hooks.run(key, 'afterCreate', ctx, rec);
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'create', entityType: key, entityId: String(rec.id), after: rec }, tx);
      await this.search.index(tx, m.def, rec);
      return String(rec.id);
    });
    return this.get(user, key, id);
  }

  async update(user: AuthUser, key: string, id: string, body: Row) {
    const m = this.meta(key);
    const force = this.overrides(user, key);
    this.ensureOp(m.def, 'update', force);
    const input = await this.validate(user, m, body, true, force);
    let overridden = false;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, user, key, id, 'update');
      overridden = this.ensureEditable(m.def, before, force) || (m.def.ops !== undefined && !m.def.ops.includes('update')) || Object.keys(input).some((k) => m.fields.find((f) => f.name === k)?.readonly);
      const ctx = { tx, user, def: m.def, body };
      if (input.custom) input.custom = { ...(before.custom as Row | null), ...(input.custom as Row) };
      await this.hooks.run(key, 'beforeUpdate', ctx, input, before);
      const rec = await delegate(tx, m.delegate).update({ where: { id }, data: this.nest(m, input, true) });
      if (!inScope(user, `${key}.update`, rec, { owner: m.def.owner, columns: m.columns })) throw new ForbiddenException('Outside your data scope');
      await this.hooks.run(key, 'afterUpdate', ctx, rec, before);
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: overridden ? 'override_update' : 'update', entityType: key, entityId: id, ...diff(before, rec) }, tx);
      await this.search.index(tx, m.def, rec);
    });
    return this.get(user, key, id);
  }

  async remove(user: AuthUser, key: string, id: string) {
    const m = this.meta(key);
    const force = this.overrides(user, key);
    this.ensureOp(m.def, 'delete', force);
    if (key === 'core.user' && id === user.id) throw new BadRequestException("You can't delete the account you're signed in with");
    await this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, user, key, id, 'delete');
      const overridden = this.ensureEditable(m.def, before, force) || (m.def.ops !== undefined && !m.def.ops.includes('delete'));
      if (m.columns.has('deletedAt')) await delegate(tx, m.delegate).update({ where: { id }, data: { deletedAt: new Date() } });
      else await (delegate(tx, m.delegate) as unknown as { delete(a: object): Promise<unknown> }).delete({ where: { id } });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: overridden ? 'override_delete' : 'delete', entityType: key, entityId: id, before }, tx);
      await this.search.remove(tx, key, id);
    });
  }

  async restore(user: AuthUser, key: string, id: string) {
    const m = this.meta(key);
    assertCan(user, `${key}.manage`);
    await this.prisma.$transaction(async (tx) => {
      const rec = await delegate(tx, m.delegate).findFirst({ where: { companyId: user.companyId, id, deletedAt: { not: null } } });
      if (!rec) throw new NotFoundException();
      const restored = await delegate(tx, m.delegate).update({ where: { id }, data: { deletedAt: null } });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'restore', entityType: key, entityId: id }, tx);
      await this.search.index(tx, m.def, restored);
    });
  }

  /** Engine-internal status change (workflow, domain actions). */
  async setStatus(tx: Tx, user: AuthUser, key: string, id: string, status: string, extra: Row = {}) {
    const m = this.meta(key);
    const rec = await delegate(tx, m.delegate).update({ where: { id }, data: { status, ...extra } });
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'status', entityType: key, entityId: id, after: { status, ...extra } }, tx);
    await this.search.index(tx, m.def, rec);
    return rec;
  }

  private ensureOp(def: ResourceDef, op: 'create' | 'update' | 'delete', force = false) {
    if (def.ops && !def.ops.includes(op) && !force) throw new ForbiddenException(`${def.label}: ${op} is done through its workflow actions`);
  }

  /** Returns true when the record was locked and the override was used. */
  private ensureEditable(def: ResourceDef, rec: Row, force = false): boolean {
    if (!def.editableWhen || def.editableWhen.includes(String(rec.status))) return false;
    if (!force) throw new BadRequestException(`Locked while ${rec.status}`);
    return true;
  }

  private async validate(user: AuthUser, m: ResourceMeta, body: Row, partial: boolean, force = false): Promise<Row> {
    // With the override, read-only fields are writable too — except hidden/secret ones (password hashes, tokens).
    const hidden = new Set(m.def.hidden ?? []);
    const fields = force ? m.fields.filter((f) => !hidden.has(f.name)).map((f) => ({ ...f, readonly: f.name === 'status' ? f.readonly : false })) : m.fields;
    const data = parse(objectSchema(fields, partial), body ?? {}) as Row;
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    if (!can(user, `${m.def.key}.manage`)) for (const f of m.def.restricted ?? []) delete data[f];

    const defs = await this.prisma.customField.findMany({ where: { companyId: user.companyId, resource: m.def.key, deletedAt: null } });
    if (defs.length && (body?.custom !== undefined || !partial)) data.custom = parse(customSchema(defs, partial), body?.custom ?? {});

    for (const [rel, child] of Object.entries(m.children)) {
      if (body?.[rel] !== undefined || !partial) data[rel] = parse(z.array(objectSchema(child.fields, false)), body?.[rel] ?? []);
    }
    for (const [field, type] of Object.entries(m.def.lists ?? {})) {
      if (data[field] == null || data[field] === '') continue;
      const ok = await this.prisma.masterData.count({ where: { companyId: user.companyId, type, deletedAt: null, OR: [{ code: String(data[field]) }, { code: null, name: String(data[field]) }] } });
      if (!ok) throw new BadRequestException(`"${data[field]}" is not in the ${type.replace(/_/g, ' ')} list (Admin › Master Data)`);
    }
    await this.checkRefs(user, m, data);
    return data;
  }

  /** Every referenced id must belong to the caller's company (prevents cross-tenant linking). */
  private async checkRefs(user: AuthUser, m: ResourceMeta, data: Row) {
    for (const f of m.fields) {
      const v = data[f.name];
      if ((f.type === 'file' || f.type === 'files') && v) {
        const ids = [...new Set(Array.isArray(v) ? v.map(String) : [String(v)])];
        if ((await this.prisma.attachment.count({ where: { id: { in: ids }, companyId: user.companyId, deletedAt: null } })) !== ids.length) throw new BadRequestException(`${f.name}: file not found`);
        continue;
      }
      if (!f.ref || v === null || v === undefined) continue;
      const target = meta(f.ref);
      if (!target) continue;
      const n = await delegate(this.prisma, target.delegate).count({ where: { id: String(v), ...(target.columns.has('companyId') ? { companyId: user.companyId } : {}) } });
      if (!n) throw new BadRequestException(`${f.name}: not found`);
    }
  }

  private nest(m: ResourceMeta, data: Row, update: boolean): Row {
    const out = { ...data };
    for (const rel of Object.keys(m.children)) {
      if (!(rel in out)) continue;
      out[rel] = update ? { deleteMany: {}, create: out[rel] } : { create: out[rel] };
    }
    return out;
  }

  /** Adds `_refs: { field: title }` for foreign keys so lists show names instead of ids. */
  async attachRefs(db: Tx, user: AuthUser, m: ResourceMeta | { fields: FieldMeta[] }, rows: Row[]) {
    await Promise.all(
      m.fields.filter((f) => f.ref).map(async (f) => {
        const field = f.name;
        const target = meta(f.ref!);
        const ids = [...new Set(rows.map((r) => r[field]).filter((v): v is string => typeof v === 'string'))];
        // Branch/department names and master-data lookups (units, taxes, expense types) are shown to anyone who can see the record; other targets still need view permission.
        const orgName = ['core.branch', 'core.department', 'core.masterdata'].includes(target?.def.key ?? '');
        if (!target || !ids.length) return;
        // No permission (or a deleted target) → '—', never the raw id, so no screen, print or export shows one.
        const found = orgName || can(user, `${target.def.key}.view`) ? await delegate(db, target.delegate).findMany({
          where: { id: { in: ids }, ...(target.columns.has('companyId') ? { companyId: user.companyId } : {}) },
          select: { id: true, [target.def.title]: true },
        }) : [];
        const names = new Map(found.map((x) => [x.id, String(x[target.def.title] ?? '')]));
        for (const r of rows) {
          if (typeof r[field] === 'string') r._refs = { ...(r._refs as Row), [field]: names.get(r[field] as string) || '—' };
        }
      }),
    );
    // Links that name their target resource in a sibling column (refType+refId, sourceType+sourceId): same rule, per type.
    for (const [typeCol, idCol] of [['refType', 'refId'], ['sourceType', 'sourceId']]) {
      const byType = new Map<string, Row[]>();
      for (const r of rows) if (typeof r[typeCol] === 'string' && typeof r[idCol] === 'string') byType.set(r[typeCol] as string, [...(byType.get(r[typeCol] as string) ?? []), r]);
      await Promise.all([...byType].map(async ([type, rs]) => {
        const target = meta(type);
        const titleCol = target?.columns.has('number') ? 'number' : target?.def.title;
        const found = target && titleCol && can(user, `${type}.view`) ? await delegate(db, target.delegate).findMany({
          where: { id: { in: rs.map((r) => r[idCol] as string) }, ...(target.columns.has('companyId') ? { companyId: user.companyId } : {}) },
          select: { id: true, [titleCol]: true },
        }) : [];
        const names = new Map(found.map((x) => [x.id, String(x[titleCol!] ?? '')]));
        for (const r of rs) r._refs = { ...(r._refs as Row), [idCol]: names.get(r[idCol] as string) || '—' };
      }));
    }
  }

  resourceDef(key: string) {
    return RESOURCE_MAP[key];
  }
}
