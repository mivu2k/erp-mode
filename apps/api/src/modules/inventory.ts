import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { docTotals, fromMinor, toMinor } from '@erp/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { sendReport } from '../engine/export';
import { HookCtx, HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { LedgerService } from '../platform/ledger.service';
import { NotifyService } from '../platform/notify.service';
import { NumberingService } from '../platform/numbering.service';
import { PrismaService } from '../platform/prisma.service';
import { StockService } from '../platform/stock.service';
import { AuthUser, CurrentUser, Permissions } from '../rbac/rbac';
import { FinanceController } from './finance';

const adjLines = z.array(z.object({ productId: z.string(), qty: z.coerce.number(), serial: z.string().nullish(), unitCost: z.coerce.number().optional() })).min(1);
const receiveLines = z.array(z.object({ lineId: z.string(), qty: z.coerce.number().positive(), serials: z.array(z.string()).optional() })).min(1);

@Controller()
export class InventoryController {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private stock: StockService,
    private ledger: LedgerService,
    private numbering: NumberingService,
    private notify: NotifyService,
    private finance: FinanceController,
    hooks: HooksService,
  ) {
    hooks.on('inventory.adjustment', {
      beforeCreate: (_c, data) => void parse(adjLines, data.lines),
      beforeUpdate: (_c, data) => void (data.lines !== undefined && parse(adjLines, data.lines)),
    });
    hooks.on('purchase.requisition', { beforeCreate: (_c, data) => void parse(z.array(z.object({ productId: z.string(), qty: z.coerce.number().positive(), jobId: z.string().nullish() })).min(1), data.lines) });
    const poTotals = (_c: HookCtx, data: Row) => {
      const lines = data.lines as Row[] | undefined;
      if (!lines) return;
      const t = docTotals(lines.map((l) => ({ qty: Number(l.qty), price: Number(l.price), taxRate: Number(l.taxRate ?? 0) })));
      Object.assign(data, { subtotal: fromMinor(t.subtotal), tax: fromMinor(t.tax), total: fromMinor(t.total) });
    };
    hooks.on('purchase.order', { beforeCreate: poTotals, beforeUpdate: poTotals });
  }

  @Post('inventory/adjustments/:id/post')
  @Permissions('inventory.adjustment.approve')
  postAdjustment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await this.resources.load(tx, user, 'inventory.adjustment', id, 'approve');
      if (a.status !== 'approved') throw new BadRequestException('Adjustment must be approved');
      const acc = await this.ledger.accounts(user.companyId);
      let value = 0;
      for (const l of parse(adjLines, a.lines)) {
        const base = { companyId: user.companyId, productId: l.productId, serial: l.serial, refType: 'inventory.adjustment', refId: id, userId: user.id };
        if (a.kind === 'transfer') {
          if (!a.toWarehouseId) throw new BadRequestException('Transfer needs a destination');
          await this.stock.transfer(tx, { ...base, from: String(a.warehouseId), to: String(a.toWarehouseId), qty: Math.abs(l.qty), type: 'transfer' });
        } else {
          let qty = a.kind === 'damaged' ? -Math.abs(l.qty) : l.qty;
          if (a.kind === 'count') {
            // Physical count: line qty is what was counted; post only the difference.
            const lvl = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: l.productId, warehouseId: String(a.warehouseId) } } });
            qty = l.qty - Number(lvl?.qty ?? 0);
            if (qty === 0) continue;
          }
          const cost = await this.stock.move(tx, { ...base, warehouseId: String(a.warehouseId), qty, unitCost: l.unitCost, type: String(a.kind), serialStatus: a.kind === 'damaged' ? 'scrapped' : 'out' });
          value += Math.round(qty * toMinor(cost));
        }
      }
      if (value) {
        await this.ledger.post(tx, {
          companyId: user.companyId, memo: `Stock ${a.kind} ${a.number}`, sourceType: 'inventory.adjustment', sourceId: id, userId: user.id,
          lines: value > 0 ? [{ accountId: acc.inventory, debit: fromMinor(value) }, { accountId: acc.cogs, credit: fromMinor(value) }] : [{ accountId: acc.cogs, debit: fromMinor(-value) }, { accountId: acc.inventory, credit: fromMinor(-value) }],
        });
      }
      await this.resources.setStatus(tx, user, 'inventory.adjustment', id, 'posted');
      return { posted: true };
    });
  }

  @Get('inventory/low-stock')
  @Permissions('inventory.stock.view')
  async lowStock(@CurrentUser() user: AuthUser, @Query('format') format: string | undefined, @Res() res: Response) {
    const products = await this.prisma.product.findMany({ where: { companyId: user.companyId, deletedAt: null, isActive: true, isService: false, reorderLevel: { gt: 0 } } });
    const levels = await this.prisma.stockLevel.groupBy({ by: ['productId'], _sum: { qty: true }, where: { productId: { in: products.map((p) => p.id) } } });
    const qty = new Map(levels.map((l) => [l.productId, Number(l._sum.qty ?? 0)]));
    const rows: Row[] = products.filter((p) => (qty.get(p.id) ?? 0) <= Number(p.reorderLevel)).map((p) => ({ sku: p.sku, name: p.name, onHand: qty.get(p.id) ?? 0, reorderLevel: Number(p.reorderLevel) }));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, { title: 'Low Stock', company, columns: ['sku', 'name', 'onHand', 'reorderLevel'], rows });
  }

  @Get('inventory/valuation')
  @Permissions('inventory.stock.manage')
  async valuation(@CurrentUser() user: AuthUser, @Query('format') format: string | undefined, @Res() res: Response) {
    const levels = await this.prisma.stockLevel.findMany({ where: { companyId: user.companyId, qty: { not: 0 } } });
    const [products, warehouses] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: levels.map((l) => l.productId) } } }),
      this.prisma.warehouse.findMany({ where: { companyId: user.companyId } }),
    ]);
    const p = new Map(products.map((x) => [x.id, x]));
    const w = new Map(warehouses.map((x) => [x.id, x.name]));
    let total = 0;
    const rows: Row[] = levels.map((l) => {
      const value = Math.round(Number(l.qty) * toMinor(l.avgCost));
      total += value;
      return { sku: p.get(l.productId)?.sku, name: p.get(l.productId)?.name, warehouse: w.get(l.warehouseId), qty: Number(l.qty), avgCost: Number(l.avgCost), value: fromMinor(value) };
    });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, { title: 'Inventory Valuation', company, columns: ['sku', 'name', 'warehouse', 'qty', 'avgCost', 'value'], rows, totals: [['Total', fromMinor(total)]] });
  }

  // ─── Purchase ──────────────────────────────────────────────

  @Post('purchase/requisitions/:id/to-po')
  @Permissions('purchase.order.create')
  async toPo(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { vendorId?: string }) {
    const vendorId = parse(z.string(), body?.vendorId);
    const pr = await this.prisma.$transaction((tx) => this.resources.load(tx, user, 'purchase.requisition', id, 'view'));
    if (pr.status !== 'approved') throw new BadRequestException('Requisition must be approved');
    const lines = pr.lines as { productId: string; qty: number; jobId?: string }[];
    const products = new Map((await this.prisma.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } } })).map((p) => [p.id, p]));
    const po = await this.resources.create(user, 'purchase.order', {
      vendorId, date: new Date().toISOString().slice(0, 10), notes: `From ${pr.number}`,
      lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, price: Number(products.get(l.productId)?.cost ?? 0), jobId: l.jobId ?? null })),
    });
    await this.prisma.$transaction((tx) => this.resources.setStatus(tx, user, 'purchase.requisition', id, 'ordered', { poId: po.id }));
    return po;
  }

  /** GRN: stock in at PO price, serial capture, Dr Inventory / Cr Payables, and pings jobs waiting on these parts. */
  @Post('purchase/orders/:id/receive')
  @Permissions('purchase.receipt.create')
  receive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ warehouseId: z.string(), lines: receiveLines }), body);
    return this.prisma.$transaction(async (tx) => {
      const po = await this.resources.load(tx, user, 'purchase.order', id, 'view');
      if (!['approved', 'partially_received'].includes(String(po.status))) throw new BadRequestException('PO is not open for receiving');
      await tx.warehouse.findFirstOrThrow({ where: { id: b.warehouseId, companyId: user.companyId } });
      const poLines = new Map((await tx.purchaseOrderLine.findMany({ where: { poId: id } })).map((l) => [l.id, l]));
      let value = 0;
      const grnLines = [];
      for (const r of b.lines) {
        const l = poLines.get(r.lineId);
        if (!l) throw new BadRequestException('Unknown PO line');
        if (Number(l.receivedQty) + r.qty > Number(l.qty)) throw new BadRequestException('Receiving more than ordered');
        const serials = r.serials ?? [];
        const moves = serials.length ? serials.map((s) => ({ qty: 1, serial: s })) : [{ qty: r.qty, serial: null }];
        if (serials.length && serials.length !== r.qty) throw new BadRequestException('Serial count must equal quantity');
        for (const mv of moves) {
          await this.stock.move(tx, { companyId: user.companyId, productId: l.productId, warehouseId: b.warehouseId, qty: mv.qty, unitCost: Number(l.price), serial: mv.serial, type: 'purchase', refType: 'purchase.order', refId: id, userId: user.id });
        }
        await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { receivedQty: { increment: r.qty } } });
        if (serials.length) await tx.serialItem.updateMany({ where: { companyId: user.companyId, serial: { in: serials } }, data: { vendorId: String(po.vendorId), receivedAt: new Date() } });
        value += Math.round(r.qty * toMinor(l.price));
        grnLines.push({ poLineId: l.id, productId: l.productId, qty: r.qty, unitCost: Number(l.price), serials });
        if (l.jobId) {
          const job = await tx.job.findUnique({ where: { id: l.jobId } });
          if (job) await this.notify.send(user.companyId, [await this.notify.employeeUser(job.technicianId, tx)], { title: `Parts received for ${job.number}`, link: `/r/repair.job/${job.id}` }, tx);
        }
      }
      const acc = await this.ledger.accounts(user.companyId);
      const number = await this.numbering.next(tx, user.companyId, user.branchId, 'GRN', 'GRN-{YYYY}-{SEQ:5}');
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `GRN ${number} / ${po.number}`, sourceType: 'purchase.receipt', userId: user.id,
        lines: [{ accountId: acc.inventory, debit: fromMinor(value) }, { accountId: acc.payable, credit: fromMinor(value), partyType: 'vendor', partyId: String(po.vendorId) }],
      });
      const grn = await tx.goodsReceipt.create({ data: { companyId: user.companyId, branchId: user.branchId, number, poId: id, warehouseId: b.warehouseId, lines: grnLines, journalId: je.id, createdById: user.id } });
      const after = await tx.purchaseOrderLine.findMany({ where: { poId: id } });
      await this.resources.setStatus(tx, user, 'purchase.order', id, after.every((l) => Number(l.receivedQty) >= Number(l.qty)) ? 'received' : 'partially_received');
      return grn;
    });
  }

  @Post('purchase/orders/:id/return')
  @Permissions('purchase.receipt.create')
  returnToVendor(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ warehouseId: z.string(), lines: receiveLines }), body);
    return this.prisma.$transaction(async (tx) => {
      const po = await this.resources.load(tx, user, 'purchase.order', id, 'view');
      const poLines = new Map((await tx.purchaseOrderLine.findMany({ where: { poId: id } })).map((l) => [l.id, l]));
      let value = 0;
      for (const r of b.lines) {
        const l = poLines.get(r.lineId);
        if (!l || Number(l.returnedQty) + r.qty > Number(l.receivedQty)) throw new BadRequestException('Cannot return more than received');
        const moves = r.serials?.length ? r.serials.map((s) => ({ qty: 1, serial: s })) : [{ qty: r.qty, serial: null }];
        for (const mv of moves) {
          const cost = await this.stock.move(tx, { companyId: user.companyId, productId: l.productId, warehouseId: b.warehouseId, qty: -mv.qty, serial: mv.serial, type: 'vendor_return', refType: 'purchase.order', refId: id, userId: user.id, serialStatus: 'out' });
          value += Math.round(mv.qty * toMinor(cost));
        }
        await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { returnedQty: { increment: r.qty } } });
      }
      const acc = await this.ledger.accounts(user.companyId);
      await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Purchase return ${po.number}`, sourceType: 'purchase.order', sourceId: id, userId: user.id,
        lines: [{ accountId: acc.payable, debit: fromMinor(value), partyType: 'vendor', partyId: String(po.vendorId) }, { accountId: acc.inventory, credit: fromMinor(value) }],
      });
      return { returnedValue: fromMinor(value) };
    });
  }

  @Post('purchase/bills/:id/pay')
  @Permissions('finance.payment.create')
  payBill(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amount: z.coerce.number().positive(), accountId: z.string(), methodId: z.string().nullish(), idempotencyKey: z.string().max(100).optional() }), body);
    return this.prisma.$transaction(async (tx) => {
      const bill = await this.resources.load(tx, user, 'purchase.bill', id, 'view');
      const due = toMinor(bill.amount as string) - toMinor(bill.paid as string);
      if (toMinor(b.amount) > due) throw new BadRequestException(`Only ${fromMinor(due)} is due`);
      const acc = await this.ledger.accounts(user.companyId);
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Payment ${bill.number}`, sourceType: 'purchase.bill', sourceId: id, userId: user.id,
        lines: [{ accountId: acc.payable, debit: b.amount, partyType: 'vendor', partyId: String(bill.vendorId) }, { accountId: b.accountId, credit: b.amount }],
      });
      await this.finance.payment(tx, user, { direction: 'out', partyType: 'vendor', partyId: String(bill.vendorId), refType: 'purchase.bill', refId: id, amount: b.amount, accountId: b.accountId, methodId: b.methodId, journalId: je.id, idempotencyKey: b.idempotencyKey });
      const paid = toMinor(bill.paid as string) + toMinor(b.amount);
      await tx.vendorBill.update({ where: { id }, data: { paid: fromMinor(paid), status: paid >= toMinor(bill.amount as string) ? 'paid' : 'partially_paid' } });
      return { paid: fromMinor(paid) };
    });
  }

  @Get('purchase/vendors/performance')
  @Permissions('purchase.vendor.view')
  async vendorPerformance(@CurrentUser() user: AuthUser, @Query('format') format: string | undefined, @Res() res: Response) {
    const pos = await this.prisma.purchaseOrder.findMany({ where: { companyId: user.companyId, deletedAt: null, status: { in: ['received', 'partially_received', 'closed'] } }, include: { lines: true } });
    const grns = await this.prisma.goodsReceipt.findMany({ where: { companyId: user.companyId, poId: { in: pos.map((p) => p.id) } }, orderBy: { createdAt: 'asc' } });
    const firstGrn = new Map<string, Date>();
    for (const g of grns) if (!firstGrn.has(g.poId)) firstGrn.set(g.poId, g.createdAt);
    const by = new Map<string, { orders: number; onTime: number; received: number; returned: number }>();
    for (const p of pos) {
      const s = by.get(p.vendorId) ?? { orders: 0, onTime: 0, received: 0, returned: 0 };
      s.orders++;
      const g = firstGrn.get(p.id);
      if (!p.expectedAt || (g && g <= new Date(+p.expectedAt + 86_400_000))) s.onTime++;
      for (const l of p.lines) {
        s.received += Number(l.receivedQty);
        s.returned += Number(l.returnedQty);
      }
      by.set(p.vendorId, s);
    }
    const names = new Map((await this.prisma.vendor.findMany({ where: { id: { in: [...by.keys()] } } })).map((v) => [v.id, v.name]));
    const rows: Row[] = [...by.entries()].map(([id, s]) => ({ vendor: names.get(id), orders: s.orders, onTimePct: Math.round((100 * s.onTime) / s.orders), returnPct: s.received ? Math.round((100 * s.returned) / s.received) : 0 }));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, { title: 'Vendor Performance', company, columns: ['vendor', 'orders', 'onTimePct', 'returnPct'], rows });
  }
}
