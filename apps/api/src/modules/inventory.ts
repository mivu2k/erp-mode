import { BadRequestException, Body, Controller, Get, HttpException, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
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

/** A product's codes: the main barcode plus the extra ones (one per line / comma / space), de-duplicated. */
export function barcodeList(primary: unknown, extra: unknown): string[] {
  return [...new Set([String(primary ?? ''), ...String(extra ?? '').split(/[\s,;]+/)].map((x) => x.trim()).filter(Boolean))];
}

/** The known make a product name mentions (whole word, longest wins): "Motorola APX 6000 battery" → Motorola. */
export function makeFromName(name: string, makes: string[]): string | null {
  const words = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return [...makes].sort((a, b) => b.length - a.length).find((m) => m.trim() && words.includes(` ${m.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)) ?? null;
}

/**
 * SKU from what the item is: MAKE(3)-MODEL(≤8, else name initials)-RANDOM(4), upper-case, e.g. MOT-APX6000-7K3Q.
 * The random tail keeps codes short yet unique; the caller re-rolls on a clash.
 */
export function skuFor(p: { make?: string | null; model?: string | null; name?: string | null }, rand = () => Math.random()): string {
  const clean = (v?: string | null) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const make = clean(p.make).slice(0, 3);
  const model = clean(p.model).slice(0, 8) || String(p.name ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map((w) => (/\d/.test(w) ? w : w[0])).join('').slice(0, 8);
  const tail = Array.from({ length: 4 }, () => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(rand() * 32)]).join(''); // no 0/O/1/I
  return [make, model, tail].filter(Boolean).join('-');
}

/** Spreadsheet column → product field. Headers match loosely: case, spaces and _ ignored, common synonyms accepted. */
const IMPORT_COLUMNS: Record<string, string> = {
  name: 'name', itemname: 'name', productname: 'name', description: 'name',
  sku: 'sku', code: 'sku', itemcode: 'sku', productcode: 'sku',
  kind: 'kind', type: 'kind', itemtype: 'kind', producttype: 'kind', categorytype: 'kind', productorpart: 'kind', partorproduct: 'kind',
  brand: 'brand', make: 'brand', manufacturer: 'brand',
  model: 'model', barcode: 'barcode', otherbarcodes: 'barcodes', barcodes: 'barcodes',
  price: 'price', saleprice: 'price', sellingprice: 'price',
  reorderlevel: 'reorderLevel', reorder: 'reorderLevel', category: 'category', unit: 'unit',
  serialized: 'serialized', serialised: 'serialized', trackserial: 'serialized',
  warranty: 'warrantyMonths', warrantymonths: 'warrantyMonths', compatible: 'compatible', compatiblewith: 'compatible',
};
/** A failed row in words: field errors as "price: Expected number…", otherwise the message. */
function rowError(e: unknown): string {
  const r = e instanceof HttpException ? e.getResponse() : null;
  const fe = r && typeof r === 'object' && 'fieldErrors' in r ? (r as { fieldErrors: Record<string, string[]> }).fieldErrors : null;
  if (fe && Object.keys(fe).length) return Object.entries(fe).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ');
  return e instanceof Error ? e.message : String(e);
}
const yes = (v: string) => /^(y|yes|true|1|x)$/i.test(v.trim());

/** A spreadsheet cell as text: Excel gives formatted cells as { richText }, formulas as { result }, links as { text }. */
export function cellText(raw: unknown): string {
  if (raw == null) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'object') {
    const o = raw as { richText?: { text: string }[]; result?: unknown; text?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('').trim();
    if ('result' in o) return cellText(o.result);
    if ('text' in o) return cellText(o.text);
    return '';
  }
  return String(raw).trim();
}

/** One spreadsheet row as product fields (kind: "part"/"spare…" = part, anything else product). */
export function importRow(headers: string[], cells: unknown[], defaultKind: 'product' | 'part'): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const key = IMPORT_COLUMNS[h.toLowerCase().replace(/[^a-z]/g, '')];
    const v = cellText(cells[i]);
    if (key && v) out[key] = v;
  });
  out.kind = out.kind ? (/^(parts?|spares?|sp|spare ?parts?|components?)\b/i.test(out.kind.trim()) ? 'part' : 'product') : defaultKind;
  return out;
}

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
    // Any number of barcodes per product (none is fine), but one barcode never points at two products.
    const checkBarcodes = async ({ tx, user }: HookCtx, data: Row, before?: Row) => {
      if (data.barcode === undefined && data.barcodes === undefined) return;
      const primary = data.barcode !== undefined ? data.barcode : before?.barcode;
      const codes = barcodeList(primary, data.barcodes !== undefined ? data.barcodes : before?.barcodes);
      if (data.barcodes !== undefined) data.barcodes = barcodeList(null, data.barcodes).filter((c) => c !== String(primary ?? '').trim()).join('\n') || null;
      if (!codes.length) return;
      const others = await tx.product.findMany({
        where: { companyId: user.companyId, deletedAt: null, ...(before ? { id: { not: String(before.id) } } : {}), OR: [{ barcode: { in: codes } }, ...codes.map((c) => ({ barcodes: { contains: c } }))] },
        select: { name: true, barcode: true, barcodes: true },
      });
      for (const o of others) {
        const clash = codes.find((c) => barcodeList(o.barcode, o.barcodes).includes(c));
        if (clash) throw new BadRequestException(`Barcode ${clash} is already on ${o.name}`);
      }
    };
    // SKU is always system-made (read-only everywhere): brand–model–random tail, unique; brand picked up from the name if blank.
    const newSku = async ({ tx, user }: HookCtx, data: Row) => {
      if (!data.brand && data.name) {
        const known = (await tx.product.findMany({ where: { companyId: user.companyId, brand: { not: null } }, select: { brand: true }, distinct: ['brand'] })).map((x) => String(x.brand));
        data.brand = makeFromName(String(data.name), known) ?? undefined;
      }
      for (let i = 0; i < 10; i++) {
        const sku = skuFor({ make: data.brand as string, model: data.model as string, name: data.name as string });
        // No barcode of its own: the SKU becomes its barcode, so the printed label scans straight to it.
        if (!(await tx.product.findFirst({ where: { companyId: user.companyId, sku }, select: { id: true } }))) { data.sku = sku; data.barcode ||= sku; return; }
      }
      throw new BadRequestException('Could not make a unique SKU, try again');
    };
    hooks.on('inventory.product', { beforeCreate: async (c, d) => { await newSku(c, d); await checkBarcodes(c, d); }, beforeUpdate: (c, d, b) => checkBarcodes(c, d, b) });
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

  /** New product: a unique SKU from its make/model/name, and the make detected from the name if not given. */
  @Get('inventory/products/suggest')
  @Permissions('inventory.product.create')
  async suggest(@CurrentUser() user: AuthUser, @Query() q: { name?: string; make?: string; model?: string }) {
    const c = user.companyId;
    let make = q.make?.trim() || null;
    if (!make && q.name?.trim()) {
      const [p, j] = await Promise.all([
        this.prisma.product.findMany({ where: { companyId: c, brand: { not: null } }, select: { brand: true }, distinct: ['brand'], take: 2000 }),
        this.prisma.job.findMany({ where: { companyId: c, brand: { not: null } }, select: { brand: true }, distinct: ['brand'], take: 2000 }),
      ]);
      make = makeFromName(q.name, [...new Set([...p, ...j].map((x) => String(x.brand).trim()))]);
    }
    for (let i = 0; i < 10; i++) {
      const sku = skuFor({ make, model: q.model, name: q.name });
      if (!(await this.prisma.product.findFirst({ where: { companyId: c, sku }, select: { id: true } }))) return { sku, make };
    }
    throw new BadRequestException('Could not find a free SKU; type one in');
  }

  /** Brands already in use (products and repair jobs) and each brand's models: the product form's dropdowns. */
  @Get('inventory/products/options')
  @Permissions('inventory.product.view')
  async productOptions(@CurrentUser() user: AuthUser) {
    const c = user.companyId;
    const [p, j] = await Promise.all([
      this.prisma.product.groupBy({ by: ['brand', 'model'], where: { companyId: c, deletedAt: null, brand: { not: null } }, orderBy: { brand: 'asc' }, take: 5000 }),
      this.prisma.job.groupBy({ by: ['brand', 'model'], where: { companyId: c, deletedAt: null, brand: { not: null } }, orderBy: { brand: 'asc' }, take: 5000 }),
    ]);
    const all = [...p, ...j].map((x) => ({ brand: String(x.brand).trim(), model: String(x.model ?? '').trim() })).filter((x) => x.brand);
    const brands = [...new Map(all.map((x) => [x.brand.toLowerCase(), x.brand])).values()].sort((a, b) => a.localeCompare(b));
    return { brands, models: [...new Map(all.filter((x) => x.model).map((x) => [`${x.brand.toLowerCase()}|${x.model.toLowerCase()}`, x])).values()] };
  }

  /**
   * Import products / parts from Excel or CSV. Without ?commit=1 it only previews (what each row would do, errors).
   * A row whose SKU exists updates that item; a blank SKU is generated, a blank brand detected from the name.
   */
  @Post('inventory/products/import')
  @Permissions('inventory.product.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async importProducts(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Query('commit') commit?: string, @Query('kind') kind?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose an Excel (.xlsx) or CSV file');
    const wb = new ExcelJS.Workbook();
    try {
      if (/\.csv$/i.test(file.originalname) || file.mimetype.includes('csv') || file.mimetype === 'text/plain') {
        const { Readable } = await import('node:stream');
        await wb.csv.read(Readable.from(file.buffer.toString('utf8')));
      } else await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch { throw new BadRequestException('Could not read the file — save it as .xlsx or .csv'); }
    const sheet = wb.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw new BadRequestException('The sheet has no rows under the header');
    if (sheet.rowCount > 5001) throw new BadRequestException('Up to 5000 rows per import');
    const headers = ((sheet.getRow(1).values as unknown[]) ?? []).slice(1).map((h) => String(h ?? ''));
    if (!headers.some((h) => IMPORT_COLUMNS[h.toLowerCase().replace(/[^a-z]/g, '')] === 'name')) throw new BadRequestException('The sheet needs a "Name" column');
    const c = user.companyId;
    const md = await this.prisma.masterData.findMany({ where: { companyId: c, type: { in: ['product_category', 'unit'] }, deletedAt: null }, select: { id: true, type: true, name: true, code: true } });
    const mdId = (type: string, v?: string) => v ? md.find((m) => m.type === type && [m.name, m.code].some((x) => x?.toLowerCase() === v.toLowerCase()))?.id : undefined;
    const known = (await this.prisma.product.findMany({ where: { companyId: c, brand: { not: null } }, select: { brand: true }, distinct: ['brand'] })).map((x) => String(x.brand));
    const taken = new Set<string>();
    const results: { row: number; action: 'create' | 'update' | 'error'; sku?: string; name?: string; brand?: string | null; kind?: string; error?: string }[] = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const cells = ((sheet.getRow(r).values as unknown[]) ?? []).slice(1);
      if (!cells.some((x) => String(x ?? '').trim())) continue;
      const v = importRow(headers, cells, kind === 'part' ? 'part' : 'product');
      try {
        if (!v.name) throw new BadRequestException('Name is empty');
        // Numbers are checked here too, so the preview shows the same problems the import would hit.
        for (const [k, label] of [['price', 'Price'], ['reorderLevel', 'Reorder level'], ['warrantyMonths', 'Warranty months']] as const) {
          if (v[k] && !Number.isFinite(Number(v[k].replace(/,/g, '')))) throw new BadRequestException(`${label} "${v[k]}" is not a number`);
        }
        const brand = v.brand || makeFromName(v.name, known);
        // The file's SKU only finds an existing item to update; new items always get a system SKU.
        const existing = v.sku ? await this.prisma.product.findFirst({ where: { companyId: c, sku: v.sku, deletedAt: null }, select: { id: true } }) : null;
        if (existing && taken.has(v.sku!)) throw new BadRequestException(`SKU ${v.sku} appears twice in the file`);
        if (existing) taken.add(v.sku!);
        let sku = existing ? v.sku : undefined;
        const data: Row = {
          name: v.name, kind: v.kind, brand: brand || undefined, model: v.model, barcode: v.barcode, barcodes: v.barcodes,
          price: v.price?.replace(/,/g, ''), reorderLevel: v.reorderLevel?.replace(/,/g, ''), compatible: v.compatible,
          serialized: v.serialized !== undefined ? yes(v.serialized) : undefined, warrantyMonths: v.warrantyMonths ? Number(v.warrantyMonths) : undefined,
          categoryId: mdId('product_category', v.category), unitId: mdId('unit', v.unit),
        };
        for (const k of Object.keys(data)) if (data[k] === undefined || data[k] === '') delete data[k];
        if (v.category && !data.categoryId) throw new BadRequestException(`Unknown category "${v.category}" (add it in Master Data first)`);
        if (commit === '1') {
          if (existing) await this.resources.update(user, 'inventory.product', existing.id, data);
          else sku = String((await this.resources.create(user, 'inventory.product', data)).sku);
        }
        results.push({ row: r, action: existing ? 'update' : 'create', sku: sku ?? (commit === '1' ? undefined : 'auto'), name: v.name, brand: brand ?? null, kind: v.kind });
      } catch (e) {
        results.push({ row: r, action: 'error', sku: v.sku, name: v.name, error: rowError(e) });
      }
    }
    const count = (a: string) => results.filter((x) => x.action === a).length;
    return { committed: commit === '1', created: count('create'), updated: count('update'), errors: count('error'), rows: results };
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
