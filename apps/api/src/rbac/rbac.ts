import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { EMPLOYEE_OWNERS, type DataScope } from '@erp/shared';
import type { Request } from 'express';
import { PrismaService } from '../platform/prisma.service';

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS = 'permissions';
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Requires ALL listed permission keys. */
export const Permissions = (...keys: string[]) => SetMetadata(PERMISSIONS, keys);

export interface AuthUser {
  id: string;
  name: string;
  locale: string;
  companyId: string;
  branchId: string | null;
  departmentId: string | null;
  employeeId: string | null;
  roleIds: string[];
  permissions: Record<string, DataScope>;
  /** Disabled module keys for the company. */
  disabledModules: string[];
}
export interface AccessPayload { sub: string; cid: string }

export type AuthedRequest = Request & { user?: AuthUser };
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

const SCOPE_RANK: Record<DataScope, number> = { own: 0, department: 1, branch: 2, all: 3 };

/** Merges role permissions, keeping the widest scope per key. */
export function mergeScopes(rows: { key: string; scope: DataScope }[]): Record<string, DataScope> {
  const out: Record<string, DataScope> = {};
  for (const { key, scope } of rows) if (!out[key] || SCOPE_RANK[scope] > SCOPE_RANK[out[key]]) out[key] = scope;
  return out;
}

export function can(user: AuthUser, key: string): boolean {
  return key in user.permissions && !user.disabledModules.includes(key.split('.')[0]);
}

export function assertCan(user: AuthUser, key: string) {
  if (!can(user, key)) throw new ForbiddenException(`Missing permission ${key}`);
}

export interface ScopeOpts { owner?: string; columns?: Set<string> }

/**
 * Prisma where-fragment restricting rows to the user's scope for a permission.
 * When a model lacks the branch/department column, scope degrades to the owner rule (never widens).
 */
export function scopeWhere(user: AuthUser, key: string, opts: ScopeOpts = {}): Record<string, unknown> {
  assertCan(user, key);
  const has = (c: string) => !opts.columns || opts.columns.has(c);
  const ownerField = opts.owner ?? 'createdById';
  const own = () => {
    if (!has(ownerField)) return { id: '__none__' };
    const v = EMPLOYEE_OWNERS.includes(ownerField) ? user.employeeId : user.id;
    return { [ownerField]: v ?? '__none__' };
  };
  const base = has('companyId') ? { companyId: user.companyId } : {};
  switch (user.permissions[key]) {
    case 'all': return base;
    case 'branch': return { ...base, ...(has('branchId') ? { branchId: user.branchId } : own()) };
    case 'department': return { ...base, ...(has('departmentId') ? { departmentId: user.departmentId } : own()) };
    default: return { ...base, ...own() };
  }
}

/** Same rule as scopeWhere, evaluated against a record in memory (for create/update). */
export function inScope(user: AuthUser, key: string, rec: Record<string, unknown>, opts: ScopeOpts = {}): boolean {
  const where = scopeWhere(user, key, opts);
  return Object.entries(where).every(([k, v]) => rec[k] === v);
}

/** Global guard: JWT authentication + permission check + module toggle. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException();
    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    req.user = await this.load(payload.sub);

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, targets) ?? [];
    for (const k of required) assertCan(req.user, k);
    return true;
  }

  // ponytail: per-process cache, 10s TTL, busted locally on edits; other API instances converge within 10s (use Redis pub/sub if that matters)
  private cache = new Map<string, { at: number; user: AuthUser }>();

  async load(userId: string): Promise<AuthUser> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 10_000) return hit.user;
    const user = await this.fetch(userId);
    if (this.cache.size > 5_000) this.cache.clear();
    this.cache.set(userId, { at: Date.now(), user });
    return user;
  }

  /** Drop cached identity after changes that affect it (one user, or everyone for role/module-wide edits). */
  invalidate(userId?: string) {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  private async fetch(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    if (!user) throw new UnauthorizedException();
    const [employee, disabled] = await Promise.all([
      this.prisma.employee.findFirst({ where: { userId: user.id, deletedAt: null }, select: { id: true } }),
      this.prisma.companyModule.findMany({ where: { companyId: user.companyId, enabled: false }, select: { key: true } }),
    ]);
    const roles = user.roles.filter((ur) => !ur.role.deletedAt);
    return {
      id: user.id,
      name: user.name,
      locale: user.locale,
      companyId: user.companyId,
      branchId: user.branchId,
      departmentId: user.departmentId,
      employeeId: employee?.id ?? null,
      roleIds: roles.map((r) => r.roleId),
      permissions: mergeScopes(roles.flatMap((ur) => ur.role.permissions.map((rp) => ({ key: rp.permission.key, scope: rp.scope })))),
      disabledModules: disabled.map((d) => d.key),
    };
  }
}
