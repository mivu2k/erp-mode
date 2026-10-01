import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { fromMinor, toMinor } from '@erp/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { sendReport } from '../engine/export';
import { HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { NumberingService } from '../platform/numbering.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { StockService } from '../platform/stock.service';
import { assertCan, AuthUser, CurrentUser, Permissions } from '../rbac/rbac';
import { RepairController } from './repair';
import { SerialsController, warrantyEnd } from './serials';

const dayMs = 86_400_000;

@Controller()
export class FleetGatepassController {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private numbering: NumberingService,
    private settings: SettingsService,
    private stock: StockService,
    private repair: RepairController,
    private serials: SerialsController,
    hooks: HooksService,
  ) {
    const bumpOdometer = async (tx: Parameters<NonNullable<Parameters<HooksService['on']>[1]['afterCreate']>>[0]['tx'], vehicleId: unknown, km: unknown) => {
      if (typeof km === 'number' && km > 0) await tx.vehicle.updateMany({ where: { id: String(vehicleId), odometer: { lt: km } }, data: { odometer: km } });
    };
    hooks.on('fleet.trip', {
      afterCreate: ({ tx }, r) => bumpOdometer(tx, r.vehicleId, r.endOdo ?? r.startOdo),
      afterUpdate: ({ tx }, r) => bumpOdometer(tx, r.vehicleId, r.endOdo),
    });
    // Fuel paid by an employee out of pocket becomes a draft expense claim linked to the vehicle.
    hooks.on('fleet.fuel', {
      afterCreate: async ({ tx, user }, r) => {
        await bumpOdometer(tx, r.vehicleId, r.odometer);
        if (!r.paidById) return;
        const headId = await this.settings.get(user.companyId, 'fleet.fuelHeadId');
        if (!headId) throw new BadRequestException('Set Settings › fleet.fuelHeadId (fuel expense head) to auto-create claims');
        const emp = await tx.employee.findFirstOrThrow({ where: { id: String(r.paidById), companyId: user.companyId } });
        const claim = await tx.expenseClaim.create({
          data: {
            companyId: user.companyId, branchId: emp.branchId, departmentId: emp.departmentId, employeeId: emp.id, mode: 'direct', date: r.date as Date, total: r.cost as string, createdById: user.id,
            number: await this.numbering.next(tx, user.companyId, emp.branchId, 'EXP', 'EXP-{YYYY}-{SEQ:5}'),
            lines: { create: { date: r.date as Date, headId, description: `Fuel ${r.liters}L @ ${r.station ?? ''}`, amount: r.cost as string, vehicleId: String(r.vehicleId), attachmentId: r.receiptId as string | null } },
          },
        });
        await tx.fuelLog.update({ where: { id: String(r.id) }, data: { claimId: claim.id } });
      },
    });
    const lines = z.array(z.object({ productId: z.string().nullish(), serial: z.string().nullish(), description: z.string().nullish(), qty: z.coerce.number().positive() })).min(1);
    hooks.on('gatepass.pass', {
      beforeCreate: (_c, d) => {
        parse(lines, d.lines);
        if (['demo_out', 'outward_returnable', 'repair_out'].includes(String(d.type)) && !d.expectedReturn) throw new BadRequestException('Expected return date is required');
        if (['demo_out', 'transfer', 'repair_out'].includes(String(d.type)) && !d.fromWarehouseId) throw new BadRequestException('Source warehouse is required');
      },
    });
  }

  // ─── Fleet ─────────────────────────────────────────────────

  /** Maintenance uses the repair job engine (kind=fleet): numbering, diagnosis, parts, labor, vendor workshop. */
  @Post('fleet/vehicles/:id/maintenance')
  @Permissions('fleet.maintenance.create')
  maintenance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { fault?: string; vendorId?: string }) {
    const fault = parse(z.string().min(1), body?.fault);
    return this.prisma.$transaction(async (tx) => {
      const v = await this.resources.load(tx, user, 'fleet.vehicle', id, 'view');
      const job = await tx.job.create({
        data: {
          companyId: user.companyId, branchId: (v.branchId as string | null) ?? user.branchId, kind: 'fleet', vehicleId: id, fault, vendorId: body?.vendorId, odometer: Number(v.odometer),
          brand: v.make as string | null, model: v.model as string | null, serial: String(v.plate), productType: 'vehicle', createdById: user.id,
          number: await this.numbering.next(tx, user.companyId, user.branchId, 'MNT', 'MNT-{YYYY}-{SEQ:5}'),
        },
      });
      await tx.vehicle.update({ where: { id }, data: { status: 'in_maintenance' } });
      await tx.searchIndex.create({ data: { companyId: user.companyId, module: 'fleet', entityType: 'fleet.maintenance', entityId: job.id, title: String(job.number), subtitle: String(v.plate), keywords: fault, barcode: job.number } });
      return { id: job.id, number: job.number };
    });
  }

  /** Total cost of ownership and cost per km. */
  @Get('fleet/vehicles/:id/cost')
  async cost(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response) {
    const v = await this.resources.get(user, 'fleet.vehicle', id);
    const [fuel, events, jobs, firstFuel] = await Promise.all([
      this.prisma.fuelLog.aggregate({ _sum: { cost: true, liters: true }, where: { vehicleId: id, deletedAt: null } }),
      this.prisma.vehicleEvent.groupBy({ by: ['type'], _sum: { amount: true }, where: { vehicleId: id, deletedAt: null } }),
      this.prisma.job.findMany({ where: { vehicleId: id, deletedAt: null }, include: { parts: true } }),
      this.prisma.fuelLog.findFirst({ where: { vehicleId: id, deletedAt: null }, orderBy: { odometer: 'asc' } }),
    ]);
    const invoices = await this.prisma.invoice.aggregate({ _sum: { total: true }, where: { jobId: { in: jobs.map((j) => j.id) }, deletedAt: null } });
    const parts = jobs.flatMap((j) => j.parts).reduce((s, p) => s + Math.round((Number(p.issuedQty) - Number(p.returnedQty)) * toMinor(p.unitCost)), 0);
    const rows: Row[] = [
      { item: 'Fuel', amount: Number(fuel._sum.cost ?? 0) },
      ...events.map((e) => ({ item: e.type, amount: Number(e._sum.amount ?? 0) })),
      { item: 'Maintenance parts', amount: fromMinor(parts) },
      { item: 'Workshop invoices', amount: Number(invoices._sum.total ?? 0) },
    ];
    const total = rows.reduce((s, r) => s + toMinor(r.amount as number), 0);
    const km = Number(v.odometer) - (firstFuel?.odometer ?? Number(v.odometer));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, {
      title: `Cost of ownership — ${v.plate}`, company, columns: ['item', 'amount'], rows,
      totals: [['Total', fromMinor(total)], ['Km tracked', km], ['Cost / km', km > 0 ? fromMinor(Math.round(total / km)) : '—'], ['Km / litre', Number(fuel._sum.liters) > 0 ? Math.round((km / Number(fuel._sum.liters)) * 10) / 10 : '—']],
    });
  }

  @Get('fleet/dashboard')
  async fleetDashboard(@CurrentUser() user: AuthUser) {
    assertCan(user, 'fleet.dashboard.view');
    const c = user.companyId;
    const soon = new Date(Date.now() + 30 * dayMs);
    const vehicles = await this.prisma.vehicle.findMany({ where: { companyId: c, deletedAt: null, status: { not: 'sold' } } });
    const dueService = vehicles.filter((v) =>
      (v.serviceEveryKm && v.odometer - (v.lastServiceKm ?? 0) >= v.serviceEveryKm) ||
      (v.serviceEveryDays && (!v.lastServiceAt || Date.now() - +v.lastServiceAt >= v.serviceEveryDays * dayMs)),
    ).map((v) => ({ id: v.id, plate: v.plate, odometer: v.odometer, lastServiceKm: v.lastServiceKm, lastServiceAt: v.lastServiceAt }));
    const [docs, licenses, fuel] = await Promise.all([
      this.prisma.documentRecord.findMany({ where: { companyId: c, entityType: 'fleet.vehicle', deletedAt: null, expiryDate: { lte: soon } }, orderBy: { expiryDate: 'asc' } }),
      this.prisma.employee.findMany({ where: { companyId: c, deletedAt: null, licenseExpiry: { lte: soon } }, select: { id: true, name: true, licenseNo: true, licenseExpiry: true } }),
      this.prisma.fuelLog.groupBy({ by: ['vehicleId'], _sum: { liters: true, cost: true }, _min: { odometer: true }, _max: { odometer: true }, where: { companyId: c, deletedAt: null, date: { gte: new Date(Date.now() - 90 * dayMs) } } }),
    ]);
    const plate = new Map(vehicles.map((v) => [v.id, v.plate]));
    return {
      vehicles: vehicles.length, inMaintenance: vehicles.filter((v) => v.status === 'in_maintenance').length, dueService,
      expiringDocuments: docs.map((d) => ({ ...d, plate: plate.get(d.entityId) })), expiringLicenses: licenses,
      fuelEfficiency: fuel.map((f) => {
        const km = (f._max.odometer ?? 0) - (f._min.odometer ?? 0);
        return { plate: plate.get(f.vehicleId), liters: Number(f._sum.liters), cost: Number(f._sum.cost), kmPerLitre: Number(f._sum.liters) ? Math.round((km / Number(f._sum.liters)) * 10) / 10 : null };
      }),
    };
  }

  // ─── Gatepass ──────────────────────────────────────────────

  /**
   * Guard scan at the gate. OUT: stock leaves (demo → demo warehouse, transfer → destination, others → out).
   * IN: returned quantities come back to the source warehouse, with condition.
   */
  @Post('gatepass/:id/check')
  @Permissions('gatepass.check.create')
  check(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({
      direction: z.enum(['out', 'in']), notes: z.string().optional(), photoId: z.string().optional(),
      lines: z.array(z.object({ lineId: z.string(), qty: z.coerce.number().positive(), condition: z.enum(['ok', 'damaged', 'missing_accessories']).default('ok') })).optional(),
    }), body);
    return this.prisma.$transaction(async (tx) => {
      const gp = await this.resources.load(tx, user, 'gatepass.pass', id, 'view');
      const gl = await tx.gatepassLine.findMany({ where: { gatepassId: id } });
      const type = String(gp.type);
      const base = { companyId: user.companyId, refType: 'gatepass.pass', refId: id, userId: user.id };
      const moves = async (l: (typeof gl)[number], qty: number, dir: 1 | -1, condition?: string) => {
        if (!l.productId) return;
        const units = l.serial ? [{ q: 1, s: l.serial }] : [{ q: qty, s: null }];
        for (const u of units) {
          if (type === 'demo_out') {
            const demo = await this.demoWarehouse(tx, user);
            if (dir === -1) await this.stock.transfer(tx, { ...base, productId: l.productId, from: String(gp.fromWarehouseId), to: demo, qty: u.q, serial: u.s, type: 'demo_out' });
            else await this.stock.transfer(tx, { ...base, productId: l.productId, from: demo, to: String(gp.fromWarehouseId), qty: u.q, serial: u.s, type: 'demo_in', note: condition });
          } else if (type === 'transfer' && dir === -1) {
            await this.stock.transfer(tx, { ...base, productId: l.productId, from: String(gp.fromWarehouseId), to: String(gp.toWarehouseId), qty: u.q, serial: u.s, type: 'transfer' });
          } else if (type === 'inward' && dir === 1 && gp.toWarehouseId) {
            await this.stock.move(tx, { ...base, productId: l.productId, warehouseId: String(gp.toWarehouseId), qty: u.q, serial: u.s, type: 'gatepass' });
          } else if (gp.fromWarehouseId && type !== 'inward' && type !== 'transfer') {
            await this.stock.move(tx, { ...base, productId: l.productId, warehouseId: String(gp.fromWarehouseId), qty: dir * u.q, serial: u.s, type: 'gatepass', serialStatus: type === 'repair_out' ? 'rma' : 'out', note: condition });
          }
        }
      };

      if (b.direction === 'out') {
        if (gp.status !== 'approved') throw new BadRequestException('Gatepass must be approved');
        for (const l of gl) await moves(l, Number(l.qty), -1);
        await this.resources.setStatus(tx, user, 'gatepass.pass', id, ['outward_returnable', 'demo_out', 'repair_out'].includes(type) ? 'out' : 'closed', { checkedOutAt: new Date() });
      } else {
        if (type === 'inward') {
          if (gp.status !== 'approved') throw new BadRequestException('Gatepass must be approved');
          for (const l of gl) await moves(l, Number(l.qty), 1);
          await this.resources.setStatus(tx, user, 'gatepass.pass', id, 'closed', { checkedInAt: new Date() });
        } else {
          if (!['out', 'partially_returned'].includes(String(gp.status))) throw new BadRequestException('Nothing is out on this gatepass');
          for (const r of b.lines ?? gl.map((l) => ({ lineId: l.id, qty: Number(l.qty) - Number(l.returnedQty) - Number(l.soldQty), condition: 'ok' as const }))) {
            const l = gl.find((x) => x.id === r.lineId);
            if (!l) throw new BadRequestException('Unknown line');
            if (r.qty <= 0) continue;
            if (Number(l.returnedQty) + Number(l.soldQty) + r.qty > Number(l.qty)) throw new BadRequestException('Returning more than issued');
            await moves(l, r.qty, 1, r.condition);
            await tx.gatepassLine.update({ where: { id: l.id }, data: { returnedQty: { increment: r.qty }, condition: r.condition } });
          }
          await this.refreshStatus(tx, user, id);
        }
      }
      await tx.gateCheck.create({ data: { companyId: user.companyId, gatepassId: id, direction: b.direction, guardId: user.id, photoId: b.photoId, notes: b.notes } });
      return { ok: true };
    });
  }

  private async refreshStatus(tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], user: AuthUser, id: string) {
    const gl = await tx.gatepassLine.findMany({ where: { gatepassId: id } });
    const open = gl.some((l) => Number(l.returnedQty) + Number(l.soldQty) < Number(l.qty));
    const any = gl.some((l) => Number(l.returnedQty) > 0);
    const sold = gl.every((l) => Number(l.soldQty) >= Number(l.qty));
    const someSold = gl.some((l) => Number(l.soldQty) > 0);
    const status = sold ? 'converted' : open ? (any || someSold ? 'partially_returned' : 'out') : someSold ? 'closed' : 'returned';
    await this.resources.setStatus(tx, user, 'gatepass.pass', id, status, open ? {} : { checkedInAt: new Date() });
  }

  private async demoWarehouse(tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], user: AuthUser) {
    const w = await tx.warehouse.findFirst({ where: { companyId: user.companyId, kind: 'demo', deletedAt: null } });
    if (w) return w.id;
    return (await tx.warehouse.create({ data: { companyId: user.companyId, code: 'DEMO', name: 'Demo (with clients)', kind: 'demo' } })).id;
  }

  /** Client keeps demo items: stock leaves the demo warehouse and an invoice is raised at list price. */
  @Post('gatepass/:id/convert')
  @Permissions('repair.invoice.create')
  convert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ customerId: z.string(), lines: z.array(z.object({ lineId: z.string(), qty: z.coerce.number().positive(), price: z.coerce.number().min(0).optional() })).min(1) }), body);
    return this.prisma.$transaction(async (tx) => {
      const gp = await this.resources.load(tx, user, 'gatepass.pass', id, 'view');
      if (gp.type !== 'demo_out' || !['out', 'partially_returned'].includes(String(gp.status))) throw new BadRequestException('Only outstanding demo gatepasses can be converted');
      const demo = await this.demoWarehouse(tx, user);
      const gl = await tx.gatepassLine.findMany({ where: { gatepassId: id } });
      const invLines = [];
      let cogs = 0;
      for (const r of b.lines) {
        const l = gl.find((x) => x.id === r.lineId);
        if (!l?.productId) throw new BadRequestException('Line has no product');
        if (Number(l.returnedQty) + Number(l.soldQty) + r.qty > Number(l.qty)) throw new BadRequestException('Selling more than is out');
        const p = await tx.product.findUniqueOrThrow({ where: { id: l.productId } });
        const cost = await this.stock.move(tx, { companyId: user.companyId, productId: l.productId, warehouseId: demo, qty: -r.qty, serial: l.serial, type: 'sale', refType: 'gatepass.pass', refId: id, userId: user.id, serialStatus: 'sold' });
        cogs += Math.round(r.qty * toMinor(cost));
        await tx.gatepassLine.update({ where: { id: l.id }, data: { soldQty: { increment: r.qty } } });
        if (l.serial) {
          const soldAt = new Date();
          await tx.serialItem.updateMany({ where: { companyId: user.companyId, serial: l.serial }, data: { customerId: b.customerId, soldAt, warrantyUntil: warrantyEnd(soldAt, await this.serials.warrantyMonths(tx, user.companyId, l.productId)) } });
        }
        invLines.push({ kind: 'part' as const, refId: p.id, description: `${p.name}${l.serial ? ` (${l.serial})` : ''}`, qty: r.qty, price: r.price ?? Number(p.price), taxRate: 0 });
      }
      const inv = await this.repair.createInvoice(tx, user, { customerId: b.customerId, lines: invLines, discount: 0, cogsValue: cogs });
      await this.refreshStatus(tx, user, id);
      return inv;
    });
  }

  @Get('gatepass/overdue')
  @Permissions('gatepass.pass.view')
  async overdue(@CurrentUser() user: AuthUser, @Query('format') format: string | undefined, @Res() res: Response) {
    const rows = await this.prisma.gatepass.findMany({
      where: { companyId: user.companyId, deletedAt: null, status: { in: ['out', 'partially_returned'] }, expectedReturn: { lt: new Date() } },
      include: { lines: true }, orderBy: { expectedReturn: 'asc' },
    });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, {
      title: 'Overdue Returnables & Demos', company, columns: ['number', 'type', 'partyName', 'expectedReturn', 'daysOverdue', 'outstanding'],
      rows: rows.map((g) => ({
        number: g.number, type: g.type, partyName: g.partyName, expectedReturn: g.expectedReturn?.toISOString().slice(0, 10),
        daysOverdue: Math.floor((Date.now() - +g.expectedReturn!) / dayMs),
        outstanding: g.lines.reduce((s, l) => s + Number(l.qty) - Number(l.returnedQty) - Number(l.soldQty), 0),
      })),
    });
  }

  /** Every gatepass and stock movement a serial has been through. */
  @Get('gatepass/serial/:serial')
  @Permissions('gatepass.pass.view')
  async serialHistory(@CurrentUser() user: AuthUser, @Param('serial') serial: string) {
    const [lines, moves] = await Promise.all([
      this.prisma.gatepassLine.findMany({ where: { serial, gatepass: { companyId: user.companyId } }, include: { gatepass: { select: { id: true, number: true, type: true, partyName: true, status: true, createdAt: true } } } }),
      this.prisma.stockMovement.findMany({ where: { companyId: user.companyId, serial }, orderBy: { at: 'asc' } }),
    ]);
    return { gatepasses: lines.map((l) => ({ ...l.gatepass, condition: l.condition })), movements: moves };
  }
}
