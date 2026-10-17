import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LoginInput, loginSchema } from '@erp/shared';
import type { Request, Response } from 'express';
import { ZodPipe } from '../platform/zod.pipe';
import { AuthGuard, AuthUser, CurrentUser, Permissions, Public } from '../rbac/rbac';
import { AuthService, ClientInfo, TokenPair } from './auth.service';

const COOKIE = 'rt';

/**
 * Web: refresh token in httpOnly cookie (path-scoped to /api/auth, SameSite=strict → CSRF-safe).
 * Mobile: send { refreshToken } in the body instead.
 */
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private guard: AuthGuard) {}

  @Public()
  @Throttle({ default: { limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10), ttl: 60_000 } }) // per IP per minute
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body.login, body.password, client(req), body.otp);
    return 'twoFactorRequired' in r ? r : this.respond(res, r);
  }

  @Public()
  // One refresh per page load: generous per IP (an office behind one address), still capped against abuse.
  @Throttle({ default: { limit: Number(process.env.REFRESH_RATE_LIMIT ?? 120), ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.refresh(readToken(req), client(req)));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[COOKIE] ?? req.body?.refreshToken;
    if (token) await this.auth.logout(token);
    res.clearCookie(COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.sessions(user.id);
  }

  @Delete('sessions/:familyId')
  @HttpCode(204)
  revokeOwn(@CurrentUser() user: AuthUser, @Param('familyId') familyId: string) {
    return this.auth.revokeSessions(user.id, familyId);
  }

  @Get('preferences')
  async preferences(@CurrentUser() user: AuthUser) {
    return this.auth.preferences(user.id);
  }

  /** Self-service: email notifications on/off and approval delegation while on leave. */
  @Post('preferences')
  @HttpCode(204)
  async setPreferences(@CurrentUser() user: AuthUser, @Body() b: { notifyEmail?: boolean; notifySms?: boolean; locale?: string; delegateToId?: string | null; delegateUntil?: string | null }) {
    await this.auth.setPreferences(user, b);
    this.guard.invalidate(user.id);
  }

  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.setupTotp(user.id);
  }

  @Post('2fa/enable')
  @HttpCode(204)
  enable2fa(@CurrentUser() user: AuthUser, @Body() b: { code: string; enable?: boolean }) {
    return this.auth.enableTotp(user.id, String(b?.code ?? ''), b?.enable !== false);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot')
  @HttpCode(204)
  forgot(@Body() b: { email?: string }) {
    return this.auth.forgot(String(b?.email ?? ''));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset')
  @HttpCode(204)
  reset(@Body() b: { token?: string; password?: string }) {
    return this.auth.reset(String(b?.token ?? ''), String(b?.password ?? ''));
  }

  /** Admin force-logout of every session of a user. */
  @Post('users/:userId/logout')
  @Permissions('core.user.manage')
  @HttpCode(204)
  forceLogout(@Param('userId') userId: string) {
    return this.auth.revokeSessions(userId);
  }

  // HTTPS-only in production; COOKIE_SECURE=false allows a plain-http:// LAN install (private IP, no certificate).
  private respond(res: Response, t: TokenPair) {
    res.cookie(COOKIE, t.refreshToken, {
      httpOnly: true, secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/auth', expires: t.refreshExpiresAt,
    });
    return t;
  }
}

function readToken(req: Request): string {
  const t = req.cookies?.[COOKIE] ?? req.body?.refreshToken;
  if (typeof t !== 'string' || !t) throw new UnauthorizedException();
  return t;
}

const client = (req: Request): ClientInfo => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
