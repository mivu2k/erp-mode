import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { docTotals, fromMinor, toMinor } from '@erp/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HookCtx, HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { AuditService, Tx } from '../platform/audit.service';
import { decrypt, encrypt } from '../platform/crypto';
import { LedgerService } from '../platform/ledger.service';
import { NotifyService } from '../platform/notify.service';
import { NumberingService } from '../platform/numbering.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { StockService } from '../platform/stock.service';
import { assertCan, AuthUser, CurrentUser, Permissions, Public } from '../rbac/rbac';
import { FinanceController } from './finance';

export interface QuoteLine { kind: 'labor' | 'part'; refId: string; description: string; qty: number; price: number; taxRate: number; jobId?: string }

const quoteLine = z.object({ jobId: z.string().optional(), kind: z.enum(['labor', 'part']), refId: z.string().default(''), description: z.string(), qty: z.coerce.number().positive(), price: z.coerce.number().min(0), taxRate: z.coerce.number().min(0).default(0) });
const item = z.object({
  productId: z.string().max(191).optional(), productType: z.string().max(191).optional(), brand: z.string().max(191).optional(), model: z.string().max(191).optional(), serial: z.string().max(191).optional(),
  assetTag: z.string().max(191).optional(), firmwareVersion: z.string().max(191).optional(), frequencyBand: z.string().max(191).optional(), zeroized: z.boolean().optional(),
  accessories: z.array(z.string()).optional(), condition: z.record(z.unknown()).optional(), fault: z.string().min(1), password: z.string().optional(),
  warranty: z.boolean().optional(), expectedAt: z.coerce.date().optional(), warrantyDays: z.number().int().optional(),
});
const paySchema = z.object({ amount: z.coerce.number().positive(), accountId: z.string(), methodId: z.string().nullish(), idempotencyKey: z.string().max(100).optional() });

/** Splits a document's net (after discount) between labor and parts, in minor units. */
export function splitIncome(lines: QuoteLine[], discount: number) {
  const t = docTotals(lines, discount);
  const labor = docTotals(lines.filter((l) => l.kind === 'labor')).subtotal;
  const net = t.subtotal - t.discount;
  const laborNet = t.subtotal ? Math.round((labor * net) / t.subtotal) : 0;
  return { ...t, laborNet, partsNet: net - laborNet };
}

@Controller()
export class RepairController {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private stock: StockService,
    private ledger: LedgerService,
    private numbering: NumberingService,
    private settings: SettingsService,
    private notify: NotifyService,
    private audit: AuditService,
    private finance: FinanceController,
    hooks: HooksService,
  ) {
    const totals = async ({ user }: HookCtx, data: Row, before?: Row) => {
      if (data.lines === undefined && data.discount === undefined) return;
      const lines = parse(z.array(quoteLine), data.lines ?? before?.lines);
      const t = docTotals(lines, Number(data.discount ?? before?.discount ?? 0));
      Object.assign(data, { lines, subtotal: fromMinor(t.subtotal), discount: fromMinor(t.discount), tax: fromMinor(t.tax), total: fromMinor(t.total) });
      // Discounts above the limit must go through the approval workflow before sending.
      const limit = await this.settings.get(user.companyId, 'repair.discountLimit');
      data.custom = { ...((data.custom ?? before?.custom ?? {}) as Row), needsApproval: t.discount > toMinor(limit) };
    };
    hooks.on('repair.quotation', { beforeCreate: (c, d) => totals(c, d), beforeUpdate: (c, d, b) => totals(c, d, b) });
  }

  // ─── Intake ────────────────────────────────────────────────

  /** One intake, many devices: each item becomes its own job with its own number. */
  @Post('repair/intakes')
  @Permissions('repair.job.create')
  async intake(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ customerId: z.string(), notes: z.string().optional(), items: z.array(item).min(1).max(100) }), body);
    await this.prisma.customer.findFirstOrThrow({ where: { id: b.customerId, companyId: user.companyId } });
    const res = await this.prisma.$transaction(async (tx) => {
      const number = await this.numbering.next(tx, user.companyId, user.branchId, 'INT', 'INT-{YYYY}-{SEQ:5}');
      const intake = await tx.intake.create({ data: { companyId: user.companyId, branchId: user.branchId, number, customerId: b.customerId, notes: b.notes, createdById: user.id } });
      const jobs = [];
      for (const it of b.items) {
        const { password, ...rest } = it;
        if (it.serial && !rest.warranty) {
          const unit = await tx.serialItem.findUnique({ where: { companyId_serial: { companyId: user.companyId, serial: it.serial } }, select: { warrantyUntil: true } });
          if (unit?.warrantyUntil && unit.warrantyUntil >= new Date(new Date().toISOString().slice(0, 10))) rest.warranty = true;
        }
        // A product link must be one of this company's products; anything else is dropped, not trusted.
        if (rest.productId && !(await tx.product.findFirst({ where: { id: rest.productId, companyId: user.companyId }, select: { id: true } }))) delete rest.productId;
        const job = await tx.job.create({
          data: {
            ...rest, companyId: user.companyId, branchId: user.branchId, intakeId: intake.id, customerId: b.customerId, createdById: user.id,
            number: await this.numbering.next(tx, user.companyId, user.branchId, 'JOB', 'JOB-{YYYY}-{SEQ:6}'),
            passwordEnc: password ? encrypt(password) : null, accessories: rest.accessories as Prisma.InputJsonValue, condition: rest.condition as Prisma.InputJsonValue,
          },
        });
        await this.index(tx, job);
        jobs.push({ id: job.id, number: job.number, trackToken: job.trackToken });
      }
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'create', entityType: 'repair.intake', entityId: intake.id, after: { jobs: jobs.map((j) => j.number) } }, tx);
      return { intake, jobs };
    });
    const web = process.env.WEB_URL ?? 'http://localhost:3000';
    return { ...res, jobs: res.jobs.map((j) => ({ ...j, trackUrl: `${web}/track/${j.trackToken}` })) };
  }

  private async index(tx: Tx, rec: Row) {
    await tx.searchIndex.upsert({
      where: { entityType_entityId: { entityType: 'repair.job', entityId: String(rec.id) } },
      update: { title: String(rec.number), subtitle: [rec.brand, rec.model].filter(Boolean).join(' '), keywords: [rec.serial, rec.assetTag, rec.fault].filter(Boolean).join(' '), barcode: String(rec.number) },
      create: { companyId: String(rec.companyId), module: 'repair', entityType: 'repair.job', entityId: String(rec.id), title: String(rec.number), subtitle: [rec.brand, rec.model].filter(Boolean).join(' '), keywords: [rec.serial, rec.assetTag, rec.fault].filter(Boolean).join(' '), barcode: String(rec.number) },
    });
  }

  // ─── Job lifecycle ─────────────────────────────────────────

  /** A job from either screen on the shared engine (repair.job = kind repair, fleet.maintenance = kind fleet). */
  private async job(tx: Tx, user: AuthUser, id: string) {
    const kind = (await tx.job.findFirst({ where: { id, companyId: user.companyId }, select: { kind: true } }))?.kind;
    return (await this.resources.load(tx, user, kind === 'fleet' ? 'fleet.maintenance' : 'repair.job', id)) as Row & { status: string; number: string; kind: string };
  }

  private jobKey(job: { kind: string }) {
    return job.kind === 'fleet' ? 'fleet.maintenance' : 'repair.job';
  }

  async transition(tx: Tx, user: AuthUser, id: string, to: string, extra: Row = {}, note?: string) {
    const job = await this.job(tx, user, id);
    const map = await this.settings.get(user.companyId, 'repair.transitions');
    if (job.status !== to && !(map[job.status] ?? []).includes(to) && !(map['*'] ?? []).includes(to)) throw new BadRequestException(`Cannot move ${job.number} from ${job.status} to ${to}`);
    // Equipment only leaves QC with a passing bench test on record.
    if (to === 'ready' && job.kind === 'repair' && (job.testResults as { pass?: boolean } | null)?.pass !== true) throw new BadRequestException('Record a passing QC test before marking ready');
    const rec = await this.resources.setStatus(tx, user, this.jobKey(job), id, to, { ...extra, ...(to === 'closed' ? { closedAt: new Date() } : {}) });
    if (note) await tx.comment.create({ data: { companyId: user.companyId, entityType: 'repair.job', entityId: id, userId: user.id, body: note, internal: false } });
    if (job.kind === 'fleet' && ['delivered', 'closed'].includes(to) && job.vehicleId) {
      await tx.vehicle.update({ where: { id: String(job.vehicleId) }, data: { status: 'active', lastServiceAt: new Date(), ...(job.odometer ? { lastServiceKm: Number(job.odometer) } : {}) } });
    }
    return rec;
  }

  @Post('repair/jobs/:id/status')
  status(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    return this.prisma.$transaction((tx) => this.transition(tx, user, id, parse(z.string().min(1), body?.status), {}, body?.note));
  }

  @Post('repair/jobs/:id/assign')
  @Permissions('repair.job.manage')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { technicianId?: string }) {
    const technicianId = parse(z.string(), body?.technicianId);
    return this.prisma.$transaction(async (tx) => {
      const tech = await tx.employee.findFirst({ where: { id: technicianId, companyId: user.companyId } });
      if (!tech) throw new BadRequestException('Unknown technician');
      const job = await this.job(tx, user, id);
      await tx.job.update({ where: { id }, data: { technicianId } });
      if (job.status === 'received') await this.transition(tx, user, id, 'assigned');
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'assign', entityType: this.jobKey(job), entityId: id, before: { technicianId: job.technicianId }, after: { technicianId } }, tx);
      await this.notify.send(user.companyId, [tech.userId], { title: `Job ${job.number} assigned to you`, link: `/r/repair.job/${id}` }, tx);
      return { ok: true };
    });
  }

  /** Records diagnosis and drafts a new quotation version priced from inventory and service rates. */
  @Post('repair/jobs/:id/diagnose')
  diagnose(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({
      findings: z.string().min(1), estimatedMin: z.number().int().optional(),
      parts: z.array(z.object({ productId: z.string(), qty: z.coerce.number().positive() })).default([]),
      labor: z.array(z.object({ serviceId: z.string(), qty: z.coerce.number().positive().default(1) })).default([]),
    }), body);
    return this.prisma.$transaction(async (tx) => {
      const job = await this.job(tx, user, id);
      const products = await tx.product.findMany({ where: { id: { in: b.parts.map((p) => p.productId) }, companyId: user.companyId } });
      const services = await tx.masterData.findMany({ where: { id: { in: b.labor.map((l) => l.serviceId) }, companyId: user.companyId, type: 'service_rate' } });
      const taxes = new Map((await tx.masterData.findMany({ where: { companyId: user.companyId, type: 'tax' } })).map((t) => [t.id, Number((t.value as { rate?: number } | null)?.rate ?? 0)]));
      const lines: QuoteLine[] = [
        ...b.labor.map((l) => {
          const s = services.find((x) => x.id === l.serviceId);
          if (!s) throw new BadRequestException('Unknown service rate');
          return { kind: 'labor' as const, refId: s.id, description: s.name, qty: l.qty, price: Number((s.value as { rate?: number } | null)?.rate ?? 0), taxRate: 0 };
        }),
        ...b.parts.map((p) => {
          const pr = products.find((x) => x.id === p.productId);
          if (!pr) throw new BadRequestException('Unknown product');
          return { kind: 'part' as const, refId: pr.id, description: pr.name, qty: p.qty, price: Number(pr.price), taxRate: pr.taxId ? taxes.get(pr.taxId) ?? 0 : 0 };
        }),
      ];
      const stock = await tx.stockLevel.groupBy({ by: ['productId'], _sum: { qty: true }, where: { productId: { in: b.parts.map((p) => p.productId) } } });
      const availability = b.parts.map((p) => ({ productId: p.productId, need: p.qty, onHand: Number(stock.find((s) => s.productId === p.productId)?._sum.qty ?? 0) }));
      // Re-diagnosing keeps the earlier findings: they move into `history`, newest last.
      const { history = [], ...previous } = (job.diagnosis ?? {}) as { history?: unknown[] } & Record<string, unknown>;
      const diagnosis = { findings: b.findings, estimatedMin: b.estimatedMin, parts: b.parts, labor: b.labor, by: user.id, byName: user.name, at: new Date().toISOString(), history: previous.findings ? [...history, previous] : history };
      await tx.job.update({ where: { id }, data: { diagnosis: diagnosis as unknown as Prisma.InputJsonValue } });
      await tx.comment.create({ data: { companyId: user.companyId, entityType: 'repair.job', entityId: id, userId: user.id, body: `Diagnosis${previous.findings ? ' (revised)' : ''}: ${b.findings}`, internal: true } });
      await tx.quotation.updateMany({ where: { jobId: id, status: { in: ['draft', 'sent', 'approved', 'pending'] } }, data: { status: 'superseded' } });
      const version = (await tx.quotation.count({ where: { jobId: id } })) + 1;
      const t = docTotals(lines);
      const q = await tx.quotation.create({
        data: {
          companyId: user.companyId, branchId: user.branchId, jobId: id, customerId: job.customerId as string | null, version, lines: lines as unknown as Prisma.InputJsonValue, createdById: user.id,
          number: `${job.number}-Q${version}`, subtotal: fromMinor(t.subtotal), tax: fromMinor(t.tax), total: fromMinor(t.total), validUntil: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      if (['received', 'assigned', 'diagnosing'].includes(job.status)) await this.transition(tx, user, id, 'diagnosed');
      return { quotation: q, availability };
    });
  }

  /** QC bench measurements for radios/cameras/gateways; a failed test sends the job back to repair. */
  @Post('repair/jobs/:id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({
      rfPowerW: z.coerce.number().min(0).nullish(), rxSensitivity: z.string().max(50).nullish(), freqErrorHz: z.coerce.number().nullish(), vswr: z.coerce.number().min(1).nullish(),
      audioOk: z.boolean().nullish(), firmwareAfter: z.string().max(100).nullish(), pass: z.boolean(), notes: z.string().max(2000).nullish(),
    }), body);
    return this.prisma.$transaction(async (tx) => {
      const job = await this.job(tx, user, id);
      if (!['approved', 'in_repair', 'qc'].includes(job.status)) throw new BadRequestException('Tests are recorded during repair / QC');
      const testResults = { ...b, by: user.name, at: new Date().toISOString() };
      await tx.job.update({ where: { id }, data: { testResults, ...(b.firmwareAfter ? { firmwareVersion: b.firmwareAfter } : {}) } });
      await this.audit.log({ companyId: user.companyId, userId: user.id, action: b.pass ? 'qc_pass' : 'qc_fail', entityType: this.jobKey(job), entityId: id, after: testResults }, tx);
      // Statuses follow the work: a labour-only job starts repair with its test; a pass is ready for pickup, a fail goes back to repair.
      if (job.status === 'approved') await this.transition(tx, user, id, 'in_repair');
      if (b.pass) {
        if (job.status !== 'qc') await this.transition(tx, user, id, 'qc');
        await this.transition(tx, user, id, 'ready');
      } else if (job.status === 'qc') await this.transition(tx, user, id, 'in_repair', {}, `QC failed: ${b.notes ?? ''}`);
      return { pass: b.pass };
    });
  }

  @Post('repair/quotations/:id/send')
  send(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.$transaction(async (tx) => {
      const q = await this.resources.load(tx, user, 'repair.quotation', id);
      if ((q.custom as Row | null)?.needsApproval && q.status !== 'approved') throw new BadRequestException('Discount above limit: submit for approval first');
      await this.resources.setStatus(tx, user, 'repair.quotation', id, 'sent');
      for (const jobId of this.quoteJobs(q)) await this.tryTransition(tx, user, jobId, 'quotation_sent');
      return { ok: true };
    });
  }

  /** Customer accepts (reserves parts on the job) or declines. */
  @Post('repair/quotations/:id/decision')
  decision(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ accepted: z.boolean(), via: z.enum(['signature', 'link', 'phone']) }), body);
    return this.prisma.$transaction(async (tx) => {
      const q = await this.resources.load(tx, user, 'repair.quotation', id);
      if ((q.custom as Row | null)?.needsApproval && q.status !== 'approved' && b.accepted) throw new BadRequestException('Discount above limit needs approval');
      await this.resources.setStatus(tx, user, 'repair.quotation', id, b.accepted ? 'accepted' : 'declined', { decisionVia: b.via, decidedAt: new Date() });
      // A job quotation covers one unit; an intake quotation covers every unit named on its lines.
      const lines = q.lines as unknown as QuoteLine[];
      let reserved = 0;
      const skipped: string[] = [];
      for (const jobId of this.quoteJobs(q)) {
        if (!b.accepted) {
          if (!(await this.tryTransition(tx, user, jobId, 'declined'))) skipped.push(jobId);
          continue;
        }
        const parts = lines.filter((l) => l.kind === 'part' && (l.jobId ?? q.jobId) === jobId);
        await tx.jobPart.deleteMany({ where: { jobId, issuedQty: 0 } });
        await tx.jobPart.createMany({ data: parts.map((p) => ({ jobId, productId: p.refId, qty: p.qty, unitPrice: p.price })) });
        reserved += parts.length;
        if (q.intakeId) await tx.quotation.updateMany({ where: { jobId, status: { in: ['draft', 'sent', 'approved', 'pending'] } }, data: { status: 'superseded' } });
        if (!(await this.tryTransition(tx, user, jobId, 'approved'))) skipped.push(jobId);
      }
      return { ok: true, reserved, ...(skipped.length ? { unchangedJobs: skipped } : {}) };
    });
  }

  @Post('repair/jobs/:id/issue-parts')
  @Permissions('inventory.movement.create')
  issue(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ warehouseId: z.string(), serials: z.record(z.array(z.string())).optional() }), body);
    return this.prisma.$transaction(async (tx) => {
      const job = await this.job(tx, user, id);
      const parts = await tx.jobPart.findMany({ where: { jobId: id } });
      let issued = 0;
      for (const p of parts) {
        const need = Number(p.qty) - Number(p.issuedQty);
        if (need <= 0) continue;
        const serials = b.serials?.[p.id] ?? [];
        const moves = serials.length ? serials.slice(0, need).map((s) => ({ qty: 1, serial: s })) : [{ qty: need, serial: null }];
        let cost = 0;
        for (const mv of moves) cost = await this.stock.move(tx, { companyId: user.companyId, productId: p.productId, warehouseId: b.warehouseId, qty: -mv.qty, serial: mv.serial, type: 'job_issue', refType: 'repair.job', refId: id, userId: user.id, serialStatus: 'issued' });
        const qty = moves.reduce((s, m) => s + m.qty, 0);
        await tx.jobPart.update({ where: { id: p.id }, data: { issuedQty: { increment: qty }, unitCost: cost, serial: serials[0] ?? p.serial } });
        issued += qty;
      }
      if (['approved', 'parts_pending'].includes(job.status)) await this.transition(tx, user, id, 'in_repair');
      return { issued };
    });
  }

  @Post('repair/jobs/:id/return-parts')
  @Permissions('inventory.movement.create')
  returnParts(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ warehouseId: z.string(), lines: z.array(z.object({ partId: z.string(), qty: z.coerce.number().positive() })).optional() }), body);
    return this.prisma.$transaction(async (tx) => {
      await this.job(tx, user, id);
      const parts = await tx.jobPart.findMany({ where: { jobId: id } });
      let returned = 0;
      for (const p of parts) {
        const out = Number(p.issuedQty) - Number(p.returnedQty);
        const qty = b.lines ? b.lines.find((l) => l.partId === p.id)?.qty ?? 0 : out;
        if (qty <= 0) continue;
        if (qty > out) throw new BadRequestException('Returning more than issued');
        await this.stock.move(tx, { companyId: user.companyId, productId: p.productId, warehouseId: b.warehouseId, qty, unitCost: Number(p.unitCost), serial: p.serial, type: 'job_return', refType: 'repair.job', refId: id, userId: user.id });
        await tx.jobPart.update({ where: { id: p.id }, data: { returnedQty: { increment: qty } } });
        returned += qty;
      }
      return { returned };
    });
  }

  /**
   * Invoice from the accepted quotation (or explicit lines, e.g. inspection fee only).
   * Dr Receivable / Cr labor income, parts income, sales tax; Dr COGS / Cr Inventory for consumed parts.
   */
  @Post('repair/jobs/:id/invoice')
  @Permissions('repair.invoice.create')
  invoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ lines: z.array(quoteLine).optional(), discount: z.coerce.number().min(0).optional() }).default({}), body ?? {});
    return this.prisma.$transaction(async (tx) => {
      const job = await this.job(tx, user, id);
      if (!job.customerId) throw new BadRequestException('Job has no customer');
      if ((await this.invoicedJobs(tx, user.companyId, [id])).size) throw new BadRequestException('Job is already invoiced');
      const q = b.lines ? null : await tx.quotation.findFirst({ where: { jobId: id, status: 'accepted' }, orderBy: { version: 'desc' } });
      const lines = b.lines ?? (q?.lines as unknown as QuoteLine[] | undefined);
      if (!lines?.length) throw new BadRequestException('No accepted quotation — pass lines (e.g. inspection fee)');
      return this.createInvoice(tx, user, { customerId: String(job.customerId), jobId: id, quotationId: q?.id, lines, discount: b.discount ?? Number(q?.discount ?? 0), cogsFromJobs: [id] });
    });
  }

  async createInvoice(tx: Tx, user: AuthUser, p: { customerId: string; jobId?: string; intakeId?: string; quotationId?: string; lines: QuoteLine[]; discount: number; cogsFromJobs?: string[]; cogsValue?: number }) {
    const s = splitIncome(p.lines, p.discount);
    const acc = await this.ledger.accounts(user.companyId);
    const number = await this.numbering.next(tx, user.companyId, user.branchId, 'INV', 'INV-{BR}-{YY}{MM}-{SEQ:4}');
    let cogs = p.cogsValue ?? 0;
    if (p.cogsFromJobs?.length) {
      const parts = await tx.jobPart.findMany({ where: { jobId: { in: p.cogsFromJobs } } });
      cogs = parts.reduce((sum, x) => sum + Math.round((Number(x.issuedQty) - Number(x.returnedQty)) * toMinor(x.unitCost)), 0);
    }
    const je = await this.ledger.post(tx, {
      companyId: user.companyId, branchId: user.branchId, memo: `Invoice ${number}`, sourceType: 'repair.invoice', userId: user.id,
      lines: [
        { accountId: acc.receivable, debit: fromMinor(s.total), partyType: 'customer', partyId: p.customerId },
        { accountId: acc.laborIncome, credit: fromMinor(s.laborNet) },
        { accountId: acc.partsIncome, credit: fromMinor(s.partsNet) },
        { accountId: acc.salesTax, credit: fromMinor(s.tax) },
        { accountId: acc.cogs, debit: fromMinor(cogs) },
        { accountId: acc.inventory, credit: fromMinor(cogs) },
      ],
    });
    const inv = await tx.invoice.create({
      data: {
        companyId: user.companyId, branchId: user.branchId, number, customerId: p.customerId, jobId: p.jobId, intakeId: p.intakeId, quotationId: p.quotationId, date: new Date(),
        lines: p.lines as unknown as Prisma.InputJsonValue, subtotal: fromMinor(s.subtotal), discount: fromMinor(s.discount), tax: fromMinor(s.tax), total: fromMinor(s.total), journalId: je.id, createdById: user.id,
      },
    });
    await tx.searchIndex.create({ data: { companyId: user.companyId, module: 'repair', entityType: 'repair.invoice', entityId: inv.id, title: number, barcode: number } });
    return inv;
  }

  @Post('repair/invoices/:id/pay')
  @Permissions('finance.payment.create')
  pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(paySchema, body);
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.resources.load(tx, user, 'repair.invoice', id, 'view');
      const due = toMinor(inv.total as string) - toMinor(inv.paid as string) - toMinor(inv.credited as string);
      if (toMinor(b.amount) > due) throw new BadRequestException(`Only ${fromMinor(due)} is due`);
      const acc = await this.ledger.accounts(user.companyId);
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Receipt ${inv.number}`, sourceType: 'repair.invoice', sourceId: id, userId: user.id,
        lines: [{ accountId: b.accountId, debit: b.amount }, { accountId: acc.receivable, credit: b.amount, partyType: 'customer', partyId: String(inv.customerId) }],
      });
      await this.finance.payment(tx, user, { direction: 'in', partyType: 'customer', partyId: String(inv.customerId), refType: 'repair.invoice', refId: id, amount: b.amount, accountId: b.accountId, methodId: b.methodId, journalId: je.id, idempotencyKey: b.idempotencyKey });
      const paid = toMinor(inv.paid as string) + toMinor(b.amount);
      const status = paid + toMinor(inv.credited as string) >= toMinor(inv.total as string) ? 'paid' : 'partially_paid';
      await tx.invoice.update({ where: { id }, data: { paid: fromMinor(paid), status } });
      if (status === 'paid') await this.closeSettled(tx, user, inv.jobId ? [String(inv.jobId)] : (await tx.job.findMany({ where: { intakeId: String(inv.intakeId ?? ''), companyId: user.companyId }, select: { id: true } })).map((j) => j.id));
      return { paid: fromMinor(paid), status };
    });
  }

  // ─── Intake-level documents (all units of one intake together) ───

  /** Jobs a quotation covers: its own job, or every job named on an intake quotation's lines. */
  private quoteJobs(q: Row): string[] {
    if (q.jobId) return [String(q.jobId)];
    return [...new Set((q.lines as unknown as QuoteLine[]).map((l) => l.jobId).filter((x): x is string => !!x))];
  }

  /** A delivered job with nothing left to collect (every invoice for it paid, or none raised) closes itself. */
  private async closeSettled(tx: Tx, user: AuthUser, jobIds: string[]) {
    for (const j of await tx.job.findMany({ where: { id: { in: jobIds }, companyId: user.companyId, status: 'delivered' } })) {
      const open = await tx.invoice.count({ where: { companyId: user.companyId, status: { not: 'paid' }, deletedAt: null, OR: [{ jobId: j.id }, ...(j.intakeId ? [{ intakeId: j.intakeId }] : [])] } });
      if (!open) await this.transition(tx, user, j.id, 'closed');
    }
  }

  /** Moves a job if the configured transitions allow it; returns false instead of failing the whole batch. */
  private async tryTransition(tx: Tx, user: AuthUser, jobId: string, to: string) {
    try {
      await this.transition(tx, user, jobId, to);
      return true;
    } catch (e) {
      if (e instanceof BadRequestException) return false;
      throw e;
    }
  }

  /** Jobs already billed, alone or as a line of an intake invoice (never bill a unit twice). */
  // ponytail: scans the company's intake invoices in memory; add an InvoiceJob link table if intake invoices reach tens of thousands
  async invoicedJobs(tx: Tx, companyId: string, jobIds: string[]): Promise<Set<string>> {
    const invoices = await tx.invoice.findMany({
      where: { companyId, deletedAt: null, status: { not: 'cancelled' }, OR: [{ jobId: { in: jobIds } }, { intakeId: { not: null } }] },
      select: { jobId: true, lines: true, intakeId: true },
    });
    const out = new Set<string>();
    for (const inv of invoices) {
      if (inv.jobId && jobIds.includes(inv.jobId)) out.add(inv.jobId);
      for (const l of (inv.lines as unknown as QuoteLine[]) ?? []) if (l.jobId && jobIds.includes(l.jobId)) out.add(l.jobId);
    }
    return out;
  }

  private async intakeJobs(tx: Tx, user: AuthUser, intakeId: string) {
    const intake = await this.resources.load(tx, user, 'repair.intake', intakeId, 'view');
    const jobs = await tx.job.findMany({ where: { intakeId, companyId: user.companyId, kind: 'repair', deletedAt: null }, orderBy: { number: 'asc' } });
    if (!jobs.length) throw new BadRequestException('This intake has no units');
    return { intake, jobs };
  }

  /**
   * One quotation for every unit of an intake: each unit's current quote lines (from diagnosis), tagged with its job
   * number; units not yet diagnosed get a zero-price line to fill in. Replaces the previous open intake quotation.
   */
  @Post('repair/intakes/:id/quotation')
  @Permissions('repair.quotation.create')
  intakeQuotation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.$transaction(async (tx) => {
      const { intake, jobs } = await this.intakeJobs(tx, user, id);
      const lines: QuoteLine[] = [];
      for (const j of jobs) {
        const q = await tx.quotation.findFirst({ where: { jobId: j.id, status: { notIn: ['superseded', 'declined'] } }, orderBy: { version: 'desc' } });
        const own = (q?.lines as unknown as QuoteLine[] | undefined) ?? [];
        if (own.length) lines.push(...own.map((l) => ({ ...l, jobId: j.id, description: `${j.number}: ${l.description}` })));
        else lines.push({ jobId: j.id, kind: 'labor', refId: '', description: `${j.number}: ${[j.productType, j.brand, j.model].filter(Boolean).join(' ')} — ${j.fault ?? 'service'}`, qty: 1, price: 0, taxRate: 0 });
      }
      await tx.quotation.updateMany({ where: { intakeId: id, status: { in: ['draft', 'sent', 'approved', 'pending'] } }, data: { status: 'superseded' } });
      const version = (await tx.quotation.count({ where: { intakeId: id } })) + 1;
      const t = docTotals(lines);
      const q = await tx.quotation.create({
        data: {
          companyId: user.companyId, branchId: user.branchId, intakeId: id, customerId: String(intake.customerId), version, number: `${intake.number}-Q${version}`,
          lines: lines as unknown as Prisma.InputJsonValue, subtotal: fromMinor(t.subtotal), tax: fromMinor(t.tax), total: fromMinor(t.total),
          validUntil: new Date(Date.now() + 7 * 86_400_000), createdById: user.id,
        },
      });
      return { id: q.id, number: q.number, units: jobs.length, total: fromMinor(t.total) };
    });
  }

  /**
   * One invoice for every accepted, not-yet-invoiced unit of an intake: lines from the accepted intake quotation,
   * or each unit's own accepted quotation. Cost of parts consumed by all included units is posted to COGS.
   */
  /** Invoice straight from an accepted quotation: its job's invoice, or the whole intake's. */
  @Post('repair/quotations/:id/invoice')
  @Permissions('repair.invoice.create')
  async quoteInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const q = await this.prisma.$transaction((tx) => this.resources.load(tx, user, 'repair.quotation', id, 'view'));
    if (q.status !== 'accepted') throw new BadRequestException('Only an accepted quotation can be invoiced');
    if (q.jobId) return this.invoice(user, String(q.jobId), {});
    if (q.intakeId) return this.intakeInvoice(user, String(q.intakeId));
    throw new BadRequestException('Quotation is not linked to a job or intake');
  }

  @Post('repair/intakes/:id/invoice')
  @Permissions('repair.invoice.create')
  intakeInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.$transaction(async (tx) => {
      const { intake, jobs } = await this.intakeJobs(tx, user, id);
      const billed = await this.invoicedJobs(tx, user.companyId, jobs.map((j) => j.id));
      // Only units whose work has progressed are billed; untouched units wait for their own quote/work.
      const billable = ['in_repair', 'qc', 'ready', 'delivered', 'closed', 'returned_unrepaired', 'not_repairable'];
      const open = jobs.filter((j) => !billed.has(j.id) && billable.includes(j.status));
      if (!open.length) throw new BadRequestException('No unit of this intake is ready to invoice (or all are already invoiced)');
      const intakeQuote = await tx.quotation.findFirst({ where: { intakeId: id, status: 'accepted' }, orderBy: { version: 'desc' } });
      const iq = (intakeQuote?.lines as unknown as QuoteLine[] | undefined) ?? [];
      const lines: QuoteLine[] = [];
      const covered: string[] = [];
      for (const j of open) {
        let own = iq.filter((l) => l.jobId === j.id);
        if (!own.length) {
          const q = await tx.quotation.findFirst({ where: { jobId: j.id, status: 'accepted' }, orderBy: { version: 'desc' } });
          own = ((q?.lines as unknown as QuoteLine[] | undefined) ?? []).map((l) => ({ ...l, jobId: j.id, description: `${j.number}: ${l.description}` }));
        }
        if (own.length) { lines.push(...own); covered.push(j.id); }
      }
      if (!lines.length) throw new BadRequestException('No accepted quotation for any open unit — accept a quotation first');
      // ponytail: the intake quote's discount applies only when the invoice carries all of its lines; partial invoices get none
      const fullQuote = intakeQuote && iq.every((l) => !l.jobId || covered.includes(l.jobId));
      return {
        ...(await this.createInvoice(tx, user, { customerId: String(intake.customerId), intakeId: id, quotationId: intakeQuote?.id, lines, discount: fullQuote ? Number(intakeQuote!.discount) : 0, cogsFromJobs: covered })),
        units: covered.length, skipped: open.length - covered.length,
      };
    });
  }

  /** One delivery order for every unit of the intake that is ready to go back (repaired, declined or unrepairable). */
  @Post('repair/intakes/:id/deliver')
  @Permissions('repair.delivery.create')
  intakeDeliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { receivedBy?: string; signature?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const { intake, jobs } = await this.intakeJobs(tx, user, id);
      const ready = jobs.filter((j) => ['ready', 'returned_unrepaired', 'not_repairable', 'declined'].includes(j.status));
      if (!ready.length) throw new BadRequestException('No unit of this intake is ready for delivery');
      const number = await this.numbering.next(tx, user.companyId, user.branchId, 'DO', 'DO-{YYYY}-{SEQ:5}');
      const d = await tx.deliveryOrder.create({
        data: { companyId: user.companyId, branchId: user.branchId, number, customerId: String(intake.customerId), intakeId: id, jobIds: ready.map((j) => j.id), receivedBy: body?.receivedBy, signature: body?.signature, createdById: user.id },
      });
      for (const j of ready) await this.transition(tx, user, j.id, 'delivered', { deliveredAt: new Date() });
      await this.closeSettled(tx, user, ready.map((j) => j.id));
      return { ...d, units: ready.length, waiting: jobs.length - ready.length };
    });
  }

  @Post('repair/jobs/:id/deliver')
  deliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { receivedBy?: string; signature?: string; checklist?: unknown }) {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.job(tx, user, id);
      const number = await this.numbering.next(tx, user.companyId, user.branchId, 'DO', 'DO-{YYYY}-{SEQ:5}');
      const d = await tx.deliveryOrder.create({
        data: { companyId: user.companyId, branchId: user.branchId, number, customerId: String(job.customerId ?? ''), jobIds: [id], receivedBy: body?.receivedBy, signature: body?.signature, checklist: body?.checklist as Prisma.InputJsonValue, createdById: user.id },
      });
      await this.transition(tx, user, id, 'delivered', { deliveredAt: new Date() });
      await this.closeSettled(tx, user, [id]);
      return d;
    });
  }

  @Post('repair/jobs/:id/comeback')
  @Permissions('repair.job.create')
  comeback(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { fault?: string }) {
    const fault = parse(z.string().min(1), body?.fault);
    return this.prisma.$transaction(async (tx) => {
      const j = await this.job(tx, user, id);
      const inWarranty = !!j.deliveredAt && Date.now() - +(j.deliveredAt as Date) <= Number(j.warrantyDays) * 86_400_000;
      const job = await tx.job.create({
        data: {
          companyId: user.companyId, branchId: user.branchId, kind: String(j.kind), customerId: j.customerId as string | null, vehicleId: j.vehicleId as string | null,
          productType: j.productType as string | null, brand: j.brand as string | null, model: j.model as string | null, serial: j.serial as string | null,
          fault, parentJobId: id, warranty: inWarranty, createdById: user.id, number: await this.numbering.next(tx, user.companyId, user.branchId, 'JOB', 'JOB-{YYYY}-{SEQ:6}'),
        },
      });
      await this.index(tx, job);
      return { id: job.id, number: job.number, warranty: inWarranty };
    });
  }

  /** Restricted: decrypts the customer's device password, audit-logged. */
  @Post('repair/jobs/:id/password')
  @Permissions('repair.job.manage')
  async password(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const job = await this.prisma.job.findFirst({ where: { id, companyId: user.companyId } });
    if (!job) throw new NotFoundException();
    await this.audit.log({ companyId: user.companyId, userId: user.id, action: 'reveal_password', entityType: 'repair.job', entityId: id });
    return { password: job.passwordEnc ? decrypt(job.passwordEnc) : null };
  }

  /** Approved credit note → Dr sales returns / Cr cash (refund) or receivable (credit). */
  @Post('repair/creditnotes/:id/post')
  @Permissions('repair.creditnote.approve')
  postCredit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { accountId?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const cn = await this.resources.load(tx, user, 'repair.creditnote', id, 'approve');
      if (cn.status !== 'approved') throw new BadRequestException('Credit note must be approved');
      const inv = await tx.invoice.findFirstOrThrow({ where: { id: String(cn.invoiceId), companyId: user.companyId } });
      const amount = Number(cn.amount);
      if (toMinor(amount) > toMinor(inv.total) - toMinor(inv.credited)) throw new BadRequestException('Credit exceeds invoice');
      const acc = await this.ledger.accounts(user.companyId);
      const cash = cn.refundCash && body?.accountId;
      if (cn.refundCash && !body?.accountId) throw new BadRequestException('Pick the cash/bank account to refund from');
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Credit note ${cn.number}`, sourceType: 'repair.creditnote', sourceId: id, userId: user.id,
        lines: [{ accountId: acc.salesReturns, debit: amount }, cash ? { accountId: body.accountId!, credit: amount } : { accountId: acc.receivable, credit: amount, partyType: 'customer', partyId: inv.customerId }],
      });
      if (cash) await this.finance.payment(tx, user, { direction: 'out', partyType: 'customer', partyId: inv.customerId, refType: 'repair.creditnote', refId: id, amount, accountId: body.accountId!, journalId: je.id });
      const credited = toMinor(inv.credited) + toMinor(amount);
      await tx.invoice.update({ where: { id: inv.id }, data: { credited: fromMinor(credited), status: credited >= toMinor(inv.total) ? 'refunded' : inv.status } });
      await this.resources.setStatus(tx, user, 'repair.creditnote', id, 'posted');
      return { journal: je.number };
    });
  }

  // ─── Public tracking & dashboard ───────────────────────────

  @Public()
  @Get('public/track/:token')
  async track(@Param('token') token: string) {
    const j = await this.prisma.job.findUnique({ where: { trackToken: token }, select: { number: true, status: true, brand: true, model: true, expectedAt: true, updatedAt: true, deletedAt: true, companyId: true } });
    if (!j || j.deletedAt) throw new NotFoundException();
    const company = await this.prisma.company.findUnique({ where: { id: j.companyId }, select: { name: true, phone: true } });
    const { deletedAt: _d, companyId: _c, ...pub } = j;
    return { ...pub, company };
  }

  /**
   * Pick-lists for the intake form, readable by anyone who takes equipment in (technicians can't browse master data):
   * equipment types / accessories / common faults, plus every make and make+model already seen on jobs.
   */
  /**
   * Intake: a serial / asset tag seen before fills the unit's details — from its latest repair job first, then the
   * serial register and its inventory product. Only what the form needs (no history, no other customers' data beyond the owner).
   */
  @Get('repair/intake-lookup')
  @Permissions('repair.job.create')
  async intakeLookup(@CurrentUser() user: AuthUser, @Query('serial') raw = '') {
    const code = raw.trim();
    if (!code) throw new BadRequestException('Serial required');
    const c = user.companyId;
    const [job, repairs, item] = await Promise.all([
      this.prisma.job.findFirst({ where: { companyId: c, deletedAt: null, OR: [{ serial: code }, { assetTag: code }] }, orderBy: { createdAt: 'desc' } }),
      this.prisma.job.count({ where: { companyId: c, deletedAt: null, OR: [{ serial: code }, { assetTag: code }] } }),
      this.prisma.serialItem.findUnique({ where: { companyId_serial: { companyId: c, serial: code } } }),
    ]);
    // Not a known unit? It may be a product barcode (main or extra): that names the item, not the unit.
    const byBarcode = !job && !item ? (await this.prisma.product.findMany({ where: { companyId: c, deletedAt: null, OR: [{ barcode: code }, { barcodes: { contains: code } }] }, select: { id: true, name: true, brand: true, model: true, barcode: true, barcodes: true }, take: 5 }))
      .find((p) => p.barcode === code || (p.barcodes ?? '').split(/[\s,;]+/).includes(code)) : undefined;
    if (byBarcode) return { found: true, kind: 'product', repairs: await this.prisma.job.count({ where: { companyId: c, productId: byBarcode.id, deletedAt: null } }), unit: { productId: byBarcode.id, productType: byBarcode.name, brand: byBarcode.brand, model: byBarcode.model, accessories: [] }, label: byBarcode.name, customer: null, warrantyUntil: null };
    const productId = job?.productId ?? item?.productId ?? null;
    const product = productId ? await this.prisma.product.findFirst({ where: { id: productId, companyId: c }, select: { name: true, brand: true, model: true } }) : null;
    if (!job && !item) return { found: false };
    const pick = (...v: (string | null | undefined)[]) => v.find((x) => x && String(x).trim()) ?? null;
    const customerId = job?.customerId ?? item?.customerId ?? null;
    const customer = customerId ? await this.prisma.customer.findFirst({ where: { id: customerId, companyId: c }, select: { id: true, name: true } }) : null;
    return {
      found: true, repairs,
      unit: {
        productId, productType: pick(job?.productType, item?.itemName), brand: pick(job?.brand, item?.brand, product?.brand), model: pick(job?.model, item?.model, product?.model),
        serial: pick(job?.serial, item?.serial), assetTag: pick(job?.assetTag), frequencyBand: pick(job?.frequencyBand), firmwareVersion: pick(job?.firmwareVersion),
        accessories: Array.isArray(job?.accessories) ? job!.accessories : [],
      },
      label: pick(product?.name, item?.itemName, [job?.brand, job?.model].filter(Boolean).join(' ')),
      customer, warrantyUntil: item?.warrantyUntil ?? null,
    };
  }

  @Get('repair/intake-options')
  @Permissions('repair.job.create')
  async intakeOptions(@CurrentUser() user: AuthUser) {
    const md = await this.prisma.masterData.findMany({ where: { companyId: user.companyId, isActive: true, type: { in: ['equipment_type', 'accessory', 'fault'] } }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, type: true, name: true } });
    const [jobSeen, stocked] = await Promise.all([
      this.prisma.job.groupBy({ by: ['brand', 'model'], where: { companyId: user.companyId, deletedAt: null, brand: { not: null } }, _count: true, orderBy: { _count: { brand: 'desc' } }, take: 2000 }),
      // Inventory products' makes/models too, so a first-time unit of a stocked model is a pick, not retyping.
      this.prisma.product.groupBy({ by: ['brand', 'model'], where: { companyId: user.companyId, deletedAt: null, brand: { not: null } }, orderBy: { brand: 'asc' }, take: 2000 }),
    ]);
    const seen: { brand: string | null; model: string | null }[] = [...jobSeen, ...stocked];
    const of = (t: string) => md.filter((m) => m.type === t).map(({ id, name }) => ({ id, name }));
    return {
      equipment_type: of('equipment_type'), accessory: of('accessory'), fault: of('fault'),
      makes: [...new Set(seen.map((x) => String(x.brand).trim()).filter(Boolean))],
      models: seen.filter((x) => x.model).map((x) => ({ make: String(x.brand).trim(), model: String(x.model).trim() })),
    };
  }

  @Get('repair/dashboard')
  async dashboard(@CurrentUser() user: AuthUser, @Query('days') daysQ = '30') {
    assertCan(user, 'repair.dashboard.view');
    const c = user.companyId;
    const since = new Date(Date.now() - Number(daysQ) * 86_400_000);
    const base = { companyId: c, deletedAt: null, kind: 'repair' };
    const [byStatus, workload, overdue, delivered, invoices, faults, comebacks] = await Promise.all([
      this.prisma.job.groupBy({ by: ['status'], _count: true, where: { ...base, status: { notIn: ['delivered', 'closed'] } } }),
      this.prisma.job.groupBy({ by: ['technicianId'], _count: true, where: { ...base, status: { notIn: ['delivered', 'closed'] } } }),
      this.prisma.job.count({ where: { ...base, expectedAt: { lt: new Date() }, status: { notIn: ['delivered', 'closed', 'ready'] } } }),
      this.prisma.job.findMany({ where: { ...base, deliveredAt: { gte: since } }, select: { createdAt: true, deliveredAt: true } }),
      this.prisma.invoice.findMany({ where: { companyId: c, deletedAt: null, date: { gte: since } }, select: { lines: true, discount: true } }),
      this.prisma.job.groupBy({ by: ['fault'], _count: true, where: { ...base, createdAt: { gte: since } }, orderBy: { _count: { fault: 'desc' } }, take: 10 }),
      this.prisma.job.count({ where: { ...base, parentJobId: { not: null }, createdAt: { gte: since } } }),
    ]);
    let labor = 0;
    let parts = 0;
    for (const inv of invoices) {
      const s = splitIncome(inv.lines as unknown as QuoteLine[], Number(inv.discount));
      labor += s.laborNet;
      parts += s.partsNet;
    }
    const techs = new Map((await this.prisma.employee.findMany({ where: { id: { in: workload.map((w) => w.technicianId).filter((x): x is string => !!x) } } })).map((e) => [e.id, e.name]));
    const tat = delivered.length ? delivered.reduce((s, j) => s + (+j.deliveredAt! - +j.createdAt), 0) / delivered.length / 3_600_000 : 0;
    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      workload: workload.map((w) => ({ technician: w.technicianId ? techs.get(w.technicianId) : 'Unassigned', open: w._count })),
      overdue, avgTurnaroundHours: Math.round(tat * 10) / 10,
      revenue: { labor: fromMinor(labor), parts: fromMinor(parts) },
      topFaults: faults.map((f) => ({ fault: f.fault, count: f._count })),
      comebackRate: delivered.length ? Math.round((1000 * comebacks) / delivered.length) / 10 : 0,
    };
  }
}
