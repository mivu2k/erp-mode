import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Ip, NotFoundException, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { classifyDay, computePayslip, distanceM, fromMinor, passwordSchema, ShiftRule, toMinor } from '@erp/shared';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { toCsv } from '../engine/export';
import { HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { AuditService, Tx } from '../platform/audit.service';
import { LedgerService } from '../platform/ledger.service';
import { NotifyService } from '../platform/notify.service';
import { NumberingService } from '../platform/numbering.service';
import { hashPassword, sha256 } from '../platform/password';
import { PrismaService } from '../platform/prisma.service';
import { PrintService } from '../platform/print.service';
import { SettingsService } from '../platform/settings.service';
import { dateOnly, localParts } from '../platform/time';
import { assertCan, AuthUser, CurrentUser, Permissions, Public } from '../rbac/rbac';

const DEFAULT_SHIFT: ShiftRule = { start: '09:00', end: '17:00', graceMin: 10, halfDayMin: 240, absentMin: 120, otAfterMin: 30, weekend: [0] };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayMs = 86_400_000;

/** Rotating kiosk QR: HMAC of the current time window, so screenshots expire. */
export function rotatingCode(secret: string, at: number, windowSec: number) {
  return createHmac('sha256', secret).update(String(Math.floor(at / 1000 / windowSec))).digest('base64url').slice(0, 16);
}

/** What an employee's status is, from facts only. */
export function employeeStatus(exitType: string | undefined, onLeaveToday: boolean): 'active' | 'on_leave' | 'resigned' | 'terminated' {
  if (exitType === 'termination') return 'terminated';
  if (exitType === 'resignation') return 'resigned';
  return onLeaveToday ? 'on_leave' : 'active';
}

@Controller('hrm')
export class HrmController {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private ledger: LedgerService,
    private numbering: NumberingService,
    private settings: SettingsService,
    private notify: NotifyService,
    private audit: AuditService,
    hooks: HooksService,
  ) {
    // Director status follows the employee type (Master Data 'employee_type' entry with value { "director": true }).
    const directorFlag = async ({ tx, user }: { tx: Tx; user: AuthUser }, data: Row) => {
      if (data.type === undefined) return;
      const t = data.type ? await tx.masterData.findFirst({ where: { companyId: user.companyId, type: 'employee_type', deletedAt: null, OR: [{ code: String(data.type) }, { code: null, name: String(data.type) }] } }) : null;
      data.isDirector = (t?.value as { director?: boolean } | null)?.director === true;
    };
    hooks.on('hrm.employee', {
      beforeCreate: async (ctx, data) => {
        data.qrToken = randomBytes(12).toString('base64url');
        await directorFlag(ctx, data);
      },
      beforeUpdate: (ctx, data) => directorFlag(ctx, data),
      afterCreate: async ({ tx, user }, rec) => {
        await this.ledger.employeeAccount(tx, user.companyId, String(rec.id));
      },
    });
    hooks.on('hrm.leave', {
      beforeCreate: async ({ tx, user }, data) => {
        const from = data.from as Date;
        const to = data.to as Date;
        if (to < from) throw new BadRequestException('"to" is before "from"');
        if (!data.days) data.days = String(Math.round((+to - +from) / dayMs) + 1);
        const bal = await this.leaveBalance(tx, user.companyId, String(data.employeeId), String(data.leaveTypeId), from.getUTCFullYear());
        if (Number(data.days) > bal.remaining) throw new BadRequestException(`Only ${bal.remaining} day(s) left`);
      },
    });
    // Employee status follows approved leave and exit events (never typed in).
    // Deleting an attendance day removes that day's punches too, so reprocessing can't bring the wrong record back
    // (the day is recalculated from what's left: absent, or from punches/corrections added later).
    hooks.on('hrm.attendance', {
      afterDelete: async ({ tx, user }, day) => {
        const company = await tx.company.findUniqueOrThrow({ where: { id: user.companyId } });
        const start = new Date(+(day.date as Date) - tzOffsetMs(company.timezone, day.date as Date));
        await tx.attendancePunch.deleteMany({ where: { companyId: user.companyId, employeeId: String(day.employeeId), at: { gte: start, lt: new Date(+start + dayMs) } } });
      },
    });
    hooks.on('hrm.leave', { onApproved: ({ tx, user }, rec) => this.syncEmployeeStatus(tx, user.companyId, [String(rec.employeeId)]).then(() => undefined) });
    hooks.on('hrm.event', { onApproved: ({ tx, user }, rec) => this.syncEmployeeStatus(tx, user.companyId, [String(rec.employeeId)]).then(() => undefined) });
    hooks.on('hrm.correction', {
      onApproved: async ({ tx, user }, rec) => {
        const punches = [rec.inAt, rec.outAt].filter((d): d is Date => d instanceof Date);
        await tx.attendancePunch.createMany({ data: punches.map((at) => ({ companyId: user.companyId, employeeId: String(rec.employeeId), method: 'manual', at })) });
      },
    });
    hooks.on('hrm.task', {
      beforeUpdate: (_ctx, data, before) => {
        if (data.status === 'done' && before.status !== 'done') data.doneAt = new Date();
      },
      afterCreate: async ({ tx, user }, rec) => {
        await this.notify.send(user.companyId, [await this.notify.employeeUser(rec.assigneeId as string, tx)], { title: `New task: ${rec.title}`, link: `/r/hrm.task/${rec.id}` }, tx);
      },
    });
  }

  // ─── Employees ─────────────────────────────────────────────

  @Post('employees/:id/create-user')
  @Permissions('core.user.create')
  async createUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { email?: string; password?: string }) {
    const b = parse(z.object({ email: z.string().email(), password: passwordSchema }), body);
    return this.prisma.$transaction(async (tx) => {
      const emp = await this.resources.load(tx, user, 'hrm.employee', id);
      if (emp.userId) throw new BadRequestException('Employee already has a user');
      const role = await tx.role.findFirst({ where: { companyId: user.companyId, name: 'Employee' } });
      const created = await tx.user.create({
        data: {
          companyId: user.companyId, email: b.email, name: String(emp.name), passwordHash: await hashPassword(b.password),
          branchId: emp.branchId as string | null, departmentId: emp.departmentId as string | null,
          ...(role ? { roles: { create: { roleId: role.id } } } : {}),
        },
      });
      await tx.employee.update({ where: { id }, data: { userId: created.id } });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'create', entityType: 'core.user', entityId: created.id, after: { email: b.email, employeeId: id } }, tx);
      return { userId: created.id };
    });
  }

  // ─── Kiosk stations ────────────────────────────────────────

  @Post('kiosk/stations/:id/pairing-code')
  @Permissions('hrm.station.manage')
  async pairingCode(@CurrentUser() user: AuthUser, @Param('id') id: string, @Headers('origin') origin?: string) {
    const st = await this.prisma.kioskStation.findFirstOrThrow({ where: { id, companyId: user.companyId } });
    const code = String(randomInt(100000, 1000000));
    await this.prisma.kioskStation.update({ where: { id }, data: { pairingHash: sha256(code), pairingExpires: new Date(Date.now() + 10 * 60_000) } });
    // One-time link (and its QR): opening it on the kiosk device pairs it — nothing to type. The code alone still works.
    const base = /^https?:\/\/[\w.:-]+$/.test(origin ?? '') ? origin! : (process.env.WEB_URL ?? 'http://localhost:3000');
    const link = `${base}/kiosk?code=${code}`;
    return { code, link, qrSvg: new PrintService().qrSvg(link), station: st.name, expiresInMin: 10 };
  }

  /** Admin switches a station's device off (lost tablet, replaced device): its token stops working at once. */
  @Post('kiosk/stations/:id/unpair')
  @Permissions('hrm.station.manage')
  async unpair(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.kioskStation.findFirstOrThrow({ where: { id, companyId: user.companyId } });
    await this.prisma.kioskStation.update({ where: { id }, data: { deviceTokenHash: null, secret: null, pairingHash: null, pairingExpires: null } });
    return { ok: true };
  }

  /** Device exchanges a one-time pairing code for a long-lived, station-scoped device token. */
  @Public()
  @Post('kiosk/pair')
  async pair(@Body() body: { code?: string }) {
    const st = await this.prisma.kioskStation.findFirst({ where: { pairingHash: sha256(String(body?.code ?? '')), pairingExpires: { gt: new Date() }, isActive: true } });
    if (!st) throw new UnauthorizedException('Invalid or expired code');
    const token = randomBytes(32).toString('base64url');
    await this.prisma.kioskStation.update({ where: { id: st.id }, data: { deviceTokenHash: sha256(token), secret: randomBytes(32).toString('hex'), pairingHash: null, pairingExpires: null, lastSeenAt: new Date() } });
    return { deviceToken: token, station: { id: st.id, name: st.name, methods: st.methods } };
  }

  private async station(token: string | undefined, ip: string) {
    const st = token ? await this.prisma.kioskStation.findFirst({ where: { deviceTokenHash: sha256(token), isActive: true, deletedAt: null } }) : null;
    if (!st) throw new UnauthorizedException('Unpaired device');
    const allowed = (st.ipWhitelist as string[] | null) ?? [];
    if (allowed.length && !allowed.includes(ip.replace(/^::ffff:/, ''))) throw new ForbiddenException('IP not allowed for this station');
    await this.prisma.kioskStation.update({ where: { id: st.id }, data: { lastSeenAt: new Date() } });
    return st;
  }

  /** Kiosk punch by NFC card UID or personal QR. `idempotencyKey` makes offline-queue replays safe. */
  @Public()
  @Post('kiosk/punch')
  async kioskPunch(@Headers('x-device-token') token: string, @Ip() ip: string, @Body() body: unknown) {
    const st = await this.station(token, ip);
    const b = parse(z.object({ nfcUid: z.string().optional(), qrToken: z.string().optional(), at: z.coerce.date().optional(), idempotencyKey: z.string().max(100).optional() }), body);
    const methods = st.methods as string[];
    const method = b.nfcUid ? 'nfc' : 'qr';
    if (!methods.includes(method)) throw new BadRequestException(`${method} not enabled on this station`);
    const emp = await this.prisma.employee.findFirst({
      where: { companyId: st.companyId, deletedAt: null, status: { in: ['active', 'on_leave'] }, ...(b.nfcUid ? { nfcUid: b.nfcUid } : { qrToken: b.qrToken ?? '__none__' }) },
    });
    if (!emp) throw new NotFoundException('Card not recognised');
    const at = b.at && b.at <= new Date() && Date.now() - +b.at < 7 * dayMs ? b.at : new Date();
    await this.savePunch({ companyId: st.companyId, employeeId: emp.id, stationId: st.id, method, at, idempotencyKey: b.idempotencyKey });
    return { employee: { name: emp.name, code: emp.code }, at };
  }

  /** Kiosk displays this QR; employees scan it from the app (anti-spoof, rotates every N seconds). */
  @Public()
  @Get('kiosk/qr')
  async kioskQr(@Headers('x-device-token') token: string, @Ip() ip: string) {
    const st = await this.station(token, ip);
    const { rotatingQrSeconds } = await this.settings.get(st.companyId, 'hrm.kiosk');
    const payload = `ERPKIOSK:${st.id}:${rotatingCode(st.secret ?? '', Date.now(), rotatingQrSeconds)}`;
    return { payload, svg: new PrintService().qrSvg(payload), refreshInSec: rotatingQrSeconds };
  }

  @Public()
  @Get('kiosk/health')
  async kioskHealth(@Headers('x-device-token') token: string, @Ip() ip: string) {
    const st = await this.station(token, ip);
    // The kiosk's heartbeat (every minute): keeps "last seen" fresh and hands it the current methods and branding.
    const today = new Date(new Date().toISOString().slice(0, 10));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: st.companyId }, select: { name: true, branding: true } });
    const logo = (company.branding as { logoDark?: string; logo?: string } | null) ?? {};
    return {
      station: st.name, methods: st.methods, company: company.name, logo: logo.logoDark ?? logo.logo ?? null,
      punchesToday: await this.prisma.attendancePunch.count({ where: { stationId: st.id, at: { gte: today } } }),
    };
  }

  /** Employee scans the kiosk's rotating QR with their phone. */
  @Post('attendance/scan')
  async scanKiosk(@CurrentUser() user: AuthUser, @Body() body: { payload?: string; idempotencyKey?: string }) {
    const [prefix, stationId, code] = String(body?.payload ?? '').split(':');
    if (prefix !== 'ERPKIOSK') throw new BadRequestException('Not a kiosk code');
    if (!user.employeeId) throw new BadRequestException('Your login is not linked to an employee record — ask HR');
    const st = await this.prisma.kioskStation.findFirst({ where: { id: stationId, companyId: user.companyId, isActive: true, deletedAt: null } });
    if (!st?.secret) throw new BadRequestException('Unknown station');
    if (!(st.methods as string[]).includes('rotating_qr')) throw new BadRequestException('Scanning is not enabled at this station');
    const { rotatingQrSeconds: w } = await this.settings.get(user.companyId, 'hrm.kiosk');
    const now = Date.now();
    if (![now, now - w * 1000].some((t) => rotatingCode(st.secret!, t, w) === code)) throw new BadRequestException('QR expired, scan again');
    const at = new Date();
    await this.savePunch({ companyId: user.companyId, employeeId: user.employeeId, stationId: st.id, method: 'rotating_qr', at, idempotencyKey: body.idempotencyKey });
    return { ok: true, station: st.name, at };
  }

  /** Mobile punch with GPS; must be inside some station's geofence. */
  @Post('attendance/mobile')
  async mobilePunch(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ lat: z.number(), lng: z.number(), idempotencyKey: z.string().max(100).optional() }), body);
    if (!user.employeeId) throw new BadRequestException('No employee profile');
    const stations = await this.prisma.kioskStation.findMany({ where: { companyId: user.companyId, isActive: true, deletedAt: null, lat: { not: null } } });
    const inside = stations.find((s) => distanceM(b.lat, b.lng, s.lat!, s.lng!) <= s.radiusM);
    if (!inside) throw new BadRequestException('You are outside every allowed location');
    await this.savePunch({ companyId: user.companyId, employeeId: user.employeeId, stationId: inside.id, method: 'mobile', at: new Date(), lat: b.lat, lng: b.lng, idempotencyKey: b.idempotencyKey });
    return { ok: true, station: inside.name };
  }

  @Post('attendance/import')
  @Permissions('hrm.punch.create')
  async importPunches(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const rows = parse(z.array(z.object({ employeeCode: z.string(), at: z.coerce.date() })).max(20_000), body);
    const emps = new Map((await this.prisma.employee.findMany({ where: { companyId: user.companyId, code: { in: rows.map((r) => r.employeeCode) } } })).map((e) => [e.code, e.id]));
    const data = rows.filter((r) => emps.has(r.employeeCode)).map((r) => ({ companyId: user.companyId, employeeId: emps.get(r.employeeCode)!, method: 'import', at: r.at, idempotencyKey: sha256(`${r.employeeCode}|${+r.at}`) }));
    const { count } = await this.prisma.attendancePunch.createMany({ data, skipDuplicates: true });
    return { imported: count, unknown: rows.length - data.length };
  }

  private async savePunch(p: Prisma.AttendancePunchUncheckedCreateInput) {
    try {
      await this.prisma.attendancePunch.create({ data: p });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // replayed offline punch
    }
  }

  /** Builds AttendanceDay rows for one local date from punches, shifts, holidays and approved leave. Safe to re-run. */
  @Post('attendance/process')
  @Permissions('hrm.attendance.manage')
  async process(@CurrentUser() user: AuthUser, @Body() body: { date?: string }) {
    const date = parse(z.string().date(), body?.date);
    return { processed: await this.processDay(user.companyId, date) };
  }

  async processDay(companyId: string, date: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const d = dateOnly(date);
    const [employees, shifts, holidays, leaves, punches] = await Promise.all([
      this.prisma.employee.findMany({ where: { companyId, deletedAt: null, status: { in: ['active', 'on_leave'] }, OR: [{ joinDate: null }, { joinDate: { lte: d } }] } }),
      this.prisma.shift.findMany({ where: { companyId, deletedAt: null } }),
      this.prisma.masterData.findMany({ where: { companyId, type: 'holiday', deletedAt: null, isActive: true } }),
      this.prisma.leaveRequest.findMany({ where: { companyId, status: 'approved', deletedAt: null, from: { lte: d }, to: { gte: d } } }),
      this.prisma.attendancePunch.findMany({ where: { companyId, at: { gte: new Date(+d - dayMs / 2), lt: new Date(+d + 2 * dayMs) } } }),
    ]);
    const shiftMap = new Map(shifts.map((s) => [s.id, s]));
    const holiday = holidays.some((h) => (h.value as { date?: string } | null)?.date === date);
    const onLeave = new Set(leaves.map((l) => l.employeeId));
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    // minutes relative to local midnight of `date` (negative = previous day, >1440 = next day)
    const rel = (at: Date) => {
      const p = localParts(at, company.timezone);
      return p.minutes + Math.round((+dateOnly(p.date) - +d) / dayMs) * 1440;
    };
    for (const e of employees) {
      const s = e.shiftId ? shiftMap.get(e.shiftId) : undefined;
      const rule: ShiftRule = s ? { ...s, weekend: s.weekend as number[] } : DEFAULT_SHIFT;
      const [sh, sm] = rule.start.split(':').map(Number);
      const start = sh * 60 + sm;
      const mins = punches.filter((p) => p.employeeId === e.id).map((p) => rel(p.at)).filter((m) => m >= start - 240 && m < start + 20 * 60);
      const r = classifyDay(rule, weekday, mins, { holiday, leave: onLeave.has(e.id) });
      const toDate = (m: number | null) => (m === null ? null : new Date(+d + m * 60_000 - tzOffsetMs(company.timezone, d)));
      const data = { deletedAt: null, status: r.status, inAt: toDate(r.inMin), outAt: toDate(r.outMin), workedMin: r.workedMin, lateMin: r.lateMin, earlyMin: r.earlyMin, overtimeMin: r.overtimeMin, branchId: e.branchId, departmentId: e.departmentId };
      await this.prisma.attendanceDay.upsert({ where: { employeeId_date: { employeeId: e.id, date: d } }, update: data, create: { companyId, employeeId: e.id, date: d, ...data } });
    }
    return employees.length;
  }

  /**
   * Recomputes employee status from facts: an approved resignation/termination whose date has come → resigned/terminated;
   * otherwise on approved leave today → on_leave; otherwise active. Runs on approvals and nightly (for date changes).
   */
  async syncEmployeeStatus(tx: Tx, companyId: string, ids?: string[], today = new Date()) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const emps = await tx.employee.findMany({ where: { companyId, deletedAt: null, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, status: true } });
    if (!emps.length) return 0;
    const empIds = emps.map((e) => e.id);
    const [exits, leaves] = await Promise.all([
      tx.employeeEvent.findMany({ where: { employeeId: { in: empIds }, status: 'approved', deletedAt: null, type: { in: ['resignation', 'termination'] }, date: { lte: day } }, orderBy: { date: 'asc' }, select: { employeeId: true, type: true } }),
      tx.leaveRequest.findMany({ where: { employeeId: { in: empIds }, status: 'approved', deletedAt: null, from: { lte: day }, to: { gte: day } }, select: { employeeId: true } }),
    ]);
    let changed = 0;
    for (const e of emps) {
      const next = employeeStatus(exits.filter((x) => x.employeeId === e.id).at(-1)?.type, leaves.some((l) => l.employeeId === e.id));
      if (next !== e.status) { await tx.employee.update({ where: { id: e.id }, data: { status: next } }); changed++; }
    }
    return changed;
  }

  // ─── Leave ─────────────────────────────────────────────────

  @Get('leave/balance/:employeeId')
  async balance(@CurrentUser() user: AuthUser, @Param('employeeId') employeeId: string, @Query('year') year?: string) {
    await this.resources.get(user, 'hrm.employee', employeeId);
    const types = await this.prisma.leaveType.findMany({ where: { companyId: user.companyId, deletedAt: null } });
    const y = Number(year) || new Date().getUTCFullYear();
    return Promise.all(types.map(async (t) => ({ type: t.name, leaveTypeId: t.id, ...(await this.leaveBalance(this.prisma, user.companyId, employeeId, t.id, y)) })));
  }

  // ponytail: carry-forward = unused of previous year capped at carryForward; no monthly accrual proration yet
  private async leaveBalance(tx: Tx, companyId: string, employeeId: string, leaveTypeId: string, year: number) {
    const t = await tx.leaveType.findFirstOrThrow({ where: { id: leaveTypeId, companyId } });
    const used = async (y: number) =>
      Number((await tx.leaveRequest.aggregate({ _sum: { days: true }, where: { employeeId, leaveTypeId, status: { in: ['approved', 'pending'] }, deletedAt: null, from: { gte: dateOnly(`${y}-01-01`), lt: dateOnly(`${y + 1}-01-01`) } } }))._sum.days ?? 0);
    const prevUnused = Math.max(0, Number(t.daysPerYear) - (await used(year - 1)));
    const entitled = Number(t.daysPerYear) + Math.min(prevUnused, Number(t.carryForward));
    const taken = await used(year);
    return { entitled, taken, remaining: entitled - taken };
  }

  // ─── Payroll ───────────────────────────────────────────────

  @Post('payroll/generate')
  @Permissions('hrm.payroll.create')
  async generate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), branchId: z.string().nullish() }), body);
    const cfg = await this.settings.get(user.companyId, 'hrm.payroll');
    const from = dateOnly(`${b.period}-01`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.payrollRun.findFirst({ where: { companyId: user.companyId, branchId: b.branchId ?? null, period: b.period, deletedAt: null } });
      if (existing) throw new BadRequestException(`Payroll for ${b.period} already exists (${existing.number})`);
      const employees = await tx.employee.findMany({ where: { companyId: user.companyId, deletedAt: null, status: { in: ['active', 'on_leave'] }, ...(b.branchId ? { branchId: b.branchId } : {}) } });
      const structures = new Map((await tx.salaryStructure.findMany({ where: { employeeId: { in: employees.map((e) => e.id) }, deletedAt: null } })).map((s) => [s.employeeId, s]));
      const unpaidTypes = (await tx.leaveType.findMany({ where: { companyId: user.companyId, paid: false } })).map((t) => t.id);
      const number = await this.numbering.next(tx, user.companyId, b.branchId, 'PAY', 'PAY-{YYYY}-{SEQ:4}');
      const run = await tx.payrollRun.create({ data: { companyId: user.companyId, branchId: b.branchId ?? null, period: b.period, number, createdById: user.id } });
      let gross = 0;
      let net = 0;
      for (const e of employees) {
        const s = structures.get(e.id);
        if (!s) continue;
        const days = await tx.attendanceDay.findMany({ where: { employeeId: e.id, date: { gte: from, lt: to } } });
        const unpaidLeave = Number((await tx.leaveRequest.aggregate({ _sum: { days: true }, where: { employeeId: e.id, leaveTypeId: { in: unpaidTypes }, status: 'approved', from: { gte: from, lt: to } } }))._sum.days ?? 0);
        const advances = await tx.advance.findMany({ where: { employeeId: e.id, kind: 'salary', status: 'disbursed', deletedAt: null } });
        const installments = advances.reduce((sum, a) => sum + Math.min(Number(a.installmentAmount), Number(a.amount) - Number(a.recovered)), 0);
        const p = computePayslip({
          basic: Number(s.basic), components: s.components as never, taxPercent: Number(s.taxPercent), workingDays: cfg.workingDays, hoursPerDay: cfg.hoursPerDay, overtimeMultiplier: cfg.overtimeMultiplier,
          absentDays: days.filter((x) => x.status === 'absent').length + days.filter((x) => x.status === 'half_day').length * cfg.halfDayFactor + unpaidLeave,
          overtimeMin: days.reduce((sum, x) => sum + x.overtimeMin, 0),
          advanceInstallments: installments,
        });
        await tx.payslip.create({
          data: {
            companyId: user.companyId, runId: run.id, employeeId: e.id, period: b.period,
            lines: p.lines.map((l) => ({ ...l, amount: fromMinor(l.amount) })), gross: fromMinor(p.gross), deductions: fromMinor(p.deductions), advanceDeduction: fromMinor(p.advanceDeduction), net: fromMinor(p.net),
          },
        });
        gross += p.gross;
        net += p.net;
      }
      await tx.payrollRun.update({ where: { id: run.id }, data: { gross: fromMinor(gross), net: fromMinor(net) } });
      return { id: run.id, number };
    });
  }

  /** Approved run → journal: Dr salary expense; Cr salary payable (net), employee account (advance recovery), deductions payable. */
  @Post('payroll/:id/post')
  @Permissions('hrm.payroll.approve')
  async post(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.resources.load(tx, user, 'hrm.payroll', id, 'approve');
      if (run.status !== 'approved') throw new BadRequestException('Run must be approved');
      const acc = await this.ledger.accounts(user.companyId);
      const slips = await tx.payslip.findMany({ where: { runId: id } });
      const lines = [];
      for (const s of slips) {
        const other = toMinor(s.deductions) - toMinor(s.advanceDeduction);
        lines.push(
          { accountId: acc.salaryExpense, debit: Number(s.gross), employeeId: s.employeeId },
          { accountId: acc.salaryPayable, credit: Number(s.net), employeeId: s.employeeId },
          { accountId: acc.deductionsPayable, credit: fromMinor(other), employeeId: s.employeeId },
        );
        if (toMinor(s.advanceDeduction) > 0) {
          lines.push({ accountId: await this.ledger.employeeAccount(tx, user.companyId, s.employeeId), credit: Number(s.advanceDeduction), employeeId: s.employeeId });
          await this.recoverAdvances(tx, s.employeeId, toMinor(s.advanceDeduction));
        }
      }
      const je = await this.ledger.post(tx, { companyId: user.companyId, branchId: run.branchId as string | null, memo: `Payroll ${run.period}`, sourceType: 'hrm.payroll', sourceId: id, userId: user.id, lines });
      await tx.payslip.updateMany({ where: { runId: id }, data: { status: 'posted' } });
      await this.resources.setStatus(tx, user, 'hrm.payroll', id, 'posted', { journalId: je.id });
      for (const s of slips) await this.notify.send(user.companyId, [await this.notify.employeeUser(s.employeeId, tx)], { title: `Payslip ${s.period} is available`, link: `/r/hrm.payslip/${s.id}` }, tx);
      return { journal: je.number };
    });
  }

  /** Applies a recovery amount (minor units) across the employee's open salary advances, oldest first. */
  private async recoverAdvances(tx: Tx, employeeId: string, amount: number) {
    const open = await tx.advance.findMany({ where: { employeeId, kind: 'salary', status: 'disbursed', deletedAt: null }, orderBy: { disbursedAt: 'asc' } });
    for (const a of open) {
      if (amount <= 0) break;
      const take = Math.min(amount, toMinor(a.amount) - toMinor(a.recovered));
      const recovered = toMinor(a.recovered) + take;
      await tx.advance.update({ where: { id: a.id }, data: { recovered: fromMinor(recovered), status: recovered >= toMinor(a.amount) ? 'settled' : 'disbursed' } });
      amount -= take;
    }
  }

  @Post('payslips/:id/pay')
  @Permissions('finance.payment.create')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amount: z.coerce.number().positive(), accountId: z.string(), methodId: z.string().nullish(), idempotencyKey: z.string().optional() }), body);
    return this.prisma.$transaction(async (tx) => {
      const slip = await tx.payslip.findFirst({ where: { id, companyId: user.companyId } });
      if (!slip || !['posted', 'partially_paid'].includes(slip.status)) throw new BadRequestException('Payslip is not payable');
      const due = toMinor(slip.net) - toMinor(slip.paid);
      if (toMinor(b.amount) > due) throw new BadRequestException(`Only ${fromMinor(due)} is payable`);
      const acc = await this.ledger.accounts(user.companyId);
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Salary ${slip.period}`, sourceType: 'hrm.payslip', sourceId: id, userId: user.id,
        lines: [{ accountId: acc.salaryPayable, debit: b.amount, employeeId: slip.employeeId }, { accountId: b.accountId, credit: b.amount, employeeId: slip.employeeId }],
      });
      await tx.payment.create({
        data: {
          companyId: user.companyId, number: await this.numbering.next(tx, user.companyId, user.branchId, 'PMT', 'PMT-{YYYY}-{SEQ:5}'), direction: 'out', partyType: 'employee', partyId: slip.employeeId,
          refType: 'hrm.payslip', refId: id, date: new Date(), amount: b.amount, accountId: b.accountId, methodId: b.methodId, idempotencyKey: b.idempotencyKey, journalId: je.id, createdById: user.id,
        },
      });
      const paid = toMinor(slip.paid) + toMinor(b.amount);
      await tx.payslip.update({ where: { id }, data: { paid: fromMinor(paid), status: paid >= toMinor(slip.net) ? 'paid' : 'partially_paid' } });
      return { paid: fromMinor(paid) };
    });
  }

  @Get('payroll/:id/bank-sheet')
  @Permissions('hrm.payroll.export')
  async bankSheet(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const run = await this.resources.get(user, 'hrm.payroll', id);
    const slips = await this.prisma.payslip.findMany({ where: { runId: id } });
    const emps = new Map((await this.prisma.employee.findMany({ where: { id: { in: slips.map((s) => s.employeeId) } } })).map((e) => [e.id, e]));
    const rows: Row[] = slips.map((s) => {
      const e = emps.get(s.employeeId);
      const bank = (e?.bank ?? {}) as Record<string, string>;
      return { code: e?.code, name: e?.name, bank: bank.bankName, accountTitle: bank.accountTitle, iban: bank.iban, amount: fromMinor(toMinor(s.net) - toMinor(s.paid)) };
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bank-sheet-${run.period}.csv"`);
    res.send(toCsv(['code', 'name', 'bank', 'accountTitle', 'iban', 'amount'], rows));
  }

  // ─── Tasks ─────────────────────────────────────────────────

  /** Per-employee task performance over a date range. */
  @Get('tasks/performance')
  @Permissions('hrm.task.view')
  async performance(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const where = { companyId: user.companyId, deletedAt: null, createdAt: { gte: from ? new Date(from) : new Date(Date.now() - 30 * dayMs), lte: to ? new Date(to) : new Date() } };
    const tasks = await this.prisma.task.findMany({ where, select: { assigneeId: true, status: true, dueDate: true, doneAt: true } });
    const by = new Map<string, { total: number; done: number; onTime: number; overdue: number }>();
    for (const t of tasks) {
      const k = t.assigneeId ?? 'unassigned';
      const s = by.get(k) ?? { total: 0, done: 0, onTime: 0, overdue: 0 };
      s.total++;
      if (t.status === 'done') {
        s.done++;
        if (!t.dueDate || (t.doneAt && t.doneAt <= t.dueDate)) s.onTime++;
      } else if (t.dueDate && t.dueDate < new Date()) s.overdue++;
      by.set(k, s);
    }
    const names = new Map((await this.prisma.employee.findMany({ where: { id: { in: [...by.keys()] } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    return [...by.entries()].map(([id, s]) => ({ employeeId: id, name: names.get(id) ?? id, ...s }));
  }

  /** Documents expiring within N days (employees + vehicles). */
  @Get('documents/expiring')
  async expiring(@CurrentUser() user: AuthUser, @Query('days') days = '30') {
    assertCan(user, 'hrm.document.view');
    return this.prisma.documentRecord.findMany({
      where: { companyId: user.companyId, deletedAt: null, expiryDate: { lte: new Date(Date.now() + Number(days) * dayMs) } },
      orderBy: { expiryDate: 'asc' },
    });
  }
}

/** Offset of a timezone from UTC at a given instant, in ms. */
export function tzOffsetMs(timeZone: string, at: Date) {
  const p = localParts(at, timeZone);
  const localAsUtc = +dateOnly(p.date) + p.minutes * 60_000;
  return localAsUtc - Math.floor(+at / 60_000) * 60_000;
}

