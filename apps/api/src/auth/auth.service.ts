import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { passwordSchema } from '@erp/shared';
import { AuditService } from '../platform/audit.service';
import { decrypt, encrypt } from '../platform/crypto';
import { hashPassword, randomToken, sha256, verifyPassword } from '../platform/password';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { newTotpSecret, verifyTotp } from '../platform/totp';
import type { AccessPayload } from '../rbac/rbac';

export interface ClientInfo { ip?: string; userAgent?: string }
export interface TokenPair { accessToken: string; refreshToken: string; refreshExpiresAt: Date }

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService, private settings: SettingsService) {}

  async login(login: string, password: string, client: ClientInfo, otp?: string): Promise<TokenPair | { twoFactorRequired: true }> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: login }, { username: login }], deletedAt: null },
    });
    const fail = () => new UnauthorizedException('Invalid credentials');
    if (!user || !user.isActive) throw fail();
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Account locked, try later');

    const policy = await this.settings.get(user.companyId, 'auth');
    const otpBad = user.totpEnabled && otp !== undefined && !verifyTotp(decrypt(user.totpSecret ?? ''), otp);
    if (!(await verifyPassword(password, user.passwordHash)) || otpBad) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: failed >= policy.maxFailed
          ? { failedLogins: 0, lockedUntil: new Date(Date.now() + policy.lockMinutes * 60_000) }
          : { failedLogins: failed },
      });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'login_failed', entityType: 'User', entityId: user.id, ...client });
      throw fail();
    }

    if (user.totpEnabled && otp === undefined) return { twoFactorRequired: true };
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'login', entityType: 'User', entityId: user.id, ...client });
    return this.issue(user.id, user.companyId, randomUUID(), client);
  }

  /** Rotates a refresh token. Presenting an already-revoked token revokes its whole family (theft detection). */
  async refresh(token: string, client: ClientInfo): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row) throw new UnauthorizedException();
    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      await this.audit.log({ companyId: row.user.companyId, userId: row.userId, action: 'refresh_reuse', entityType: 'RefreshToken', entityId: row.familyId, ...client });
      throw new UnauthorizedException();
    }
    if (row.expiresAt < new Date() || !row.user.isActive || row.user.deletedAt) throw new UnauthorizedException();

    // Conditional update guards against two concurrent refreshes both succeeding.
    const { count } = await this.prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count === 0) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException();
    }
    return this.issue(row.userId, row.user.companyId, row.familyId, client);
  }

  async logout(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (row) await this.revokeFamily(row.familyId);
  }

  /** Active sessions = one per unrevoked, unexpired family head. */
  sessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { familyId: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Revoke one session (familyId) or all sessions of a user (force logout). */
  async revokeSessions(userId: string, familyId?: string) {
    await this.prisma.refreshToken.updateMany({ where: { userId, familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  // ─── Preferences ───
  preferences(userId: string) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyEmail: true, notifySms: true, locale: true, delegateToId: true, delegateUntil: true, totpEnabled: true } });
  }

  async setPreferences(user: { id: string; companyId: string }, b: { notifyEmail?: boolean; notifySms?: boolean; locale?: string; delegateToId?: string | null; delegateUntil?: string | null }) {
    if (b.locale !== undefined && !['en', 'ur'].includes(b.locale)) throw new BadRequestException('Unsupported language');
    if (b.delegateToId) {
      if (b.delegateToId === user.id) throw new BadRequestException('Cannot delegate to yourself');
      const d = await this.prisma.user.findFirst({ where: { id: b.delegateToId, companyId: user.companyId, isActive: true } });
      if (!d) throw new BadRequestException('Unknown user');
    }
    const until = b.delegateUntil ? new Date(b.delegateUntil) : null;
    if (until && isNaN(+until)) throw new BadRequestException('Invalid date');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { ...(b.notifyEmail !== undefined ? { notifyEmail: !!b.notifyEmail } : {}), ...(b.notifySms !== undefined ? { notifySms: !!b.notifySms } : {}), ...(b.locale ? { locale: b.locale } : {}), ...('delegateToId' in b ? { delegateToId: b.delegateToId || null, delegateUntil: b.delegateToId ? until : null } : {}) },
    });
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'preferences', entityType: 'core.user', entityId: user.id, after: b });
  }

  // ─── 2FA ───
  async setupTotp(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: encrypt(secret), totpEnabled: false } });
    return { secret, otpauth: `otpauth://totp/ERP:${encodeURIComponent(user.email)}?secret=${secret}&issuer=ERP` };
  }

  async enableTotp(userId: string, code: string, enable: boolean) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret || !verifyTotp(decrypt(user.totpSecret), code)) throw new BadRequestException('Invalid code');
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: enable, ...(enable ? {} : { totpSecret: null }) } });
  }

  // ─── Password reset ───
  /** Always succeeds (no account enumeration). */
  async forgot(email: string) {
    const user = await this.prisma.user.findFirst({ where: { email, isActive: true, deletedAt: null } });
    if (!user) return;
    const token = randomToken();
    await this.prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: sha256(token), resetExpires: new Date(Date.now() + 30 * 60_000) } });
    // ponytail: logs the link until SMTP settings are wired to a mailer
    new Logger('Auth').log(`Password reset for ${email}: ${process.env.WEB_URL ?? 'http://localhost:3000'}/reset?token=${token}`);
  }

  async reset(token: string, password: string) {
    const pw = passwordSchema.safeParse(password);
    if (!pw.success) throw new BadRequestException(pw.error.flatten());
    const user = await this.prisma.user.findFirst({ where: { resetTokenHash: sha256(token), resetExpires: { gt: new Date() } } });
    if (!user) throw new BadRequestException('Invalid or expired link');
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), resetTokenHash: null, resetExpires: null, failedLogins: 0, lockedUntil: null } });
    await this.revokeSessions(user.id);
  }

  private revokeFamily(familyId: string) {
    return this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async issue(userId: string, companyId: string, familyId: string, client: ClientInfo): Promise<TokenPair> {
    const payload: AccessPayload = { sub: userId, cid: companyId };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(Date.now() + Number(process.env.REFRESH_TTL_DAYS ?? 14) * 86_400_000);
    await this.prisma.refreshToken.create({
      data: { userId, familyId, tokenHash: sha256(refreshToken), expiresAt: refreshExpiresAt, ip: client.ip, userAgent: client.userAgent?.slice(0, 512) },
    });
    return { accessToken, refreshToken, refreshExpiresAt };
  }
}
