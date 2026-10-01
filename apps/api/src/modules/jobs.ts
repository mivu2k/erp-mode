import { BadRequestException, Controller, Get, Injectable, Logger, OnModuleDestroy, OnModuleInit, Param, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WorkflowService } from '../engine/workflow.service';
import { toXlsx } from '../engine/export';
import { MailerService } from '../platform/mailer.service';
import { NotifyService } from '../platform/notify.service';
import { NumberingService } from '../platform/numbering.service';
import { esc } from '../platform/print.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { dateOnly, localParts } from '../platform/time';
import { AuthGuard, AuthUser, CurrentUser, Permissions } from '../rbac/rbac';
import { HrmController } from './hrm';
import { reportSchema, ReportsController } from './reports';

const DAY = 86_400_000;
const SYSTEM = '__system';

/** Next occurrence due for a recurring task? `last` = last generated (or template creation). */
export function recurrenceDue(recurrence: string | null, last: Date, today: string): boolean {
  const lastDay = last.toISOString().slice(0, 10);
  if (recurrence === 'daily') return lastDay < today;
  if (recurrence === 'weekly') return +dateOnly(today) - +dateOnly(lastDay) >= 7 * DAY;
  if (recurrence === 'monthly') return lastDay.slice(0, 7) < today.slice(0, 7);
  return false;
}

/** Is a scheduled report due today? Weekly = Mondays, monthly = the 1st. */
export function reportDue(schedule: string | null, lastSentAt: Date | null, today: string, weekday: number): boolean {
  if (!schedule || lastSentAt?.toISOString().slice(0, 10) === today) return false;
  if (schedule === 'daily') return true;
  if (schedule === 'weekly') return weekday === 1;
  if (schedule === 'monthly') return today.endsWith('-01');
  return false;
}

type Job = 'outbox' | 'escalation' | 'nightly';

/**
 * Background jobs without extra infrastructure: a 60s ticker in every API instance, MySQL GET_LOCK so only one
 * instance runs a job at a time, last-run bookkeeping in Setting rows. Every job is idempotent, so a crash just retries next tick.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Jobs');
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private notify: NotifyService,
    private mailer: MailerService,
    private numbering: NumberingService,
    private workflow: WorkflowService,
    private hrm: HrmController,
    private reports: ReportsController,
    private auth: AuthGuard,
  ) {}

  onModuleInit() {
    if (process.env.JOBS === 'off') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.tick(), 5_000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async tick() {
    await this.run('outbox', 60_000).catch((e) => this.log.error(e));
    await this.run('escalation', 15 * 60_000).catch((e) => this.log.error(e));
    await this.run('nightly', 0).catch((e) => this.log.error(e));
  }

  /** Runs a job under a cluster-wide lock if its interval has passed (0 = check every tick; job decides). */
  async run(name: Job, everyMs: number, force = false): Promise<unknown> {
    const key = `job:${name}`;
    const last = await this.prisma.setting.findUnique({ where: { companyId_key: { companyId: SYSTEM, key } } });
    if (!force && everyMs && last && Date.now() - Number((last.value as { at?: number }).at ?? 0) < everyMs) return 'skipped';
    return this.prisma.$transaction(async (tx) => {
      const [{ got }] = await tx.$queryRaw<{ got: number | bigint }[]>`SELECT GET_LOCK(${`erp:${key}`}, 0) AS got`;
      if (Number(got) !== 1) return 'locked';
      try {
        const result = await this[name](force);
        const value = { at: Date.now(), result } as Prisma.InputJsonValue;
        await this.prisma.setting.upsert({ where: { companyId_key: { companyId: SYSTEM, key } }, update: { value }, create: { companyId: SYSTEM, key, value } });
        return result;
      } finally {
        await tx.$queryRaw`SELECT RELEASE_LOCK(${`erp:${key}`})`;
      }
    }, { timeout: 15 * 60_000, maxWait: 5_000 });
  }

  // ─── Jobs ──────────────────────────────────────────────────

  /** Emails in-app notifications (outbox pattern: rows are the queue; failures retry up to 5 times). */
  async outbox() {
    const rows = await this.prisma.notification.findMany({ where: { emailedAt: null, emailTries: { lt: 5 }, createdAt: { gt: new Date(Date.now() - DAY) } }, take: 200, orderBy: { createdAt: 'asc' } });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } } })).map((u) => [u.id, u]));
    const web = process.env.WEB_URL ?? 'http://localhost:3000';
    let sent = 0;
    for (const n of rows) {
      const u = users.get(n.userId);
      if (!u?.notifyEmail || !u.isActive) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { emailTries: 99 } });
        continue;
      }
      if (!(await this.settings.get(n.companyId, 'smtp')).host) continue; // wait until SMTP is configured
      try {
        await this.mailer.send(n.companyId, { to: u.email, subject: n.title, html: `<p>${esc(n.title)}</p>${n.body ? `<p>${esc(n.body)}</p>` : ''}${n.link ? `<p><a href="${esc(web + n.link)}">Open</a></p>` : ''}` });
        await this.prisma.notification.update({ where: { id: n.id }, data: { emailedAt: new Date() } });
        sent++;
      } catch (e) {
        this.log.warn(`Email to ${u.email} failed: ${(e as Error).message}`);
        await this.prisma.notification.update({ where: { id: n.id }, data: { emailTries: { increment: 1 } } });
      }
    }
    return { sent, sms: await this.smsOutbox() };
  }

  /** SMS/WhatsApp via the company's webhook for users who opted in and have a phone on their employee profile. */
  async smsOutbox() {
    const rows = await this.prisma.notification.findMany({ where: { smsAt: null, createdAt: { gt: new Date(Date.now() - DAY) } }, take: 200, orderBy: { createdAt: 'asc' } });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) }, notifySms: true } })).map((u) => [u.id, u]));
    const phones = new Map((await this.prisma.employee.findMany({ where: { userId: { in: [...users.keys()] } }, select: { userId: true, phone: true } })).map((e) => [e.userId!, e.phone]));
    let sent = 0;
    for (const n of rows) {
      const phone = phones.get(n.userId);
      if (!users.has(n.userId) || !phone) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { smsAt: new Date(0) } }); // not applicable
        continue;
      }
      const cfg = await this.settings.get(n.companyId, 'sms');
      if (!cfg.webhookUrl) continue;
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ to: phone, text: n.body ? `${n.title}\n${n.body}` : n.title }), signal: AbortSignal.timeout(10_000),
      }).catch((e: Error) => ({ ok: false, status: e.message }) as const);
      if (res.ok) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { smsAt: new Date() } });
        sent++;
      } else this.log.warn(`SMS webhook failed: ${res.status}`);
    }
    return sent;
  }

  escalation() {
    return this.workflow.escalateOverdue();
  }

  /** Once per company per local day, after the configured hour. */
  async nightly(force: boolean) {
    const out: Record<string, unknown> = {};
    for (const c of await this.prisma.company.findMany({ where: { deletedAt: null } })) {
      const cfg = await this.settings.get(c.id, 'jobs');
      const now = localParts(new Date(), c.timezone);
      const key = 'job:nightly:lastDate';
      const last = await this.prisma.setting.findUnique({ where: { companyId_key: { companyId: c.id, key } } });
      if (!force && (now.minutes < cfg.nightlyHour * 60 || (last?.value as string) === now.date)) continue;
      const yesterday = new Date(+dateOnly(now.date) - DAY).toISOString().slice(0, 10);
      const r: Record<string, unknown> = {};
      const step = async (name: string, fn: () => Promise<unknown>) => {
        try { r[name] = await fn(); } catch (e) { r[name] = `error: ${(e as Error).message}`; this.log.error(`${name}: ${(e as Error).stack}`); }
      };
      if (cfg.autoProcessAttendance) await step('attendance', () => this.hrm.processDay(c.id, yesterday));
      await step('employeeStatus', () => this.hrm.syncEmployeeStatus(this.prisma, c.id));
      await step('recurringTasks', () => this.recurringTasks(c.id, now.date));
      await step('overdueTasks', () => this.overdueTasks(c.id));
      await step('expiry', () => this.expiryReminders(c.id, now.date, cfg.expiryReminderDays));
      await step('gatepass', () => this.overdueGatepasses(c.id));
      await step('advances', () => this.agedAdvances(c.id, cfg.advanceAlertDays));
      await step('lowStock', () => this.lowStock(c.id));
      await step('reports', () => this.scheduledReports(c.id, now.date, now.weekday));
      await this.prisma.setting.upsert({ where: { companyId_key: { companyId: c.id, key } }, update: { value: now.date }, create: { companyId: c.id, key, value: now.date } });
      out[c.name] = r;
    }
    return out;
  }

  private async usersWith(companyId: string, permission: string) {
    const users = await this.prisma.user.findMany({
      where: { companyId, isActive: true, deletedAt: null, roles: { some: { role: { deletedAt: null, permissions: { some: { permission: { key: permission } } } } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async recurringTasks(companyId: string, today: string) {
    const templates = await this.prisma.task.findMany({ where: { companyId, deletedAt: null, recurrence: { not: null }, parentTaskId: null } });
    let created = 0;
    for (const t of templates) {
      if (!recurrenceDue(t.recurrence, t.lastRecurredAt ?? t.createdAt, today)) continue;
      const span = t.dueDate ? +t.dueDate - +t.createdAt : 0;
      await this.prisma.$transaction(async (tx) => {
        const number = await this.numbering.next(tx, companyId, null, 'TSK', 'TSK-{YY}{MM}-{SEQ:4}');
        const copy = await tx.task.create({
          data: {
            companyId, number, title: t.title, description: t.description, assigneeId: t.assigneeId, project: t.project, priority: t.priority,
            checklist: (t.checklist as Prisma.InputJsonValue | null) ?? Prisma.JsonNull, parentTaskId: t.id, createdById: t.createdById,
            dueDate: span ? new Date(Date.now() + span) : dateOnly(today),
          },
        });
        await tx.task.update({ where: { id: t.id }, data: { lastRecurredAt: new Date() } });
        await this.notify.send(companyId, [await this.notify.employeeUser(t.assigneeId, tx)], { title: `Task: ${t.title}`, link: `/r/hrm.task/${copy.id}` }, tx);
      });
      created++;
    }
    return { created };
  }

  async overdueTasks(companyId: string) {
    const tasks = await this.prisma.task.findMany({ where: { companyId, deletedAt: null, status: { notIn: ['done'] }, dueDate: { lt: new Date() }, assigneeId: { not: null } }, take: 1000 });
    for (const t of tasks) await this.notify.send(companyId, [await this.notify.employeeUser(t.assigneeId)], { title: `Overdue task: ${t.title}`, link: `/r/hrm.task/${t.id}` });
    return { notified: tasks.length };
  }

  /** Documents (employee + vehicle), driving licenses and probation ends hitting a reminder threshold today. */
  async expiryReminders(companyId: string, today: string, thresholds: number[]) {
    const dates = thresholds.map((d) => new Date(+dateOnly(today) + d * DAY));
    const [docs, licenses, probation] = await Promise.all([
      this.prisma.documentRecord.findMany({ where: { companyId, deletedAt: null, expiryDate: { in: dates } } }),
      this.prisma.employee.findMany({ where: { companyId, deletedAt: null, licenseExpiry: { in: dates } } }),
      this.prisma.employee.findMany({ where: { companyId, deletedAt: null, status: 'active', probationEnd: { in: dates } } }),
    ]);
    const hr = await this.usersWith(companyId, 'hrm.document.update');
    const fleet = await this.usersWith(companyId, 'fleet.vehicle.update');
    const days = (d: Date) => Math.round((+d - +dateOnly(today)) / DAY);
    for (const d of docs) {
      const owner = d.entityType === 'hrm.employee' ? await this.notify.employeeUser(d.entityId) : null;
      await this.notify.send(companyId, [...(d.entityType === 'fleet.vehicle' ? fleet : hr), owner], { title: `${d.type} ${d.number ?? ''} expires in ${days(d.expiryDate!)} day(s)`, link: `/r/${d.entityType}/${d.entityId}` });
    }
    for (const e of licenses) await this.notify.send(companyId, [...fleet, e.userId], { title: `Driving license of ${e.name} expires in ${days(e.licenseExpiry!)} day(s)`, link: `/r/hrm.employee/${e.id}` });
    for (const e of probation) await this.notify.send(companyId, hr, { title: `Probation of ${e.name} ends in ${days(e.probationEnd!)} day(s)`, link: `/r/hrm.employee/${e.id}` });
    return { documents: docs.length, licenses: licenses.length, probation: probation.length };
  }

  async overdueGatepasses(companyId: string) {
    const late = await this.prisma.gatepass.findMany({ where: { companyId, deletedAt: null, status: { in: ['out', 'partially_returned'] }, expectedReturn: { lt: new Date() } } });
    const store = await this.usersWith(companyId, 'gatepass.pass.update');
    for (const g of late) await this.notify.send(companyId, [...store, g.createdById], { title: `Overdue return: ${g.number} (${g.partyName})`, link: `/r/gatepass.pass/${g.id}` });
    return { overdue: late.length };
  }

  async agedAdvances(companyId: string, days: number) {
    const aged = await this.prisma.advance.findMany({ where: { companyId, deletedAt: null, kind: 'expense', status: 'disbursed', disbursedAt: { lt: new Date(Date.now() - days * DAY) } } });
    if (!aged.length) return { aged: 0 };
    const finance = await this.usersWith(companyId, 'finance.report.view');
    await this.notify.send(companyId, finance, { title: `${aged.length} expense advance(s) unsettled for over ${days} days`, link: '/finance/reports' });
    for (const a of aged) await this.notify.send(companyId, [await this.notify.employeeUser(a.employeeId)], { title: `Please settle advance ${a.number}`, link: `/r/finance.advance/${a.id}` });
    return { aged: aged.length };
  }

  async lowStock(companyId: string) {
    const products = await this.prisma.product.findMany({ where: { companyId, deletedAt: null, isActive: true, isService: false, reorderLevel: { gt: 0 } } });
    const levels = await this.prisma.stockLevel.groupBy({ by: ['productId'], _sum: { qty: true }, where: { productId: { in: products.map((p) => p.id) } } });
    const qty = new Map(levels.map((l) => [l.productId, Number(l._sum.qty ?? 0)]));
    const low = products.filter((p) => (qty.get(p.id) ?? 0) <= Number(p.reorderLevel));
    if (low.length) await this.notify.send(companyId, await this.usersWith(companyId, 'inventory.stock.manage'), { title: `${low.length} product(s) at or below reorder level`, body: low.slice(0, 20).map((p) => p.sku).join(', '), link: '/finance/reports' });
    return { low: low.length };
  }

  /** Runs each due saved report as its owner (so their data scope applies) and emails it as Excel. */
  async scheduledReports(companyId: string, today: string, weekday: number) {
    const due = (await this.prisma.savedReport.findMany({ where: { companyId, deletedAt: null, schedule: { not: null } } })).filter((r) => reportDue(r.schedule, r.lastSentAt, today, weekday));
    let sent = 0;
    for (const r of due) {
      const to = ((r.recipients as string[] | null) ?? []).filter((x) => /@/.test(x));
      if (!to.length || !r.createdById) continue;
      const owner: AuthUser = await this.auth.load(r.createdById);
      const def = reportSchema.parse(r.definition);
      const from = r.schedule === 'monthly' ? new Date(+dateOnly(today) - 31 * DAY) : r.schedule === 'weekly' ? new Date(+dateOnly(today) - 7 * DAY) : new Date(+dateOnly(today) - DAY);
      const out = await this.reports.execute(owner, def, { from: from.toISOString().slice(0, 10), to: today, period: today.slice(0, 7) });
      const xlsx = await toXlsx(r.name, out.columns, out.rows);
      await this.mailer.send(companyId, { to, subject: `${r.name} — ${today}`, html: `<p>${esc(r.name)}: ${out.rows.length} rows attached.</p>`, attachments: [{ filename: `${r.name}-${today}.xlsx`, content: xlsx }] });
      await this.prisma.savedReport.update({ where: { id: r.id }, data: { lastSentAt: new Date() } });
      sent++;
    }
    return { sent };
  }
}

@Controller('admin/jobs')
export class JobsController {
  constructor(private jobs: JobsService, private prisma: PrismaService) {}

  @Get()
  @Permissions('core.setting.view')
  async status() {
    const rows = await this.prisma.setting.findMany({ where: { companyId: SYSTEM, key: { startsWith: 'job:' } } });
    return rows.map((r) => ({ job: r.key.slice(4), ...(r.value as object) }));
  }

  /** Run a job now (ignores its schedule), e.g. to test SMTP or re-run nightly tasks. */
  @Post(':name/run')
  @Permissions('core.setting.manage')
  run(@Param('name') name: string, @CurrentUser() _user: AuthUser) {
    if (!['outbox', 'escalation', 'nightly'].includes(name)) throw new BadRequestException('Unknown job');
    return this.jobs.run(name as Job, 0, true);
  }
}
