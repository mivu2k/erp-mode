import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { sendReport } from '../engine/export';
import { HooksService } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { Tx } from '../platform/audit.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { assertCan, AuthUser, can, CurrentUser, Permissions } from '../rbac/rbac';

const DAY = 86_400_000;

/** Warranty state of a unit on a given day. */
export function warrantyStatus(until: Date | null | undefined, now = new Date()): { state: 'none' | 'active' | 'expiring' | 'expired'; daysLeft: number | null } {
  if (!until) return { state: 'none', daysLeft: null };
  const days = Math.floor((+until - +new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) / DAY);
  return { state: days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'active', daysLeft: days };
}

/** Warranty end = sale date + product months (or the company default). */
export function warrantyEnd(soldAt: Date, months: number): Date {
  return new Date(Date.UTC(soldAt.getUTCFullYear(), soldAt.getUTCMonth() + months, soldAt.getUTCDate()));
}

export interface SerialEvent { at: Date; kind: string; title: string; detail?: string; link?: string }

const TRACKED: [string, string][] = [['status', 'Status'], ['location', 'Location'], ['holder', 'Holder'], ['customerId', 'Customer'], ['warrantyUntil', 'Warranty until']];
const show = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null || v === '' ? '—' : String(v).replace(/_/g, ' '));
/** "Status: in stock → demo · Location: — → Site B" for the tracked fields that changed. */
export function trackChanges(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return TRACKED.filter(([k]) => show(before[k]) !== show(after[k])).map(([k, l]) => `${l}: ${show(before[k])} → ${show(after[k])}`).join(' · ');
}
const trackDetail = (r: Record<string, unknown>) => [r.itemName, [r.brand, r.model].filter(Boolean).join(' '), show(r.status), r.location, r.holder].filter((x) => x && x !== '—').join(' · ');

const registerSchema = z.object({
  serials: z.array(z.string().trim().min(1).max(191)).min(1).max(1000),
  productId: z.string().optional(), itemName: z.string().max(191).optional(), brand: z.string().max(191).optional(), model: z.string().max(191).optional(),
  status: z.string().optional(), location: z.string().max(191).optional(), holder: z.string().max(191).optional(),
  customerId: z.string().optional(), warrantyUntil: z.string().optional(), notes: z.string().optional(),
});

const MOVE_LABEL: Record<string, string> = {
  purchase: 'Received into stock', job_issue: 'Issued to repair job', job_return: 'Returned from repair job', transfer: 'Transferred',
  adjustment: 'Stock adjustment', damaged: 'Written off (damaged)', demo_out: 'Sent out on demo', demo_in: 'Returned from demo',
  sale: 'Sold', vendor_return: 'Returned to vendor', gatepass: 'Moved through gate', count: 'Stock count',
};

@Controller('serials')
export class SerialsController {
  constructor(private prisma: PrismaService, private resources: ResourceService, private settings: SettingsService, hooks: HooksService) {
    // Manual tracking: every hand-entered change to status / whereabouts / holder lands in the serial's history.
    hooks.on('serials.item', {
      afterCreate: async ({ tx, user }, rec) => { await tx.serialEvent.create({ data: { companyId: user.companyId, serialItemId: String(rec.id), serial: String(rec.serial), userId: user.id, title: 'Registered', detail: trackDetail(rec) } }); },
      afterUpdate: async ({ tx, user }, rec, before) => {
        const detail = trackChanges(before, rec);
        if (detail) await tx.serialEvent.create({ data: { companyId: user.companyId, serialItemId: String(rec.id), serial: String(rec.serial), userId: user.id, title: 'Tracking updated', detail } });
      },
    });
  }

  /** Register many serials at once (e.g. scanned off a delivery) with shared details; existing ones are left untouched. */
  @Post('register')
  @Permissions('serials.item.create')
  async register(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(registerSchema, body);
    const serials = [...new Set(b.serials)];
    const existing = new Set((await this.prisma.serialItem.findMany({ where: { companyId: user.companyId, serial: { in: serials } }, select: { serial: true } })).map((s) => s.serial));
    const { serials: _s, ...shared } = b;
    const created: string[] = [];
    for (const serial of serials.filter((s) => !existing.has(s))) {
      await this.resources.create(user, 'serials.item', { ...shared, serial });
      created.push(serial);
    }
    return { created, existing: [...existing] };
  }

  /** Warranty months for a product (its own, else the company default). */
  async warrantyMonths(tx: Tx, companyId: string, productId: string) {
    const p = await tx.product.findUnique({ where: { id: productId }, select: { warrantyMonths: true } });
    return p?.warrantyMonths || (await this.settings.get(companyId, 'serials')).defaultWarrantyMonths;
  }

  /** Everything that happened to one serial, oldest first: receipts, moves, gatepasses, demos, sale, repair jobs. */
  async history(user: AuthUser, serial: string): Promise<SerialEvent[]> {
    const c = user.companyId;
    const [manual, moves, gpLines, jobs] = await Promise.all([
      this.prisma.serialEvent.findMany({ where: { companyId: c, serial }, orderBy: { at: 'asc' } }),
      this.prisma.stockMovement.findMany({ where: { companyId: c, serial }, orderBy: { at: 'asc' } }),
      can(user, 'gatepass.pass.view') ? this.prisma.gatepassLine.findMany({ where: { serial, gatepass: { companyId: c, deletedAt: null } }, include: { gatepass: true } }) : [],
      can(user, 'repair.job.view') ? this.prisma.job.findMany({ where: { companyId: c, deletedAt: null, OR: [{ serial }, { assetTag: serial }] }, orderBy: { createdAt: 'asc' } }) : [],
    ]);
    const warehouses = new Map((await this.prisma.warehouse.findMany({ where: { companyId: c } })).map((w) => [w.id, w.name]));
    const poIds = moves.filter((m) => m.refType === 'purchase.order' && m.refId).map((m) => m.refId!);
    const pos = new Map((await this.prisma.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, number: true, vendorId: true } })).map((p) => [p.id, p]));
    const vendors = new Map((await this.prisma.vendor.findMany({ where: { id: { in: [...pos.values()].map((p) => p.vendorId) } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
    const events: SerialEvent[] = [];
    // A transfer (incl. demo out/in) is two moves at the same instant: show it once as "from → to".
    const used = new Set<string>();
    for (const m of moves) {
      if (used.has(m.id)) continue;
      const po = m.refType === 'purchase.order' && m.refId ? pos.get(m.refId) : undefined;
      const pair = Number(m.qty) < 0 ? moves.find((x) => !used.has(x.id) && x.id !== m.id && Number(x.qty) > 0 && x.refId === m.refId && Math.abs(+x.at - +m.at) < 5_000) : undefined;
      if (pair) used.add(pair.id);
      const where = pair ? `${warehouses.get(m.warehouseId) ?? '?'} → ${warehouses.get(pair.warehouseId) ?? '?'}` : `${Number(m.qty) > 0 ? 'into' : 'out of'} ${warehouses.get(m.warehouseId) ?? 'warehouse'}`;
      events.push({
        at: m.at, kind: m.type,
        title: MOVE_LABEL[m.type] ?? m.type,
        detail: [where, po ? `PO ${po.number} · ${vendors.get(po.vendorId) ?? ''}` : null, m.note].filter(Boolean).join(' · '),
        link: m.refType && m.refId ? `/r/${m.refType}/${m.refId}` : undefined,
      });
    }
    for (const l of gpLines) {
      events.push({ at: l.gatepass.createdAt, kind: 'gatepass', title: `Gatepass ${l.gatepass.number} (${l.gatepass.type.replace(/_/g, ' ')})`, detail: [l.gatepass.partyName, l.gatepass.status, l.condition].filter(Boolean).join(' · '), link: `/r/gatepass.pass/${l.gatepass.id}` });
    }
    for (const j of jobs) {
      events.push({ at: j.createdAt, kind: 'repair', title: `Repair job ${j.number}`, detail: [j.fault, j.status, j.warranty ? 'under warranty' : null].filter(Boolean).join(' · '), link: `/r/${j.kind === 'fleet' ? 'fleet.maintenance' : 'repair.job'}/${j.id}` });
    }
    for (const m of manual) events.push({ at: m.at, kind: 'track', title: m.title, detail: m.detail ?? undefined });
    return events.sort((a, b) => +a.at - +b.at);
  }

  /** Scan / type a serial: the unit, where it is, its warranty and full history. Also matches repair-only serials and asset tags. */
  @Get('lookup')
  @Permissions('serials.item.view')
  async lookup(@CurrentUser() user: AuthUser, @Query('serial') raw = '') {
    const serial = raw.trim();
    if (!serial) throw new NotFoundException();
    const item = await this.prisma.serialItem.findUnique({ where: { companyId_serial: { companyId: user.companyId, serial } } });
    const rec = item ? await this.resources.get(user, 'serials.item', item.id) : null;
    const history = await this.history(user, serial);
    if (!rec && !history.length) throw new NotFoundException(`No record of serial ${serial}`);
    const product = rec?.productId ? await this.prisma.product.findUnique({ where: { id: String(rec.productId) }, select: { id: true, sku: true, name: true, brand: true, model: true } }) : null;
    return { serial, item: rec, product, warranty: warrantyStatus(item?.warrantyUntil), history };
  }

  @Get(':id/history-page')
  @Permissions('serials.item.view')
  async historyPage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response) {
    const rec = await this.resources.get(user, 'serials.item', id);
    const events = await this.history(user, String(rec.serial));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    const w = warrantyStatus(rec.warrantyUntil as Date | null);
    return sendReport(res, format ?? 'html', {
      title: `Serial ${rec.serial}`, company, columns: ['date', 'event', 'detail'],
      rows: events.map((e) => ({ date: e.at.toISOString().slice(0, 16).replace('T', ' '), event: e.title, detail: e.detail ?? '' })),
      fields: [['Product', (rec._refs as Record<string, unknown> | undefined)?.productId ?? ''], ['Status', String(rec.status).replace(/_/g, ' ')], ['Warranty', w.state === 'none' ? '—' : `${w.state} (${String(rec.warrantyUntil).slice(0, 10)})`]],
    });
  }

  /** Paste many serials: status, location, customer and warranty for each; unknown ones listed separately. */
  @Post('bulk')
  @Permissions('serials.item.view')
  async bulk(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const serials = [...new Set(parse(z.object({ serials: z.array(z.string().trim().min(1)).max(1000) }), body).serials)];
    const items = await this.prisma.serialItem.findMany({ where: { companyId: user.companyId, serial: { in: serials } } });
    const rows = items.map((i) => ({ ...i })) as unknown as Record<string, unknown>[];
    await this.resources.attachRefs(this.prisma, user, this.resources.meta('serials.item'), rows);
    const found = new Set(items.map((i) => i.serial));
    return {
      rows: rows.map((r) => ({ ...r, warranty: warrantyStatus(r.warrantyUntil as Date | null) })),
      unknown: serials.filter((s) => !found.has(s)),
    };
  }

  /** Units whose warranty ends within N days (for follow-up / renewals). */
  @Get('warranty/expiring')
  async expiring(@CurrentUser() user: AuthUser, @Query('days') days = '30') {
    assertCan(user, 'serials.item.view');
    const until = new Date(Date.now() + Number(days) * DAY);
    const rows = await this.prisma.serialItem.findMany({ where: { companyId: user.companyId, warrantyUntil: { gte: new Date(Date.now() - DAY), lte: until } }, orderBy: { warrantyUntil: 'asc' }, take: 500 });
    const out = rows.map((r) => ({ ...r })) as unknown as Record<string, unknown>[];
    await this.resources.attachRefs(this.prisma, user, this.resources.meta('serials.item'), out);
    return out;
  }
}
