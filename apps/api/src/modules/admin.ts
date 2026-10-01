import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ALL_PERMISSIONS, MODULES, passwordSchema } from '@erp/shared';
import { DataScope } from '@prisma/client';
import { z } from 'zod';
import { HookCtx, HooksService } from '../engine/hooks';
import { parse } from '../engine/resource.service';
import { AuditService } from '../platform/audit.service';
import { encrypt } from '../platform/crypto';
import { hashPassword } from '../platform/password';
import { PrismaService } from '../platform/prisma.service';
import { DEFAULT_SETTINGS, SettingsService } from '../platform/settings.service';
import { AuthGuard, AuthUser, CurrentUser, Permissions } from '../rbac/rbac';

const MASK = '••••••';
const matrixSchema = z.array(z.object({ key: z.string(), scope: z.enum(['own', 'department', 'branch', 'all']) }));

@Controller()
export class AdminController {
  constructor(private prisma: PrismaService, private settings: SettingsService, private audit: AuditService, private guard: AuthGuard, hooks: HooksService) {
    // Users are created through the generic engine; the password arrives as a plain field and is hashed here.
    hooks.on('core.user', {
      beforeCreate: async (ctx, data) => {
        data.passwordHash = await hashPassword(parse(passwordSchema, ctx.body?.password));
      },
    });
    // Logos are stored as small raster data URLs so they render everywhere (sidebar, login, prints, server PDFs).
    const checkBranding = (_c: unknown, data: Record<string, unknown>) => {
      const b = data.branding as Record<string, unknown> | null | undefined;
      for (const k of ['logo', 'logoDark']) {
        const v = b?.[k];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) throw new BadRequestException(`${k}: upload a PNG, JPEG or WebP image`);
        if (v.length > 550_000) throw new BadRequestException(`${k}: image too large (max ~400 KB)`);
      }
    };
    hooks.on('core.company', { beforeUpdate: checkBranding });
    hooks.on('core.user', { afterUpdate: (_c, rec) => this.guard.invalidate(String(rec.id)) });
    hooks.on('core.role', { afterUpdate: () => this.guard.invalidate() });
    // One custom field per label on a form: a second "Blood group" on Employees is refused.
    const uniqueLabel = async ({ tx, user }: HookCtx, data: Record<string, unknown>, before?: Record<string, unknown>) => {
      const resource = String(data.resource ?? before?.resource ?? '');
      const label = String(data.label ?? before?.label ?? '').trim();
      const dup = await tx.customField.findFirst({ where: { companyId: user.companyId, resource, deletedAt: null, label, ...(before ? { id: { not: String(before.id) } } : {}) } });
      if (dup) throw new BadRequestException(`"${label}" already exists on this form`);
    };
    hooks.on('core.customfield', { beforeCreate: (ctx, data) => uniqueLabel(ctx, data), beforeUpdate: (ctx, data, before) => uniqueLabel(ctx, data, before) });
    hooks.on('core.setting', { afterUpdate: () => this.settings.clear(), afterCreate: () => this.settings.clear() });
  }

  @Get('admin/permissions')
  @Permissions('core.role.view')
  permissions() {
    return ALL_PERMISSIONS;
  }

  /** Role × permission × scope matrix. */
  @Get('roles/:id/permissions')
  @Permissions('core.role.view')
  async matrix(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const role = await this.prisma.role.findFirstOrThrow({ where: { id, companyId: user.companyId }, include: { permissions: { include: { permission: true } } } });
    return role.permissions.map((p) => ({ key: p.permission.key, scope: p.scope }));
  }

  @Put('roles/:id/permissions')
  @Permissions('core.role.manage')
  @HttpCode(204)
  async setMatrix(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const rows = parse(matrixSchema, body);
    await this.prisma.$transaction(async (tx) => {
      await tx.role.findFirstOrThrow({ where: { id, companyId: user.companyId } });
      const perms = await tx.permission.findMany({ where: { key: { in: rows.map((r) => r.key) } } });
      const byKey = new Map(perms.map((p) => [p.key, p.id]));
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: rows.filter((r) => byKey.has(r.key)).map((r) => ({ roleId: id, permissionId: byKey.get(r.key)!, scope: r.scope as DataScope })) });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'permissions', entityType: 'core.role', entityId: id, after: rows }, tx);
    });
    this.guard.invalidate();
  }

  @Post('roles/:id/clone')
  @Permissions('core.role.create')
  async clone(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { name?: string }) {
    const name = parse(z.string().min(1).max(100), body?.name);
    const src = await this.prisma.role.findFirstOrThrow({ where: { id, companyId: user.companyId }, include: { permissions: true } });
    return this.prisma.role.create({
      data: { companyId: user.companyId, name, permissions: { create: src.permissions.map((p) => ({ permissionId: p.permissionId, scope: p.scope })) } },
    });
  }

  @Post('users/:id/password')
  @Permissions('core.user.manage')
  @HttpCode(204)
  async setPassword(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { password?: string }) {
    const pw = parse(passwordSchema, body?.password);
    await this.prisma.user.findFirstOrThrow({ where: { id, companyId: user.companyId } });
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(pw), failedLogins: 0, lockedUntil: null } });
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'password_reset', entityType: 'core.user', entityId: id });
  }

  @Post('users/:id/roles')
  @Permissions('core.user.manage')
  @HttpCode(204)
  async setRoles(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { roleIds?: unknown }) {
    const roleIds = parse(z.array(z.string()), body?.roleIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.findFirstOrThrow({ where: { id, companyId: user.companyId } });
      if ((await tx.role.count({ where: { id: { in: roleIds }, companyId: user.companyId } })) !== roleIds.length) throw new BadRequestException('Unknown role');
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'roles', entityType: 'core.user', entityId: id, after: roleIds }, tx);
    });
    this.guard.invalidate(id);
  }

  @Get('users/:id/roles')
  @Permissions('core.user.view')
  async roles(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return (await this.prisma.userRole.findMany({ where: { userId: id, user: { companyId: user.companyId } } })).map((r) => r.roleId);
  }

  @Get('admin/modules')
  @Permissions('core.module.view')
  async modules(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.companyModule.findMany({ where: { companyId: user.companyId } });
    return Object.entries(MODULES).map(([key, m]) => ({ key, ...m, enabled: rows.find((r) => r.key === key)?.enabled ?? true }));
  }

  @Put('admin/modules/:key')
  @Permissions('core.module.manage')
  @HttpCode(204)
  async toggle(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() body: { enabled?: boolean }) {
    if (!(key in MODULES) || key === 'core') throw new BadRequestException('Unknown or core module');
    const enabled = body?.enabled !== false;
    await this.prisma.companyModule.upsert({ where: { companyId_key: { companyId: user.companyId, key } }, update: { enabled }, create: { companyId: user.companyId, key, enabled } });
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: enabled ? 'enable' : 'disable', entityType: 'core.module', entityId: key });
    this.guard.invalidate();
  }

  /** Effective settings (defaults merged with overrides). */
  @Get('admin/settings')
  @Permissions('core.setting.view')
  async allSettings(@CurrentUser() user: AuthUser) {
    const keys = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];
    const all = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await this.settings.get(user.companyId, k)])));
    return { ...all, smtp: { ...all.smtp, pass: all.smtp.pass ? MASK : '' } };
  }

  @Put('admin/settings/:key')
  @Permissions('core.setting.manage')
  @HttpCode(204)
  async setSetting(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() body: { value: unknown }) {
    if (!(key in DEFAULT_SETTINGS)) throw new BadRequestException('Unknown setting');
    let value = body?.value;
    if (key === 'smtp') {
      const v = value as { pass?: string };
      value = { ...v, pass: v?.pass === MASK ? (await this.settings.get(user.companyId, 'smtp')).pass : v?.pass ? encrypt(v.pass) : '' };
    }
    await this.settings.set(user.companyId, key, value);
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'update', entityType: 'core.setting', entityId: key, after: key === 'smtp' ? { ...(value as object), pass: '***' } : value });
  }

  @Get('admin/dashboard')
  @Permissions('core.audit.view')
  async dashboard(@CurrentUser() user: AuthUser) {
    const c = user.companyId;
    const since = new Date(Date.now() - 86_400_000);
    const [users, activeSessions, pendingApprovals, logins24h, failed24h, employees, openJobs] = await Promise.all([
      this.prisma.user.count({ where: { companyId: c, isActive: true, deletedAt: null } }),
      this.prisma.refreshToken.count({ where: { user: { companyId: c }, revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.approvalRequest.count({ where: { companyId: c, status: 'pending' } }),
      this.prisma.auditLog.count({ where: { companyId: c, action: 'login', createdAt: { gt: since } } }),
      this.prisma.auditLog.count({ where: { companyId: c, action: 'login_failed', createdAt: { gt: since } } }),
      this.prisma.employee.count({ where: { companyId: c, status: 'active', deletedAt: null } }),
      this.prisma.job.count({ where: { companyId: c, deletedAt: null, status: { notIn: ['delivered', 'closed'] } } }),
    ]);
    return { users, activeSessions, pendingApprovals, logins24h, failed24h, employees, openJobs, uptimeSec: Math.round(process.uptime()) };
  }
}
