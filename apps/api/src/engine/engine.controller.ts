import { BadRequestException, Body, Controller, Delete, Get, HttpCode, MessageEvent, NotFoundException, Param, Patch, Post, Query, Res, Sse, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { from, interval, Observable } from 'rxjs';
import { filter, map, startWith, switchMap } from 'rxjs/operators';
import { MODULES, moduleOf, RESOURCE_MAP, RESOURCES } from '@erp/shared';
import { unitByCode } from '../modules/serials';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { amountInWords, PRINT_PROFILES } from '../platform/print-profiles';
import { isPage, PrintService, PaperSize } from '../platform/print.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { sniff } from '../platform/filetype';
import { StorageService } from '../platform/storage.service';
import { AccessPayload, assertCan, AuthUser, can, CurrentUser, Public } from '../rbac/rbac';
import { cell, sendHtmlOrPdf, toCsv, toXlsx } from './export';
import { delegate, Row } from './hooks';
import { META } from './meta';
import { ListParams, parse, ResourceService } from './resource.service';
import { WorkflowService } from './workflow.service';

const humanize = (s: string) => s.replace(/Id$/, '').replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

@Controller('meta')
export class MetaController {
  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  /** Everything the web app needs to render menus, lists and forms for this user. */
  @Get()
  async meta(@CurrentUser() user: AuthUser) {
    const custom = await this.prisma.customField.findMany({ where: { companyId: user.companyId, deletedAt: null }, orderBy: { sort: 'asc' } });
    const company = await this.prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true, branding: true, currency: true, timezone: true, dateFormat: true } });
    // Company-managed option lists (e.g. employee types) come from Master Data.
    const listTypes = [...new Set(RESOURCES.flatMap((r) => Object.values(r.lists ?? {})))];
    const listRows = listTypes.length ? await this.prisma.masterData.findMany({ where: { companyId: user.companyId, type: { in: listTypes }, isActive: true, deletedAt: null }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] }) : [];
    const optionsOf = (type: string) => listRows.filter((x) => x.type === type).map((x) => x.code ?? x.name);
    return {
      user,
      company,
      files: await this.settings.get(user.companyId, 'files'),
      modules: Object.entries(MODULES).filter(([k]) => !user.disabledModules.includes(k)).map(([key, v]) => ({ key, ...v })),
      resources: RESOURCES.filter((r) => can(user, `${r.key}.view`)).map((r) => {
        const m = META[r.key];
        const manage = can(user, `${r.key}.manage`);
        return {
          ...r,
          fields: m.fields.filter((f) => manage || !f.restricted).map((f) => (r.lists?.[f.name] ? { ...f, type: 'enum' as const, options: optionsOf(r.lists[f.name]) } : f)),
          children: Object.fromEntries(Object.entries(m.children).map(([k, c]) => [k, c.fields])),
          customFields: custom.filter((c) => c.resource === r.key),
          can: Object.fromEntries(['create', 'update', 'delete', 'approve', 'export', 'print', 'manage'].map((a) => [a, can(user, `${r.key}.${a}`)])),
        };
      }),
    };
  }
}

@Controller('r')
export class ResourceController {
  constructor(
    private resources: ResourceService,
    private workflow: WorkflowService,
    private prisma: PrismaService,
    private print: PrintService,
  ) {}

  @Get(':key')
  list(@CurrentUser() user: AuthUser, @Param('key') key: string, @Query() q: ListParams & { trash?: string }) {
    return this.resources.list(user, key, { ...q, trash: q.trash === '1' || q.trash === 'true' });
  }

  /** Exports honour the same filters/search/sort as the list. */
  @Get(':key/export')
  async export(
    @CurrentUser() user: AuthUser, @Param('key') key: string, @Res() res: Response,
    @Query() q: ListParams & { format?: string; columns?: string },
  ) {
    assertCan(user, `${key}.export`);
    const m = this.resources.meta(key);
    const readable = new Set(Object.keys(this.resources.select(user, m)));
    const columns = (q.columns ? q.columns.split(',') : m.def.list).filter((c) => readable.has(c) || (c.startsWith('custom.') && readable.has('custom')));
    const name = `${m.def.label}-${new Date().toISOString().slice(0, 10)}`;
    if (!q.format || q.format === 'csv') {
      // CSV streams page by page, so any size works without holding it in memory.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      res.write(toCsv(columns, []));
      for (let page = 1; ; page++) {
        const { rows } = await this.resources.list(user, key, { ...q, page, pageSize: 5_000 });
        if (rows.length) res.write('\r\n' + toCsv(columns, rows).split('\r\n').slice(1).join('\r\n'));
        if (rows.length < 5_000) break;
      }
      return res.end();
    }
    // ponytail: xlsx/pdf are built in memory, capped at 10k rows; use CSV beyond that
    const { rows } = await this.resources.list(user, key, { ...q, page: 1, pageSize: 10_000 });
    if (q.format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      return res.send(await toXlsx(m.def.label, columns, rows));
    }
    if (q.format === 'html' || q.format === 'pdf') {
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
      return sendHtmlOrPdf(res, q.format, this.print.render({
        company, title: m.def.label, fields: [['Printed', new Date().toLocaleString()], ['Rows', rows.length]],
        lines: { columns: columns.map(humanize), rows: rows.map((r) => columns.map((c) => cell(r, c))) },
      }), name);
    }
    return res.status(400).json({ message: 'Unknown format' });
  }

  @Get(':key/:id')
  get(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    return this.resources.get(user, key, id);
  }

  @Post(':key')
  create(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() body: Row) {
    return this.resources.create(user, key, body);
  }

  @Patch(':key/:id')
  update(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string, @Body() body: Row) {
    return this.resources.update(user, key, id, body);
  }

  @Delete(':key/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    return this.resources.remove(user, key, id);
  }

  @Post(':key/:id/restore')
  @HttpCode(204)
  restore(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    return this.resources.restore(user, key, id);
  }

  @Post(':key/:id/submit')
  submit(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    return this.workflow.submit(user, key, id);
  }

  @Get(':key/:id/approvals')
  approvals(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    return this.workflow.history(user, key, id);
  }

  /** Activity feed: audit entries + comments, newest first. */
  @Get(':key/:id/timeline')
  async timeline(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    await this.resources.get(user, key, id);
    const internal = can(user, `${key}.update`);
    const [audit, comments] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { companyId: user.companyId, entityType: key, entityId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.comment.findMany({ where: { companyId: user.companyId, entityType: key, entityId: id, ...(internal ? {} : { internal: false }) }, orderBy: { createdAt: 'desc' } }),
    ]);
    const userIds = [...new Set([...audit.map((a) => a.userId), ...comments.map((c) => c.userId)].filter((x): x is string => !!x))];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return [
      ...audit.map((a) => ({ kind: 'audit', at: a.createdAt, user: names.get(a.userId ?? ''), action: a.action, before: a.before, after: a.after })),
      ...comments.map((c) => ({ kind: 'comment', at: c.createdAt, user: names.get(c.userId), body: c.body, internal: c.internal })),
    ].sort((a, b) => +b.at - +a.at);
  }

  @Post(':key/:id/comments')
  async comment(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string, @Body() body: { body?: string; internal?: boolean }) {
    await this.resources.get(user, key, id);
    const text = parse(z.string().min(1).max(10_000), body.body);
    return this.prisma.comment.create({ data: { companyId: user.companyId, entityType: key, entityId: id, userId: user.id, body: text, internal: body.internal !== false } });
  }
}

@Controller('views')
export class SavedViewController {
  constructor(private prisma: PrismaService) {}

  @Get(':key')
  list(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.prisma.savedView.findMany({ where: { userId: user.id, resource: key }, orderBy: { createdAt: 'asc' } });
  }

  @Post(':key')
  create(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() body: { name: string; config: unknown }) {
    const b = parse(z.object({ name: z.string().min(1).max(100), config: z.record(z.unknown()) }), body);
    return this.prisma.savedView.create({ data: { companyId: user.companyId, userId: user.id, resource: key, name: b.name, config: b.config as Prisma.InputJsonValue } });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.savedView.deleteMany({ where: { id, userId: user.id } });
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private workflow: WorkflowService) {}

  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.workflow.inbox(user);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query('kind') kind: 'requested' | 'acted' = 'requested') {
    return this.workflow.mine(user, kind === 'acted' ? 'acted' : 'requested');
  }

  @Post(':id/:action')
  act(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('action') action: string, @Body() body: { comment?: string }) {
    if (!['approve', 'reject', 'return', 'comment'].includes(action)) throw new BadRequestException();
    return this.workflow.act(user, id, action as 'approve', body?.comment);
  }
}

@Controller('search')
export class SearchController {
  constructor(private prisma: PrismaService) {}

  private allowed(user: AuthUser) {
    return RESOURCES.filter((r) => can(user, `${r.key}.view`)).map((r) => r.key);
  }

  /** Global Ctrl+K search across every module the user can see. */
  @Get()
  async search(@CurrentUser() user: AuthUser, @Query('q') q = '', @Query('module') module?: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    // ponytail: LIKE scan over SearchIndex; switch to MATCH ... AGAINST (index exists) or Meilisearch past ~1M rows
    return this.prisma.searchIndex.findMany({
      where: {
        companyId: user.companyId, entityType: { in: this.allowed(user) }, ...(module ? { module } : {}),
        OR: [{ barcode: term }, { title: { contains: term } }, { subtitle: { contains: term } }, { keywords: { contains: term } }],
      },
      take: 30,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Barcode/QR scan: exact code → entity. Also resolves serial numbers and our own QR links. */
  @Get('scan')
  async scan(@CurrentUser() user: AuthUser, @Query('code') raw = '') {
    const code = raw.trim();
    const link = code.match(/\/r\/([\w.]+)\/(\w+)/);
    if (link && can(user, `${link[1]}.view`)) return [{ entityType: link[1], entityId: link[2], title: code }];
    const allowed = this.allowed(user);
    const hits = await this.prisma.searchIndex.findMany({ where: { companyId: user.companyId, entityType: { in: allowed }, OR: [{ barcode: code }, { title: code }] }, take: 20 });
    const unit = await unitByCode(this.prisma, user.companyId, code);
    const serials = unit ? [unit] : [];
    // A product's extra barcodes (one per line); `contains` narrows, the exact split confirms.
    const products = can(user, 'inventory.product.view') && !hits.some((h) => h.entityType === 'inventory.product')
      ? (await this.prisma.product.findMany({ where: { companyId: user.companyId, deletedAt: null, OR: [{ sku: code }, { barcodes: { contains: code } }] }, select: { id: true, name: true, sku: true, barcodes: true }, take: 10 }))
        .filter((p) => p.sku === code || (p.barcodes ?? '').split(/[\s,;]+/).includes(code)) : [];
    const jobs = (await this.prisma.job.findMany({ where: { companyId: user.companyId, OR: [{ serial: code }, { assetTag: code }], deletedAt: null }, select: { id: true, number: true, status: true, kind: true }, take: 10 }))
      .map((j) => ({ ...j, key: j.kind === 'fleet' ? 'fleet.maintenance' : 'repair.job' })).filter((j) => can(user, `${j.key}.view`));
    return [
      ...hits,
      ...products.map((p) => ({ entityType: 'inventory.product', entityId: p.id, title: p.name, subtitle: p.sku })),
      ...(can(user, 'serials.item.view') ? serials.map((s) => ({ entityType: 'serials.item', entityId: s.id, title: s.serial, subtitle: s.status })) : []),
      ...jobs.map((j) => ({ entityType: j.key, entityId: j.id, title: j.number, subtitle: j.status })),
    ];
  }
}

const uploadSchema = z.object({ entityType: z.string().max(100), entityId: z.string().max(100) });

@Controller('attachments')
export class AttachmentsController {
  constructor(private prisma: PrismaService, private storage: StorageService, private settings: SettingsService, private resources: ResourceService) {}

  /** Multipart upload (field `file`). Type comes from the bytes, limits from Settings › files. */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }))
  async upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    const b = parse(uploadSchema, body);
    if (!file?.buffer?.length) throw new BadRequestException('No file');
    assertCan(user, `${b.entityType}.update`);
    await this.resources.get(user, b.entityType, b.entityId);
    const limits = await this.settings.get(user.companyId, 'files');
    if (file.size > limits.maxMb * 1024 * 1024) throw new BadRequestException(`File is larger than ${limits.maxMb} MB`);
    const mimeType = sniff(file.buffer, file.mimetype);
    if (!mimeType || !limits.types.some((t) => mimeType.startsWith(t))) throw new BadRequestException(`File type not allowed (${file.mimetype || 'unknown'})`);
    const safeName = (file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
    const objectKey = `${user.companyId}/${b.entityType}/${b.entityId}/${randomUUID()}`;
    await this.storage.put(objectKey, file.buffer, mimeType);
    return this.prisma.attachment.create({ data: { companyId: user.companyId, ...b, objectKey, fileName: safeName, mimeType, size: file.size, uploadedBy: user.id } });
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('entityType') entityType: string, @Query('entityId') entityId: string) {
    await this.resources.get(user, entityType, entityId);
    return this.prisma.attachment.findMany({ where: { companyId: user.companyId, entityType, entityId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  /** Streams the file after checking the user can see its record. Images/PDF open inline; everything else downloads. */
  @Get(':id/file')
  async file(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const a = await this.prisma.attachment.findFirst({ where: { id, companyId: user.companyId, deletedAt: null } });
    if (!a) throw new NotFoundException();
    await this.resources.get(user, a.entityType, a.entityId);
    const inline = !download && (a.mimeType.startsWith('image/') || a.mimeType === 'application/pdf');
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Length', String(a.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    (await this.storage.stream(a.objectKey)).on('error', () => res.destroy()).pipe(res);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id, companyId: user.companyId, deletedAt: null } });
    if (!a) throw new NotFoundException();
    assertCan(user, `${a.entityType}.update`);
    await this.resources.get(user, a.entityType, a.entityId);
    await this.prisma.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  /**
   * Live push via Server-Sent Events (EventSource can't send headers, so the short-lived access token rides in the query).
   * ponytail: each stream polls the DB every 5s; switch to a pub/sub fan-out if thousands of users stay connected.
   */
  @Public()
  @Sse('stream')
  async stream(@Query('token') token = ''): Promise<Observable<MessageEvent>> {
    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    let since = new Date();
    return interval(5_000).pipe(
      startWith(0),
      switchMap(() => from(this.prisma.notification.findMany({ where: { userId: payload.sub, createdAt: { gt: since } }, orderBy: { createdAt: 'asc' } }))),
      filter((rows) => rows.length > 0),
      map((rows) => {
        since = rows[rows.length - 1].createdAt;
        return { data: rows };
      }),
    );
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post('read')
  @HttpCode(204)
  async read(@CurrentUser() user: AuthUser, @Body() body: { ids?: string[] }) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null, ...(body?.ids ? { id: { in: body.ids } } : {}) }, data: { readAt: new Date() } });
  }
}

@Controller('print')
export class PrintController {
  constructor(private resources: ResourceService, private prisma: PrismaService, private print: PrintService, private storage: StorageService) {}

  @Get(':key/:id')
  async doc(
    @CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string, @Res() res: Response,
    @Query('size') size: PaperSize = 'a4', @Query('template') template?: string, @Query('format') format?: string,
    @Query('codes') codes?: string, @Query('copies') copies?: string, @Query('code') code?: string,
  ) {
    const html = await this.html(user, key, id, size, template, { codes, copies, qr: code === 'qr' });
    return sendHtmlOrPdf(res, format, html, `${key}-${id}`, isPage(size) ? undefined : Number(size));
  }

  /** Printable HTML for any record (also used to attach PDFs to emails). */
  async html(user: AuthUser, key: string, id: string, size: PaperSize = 'a4', template?: string, opts: { codes?: string; copies?: string; qr?: boolean } = {}): Promise<string> {
    assertCan(user, `${key}.print`);
    const m = this.resources.meta(key);
    const rec = await this.resources.get(user, key, id);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    const web = process.env.WEB_URL ?? 'http://localhost:3000';
    let qr = `${web}/r/${key}/${id}`;
    if (key === 'repair.job') qr = `${web}/track/${(await this.prisma.job.findUniqueOrThrow({ where: { id } })).trackToken}`;
    const title = String(rec[m.def.title] ?? '');
    const code = m.def.barcode ? String(rec[m.def.barcode] ?? '') : title;

    // Product labels: every barcode it has (main + extras; SKU when it has none), or the ones picked, × copies.
    if (template === 'labels' && key === 'inventory.product') {
      const own = [...new Set([rec.barcode, ...String(rec.barcodes ?? '').split(/[\s,;]+/)].map((x) => String(x ?? '').trim()).filter(Boolean))];
      const picked = opts.codes ? opts.codes.split(',').map((x) => x.trim()).filter((x) => own.includes(x)) : own;
      const n = Math.min(Math.max(Math.trunc(Number(opts.copies) || 1), 1), 200);
      return this.print.labels(String(rec.name), [rec.sku, [rec.brand, rec.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '), picked.length ? picked : [String(rec.sku)], n, opts.qr);
    }
    if (template === 'label') return (this.print.label(title, String(m.def.subtitle ? cell(rec, m.def.subtitle) : m.def.label), code || id));
    if (template === 'idcard') {
      const photo = rec.photo ? await this.prisma.attachment.findFirst({ where: { id: String(rec.photo), companyId: user.companyId } }) : null;
      // Photo is embedded (data URL) so the card prints and renders to PDF without reaching storage.
      const photoUrl = photo?.mimeType.startsWith('image/') ? `data:${photo.mimeType};base64,${(await this.storage.read(photo.objectKey)).toString('base64')}` : null;
      const em = (rec.emergency ?? {}) as { name?: string; phone?: string; relation?: string };
      return this.print.idCard({
        company, name: String(rec.name), code: String(rec.code), photoUrl, qr: String(rec.qrToken ?? rec.code),
        designation: rec.designationId ? String(cell(rec, 'designationId')) : undefined, department: rec.departmentId ? String(cell(rec, 'departmentId')) : undefined,
        branch: rec.branchId ? String(cell(rec, 'branchId')) : undefined, joinDate: rec.joinDate as Date | null, phone: rec.phone as string | null, cnic: rec.cnic as string | null,
        emergency: [em.name, em.relation && `(${em.relation})`, em.phone].filter(Boolean).join(' ') || undefined,
      });
    }

    // Only what a customer should read: no internal ids, empty values or JSON blobs.
    const refs = (rec._refs ?? {}) as Row;
    const skip = new Set([m.def.title, 'lines', 'status', 'journalId', 'booked', 'approvedTotal', 'reimbursed', 'trackToken', 'custom', 'kind', 'sourceType', 'sourceId', ...(m.def.hidden ?? [])]);
    const money = new Set(['subtotal', 'discount', 'tax', 'total', 'paid', 'credited']);
    // Zero amounts/counts and "No" flags are noise on a customer document.
    const zeroMoney = (f: { name: string; type: string }) => (['money', 'decimal', 'int'].includes(f.type) && Number(rec[f.name] ?? 0) === 0) || (f.type === 'bool' && rec[f.name] !== true);
    const listField = (f: { name: string; type: string }) => f.type === 'json' && Array.isArray(rec[f.name]) && (rec[f.name] as unknown[]).every((x) => typeof x === 'string') && (rec[f.name] as unknown[]).length > 0;
    const shown = (f: { name: string; type: string }) => !skip.has(f.name) && !money.has(f.name) && (f.type !== 'json' || listField(f)) && !zeroMoney(f) && !(f.name.endsWith('Id') && !refs[f.name]);
    const profile = PRINT_PROFILES[key];
    const named = m.fields.filter(shown).filter((f) => f.name !== m.def.amountField || rec.total !== undefined)
      .map((f): [string, string, unknown] => [f.name, humanize(f.name), printValue(rec, f)])
      .filter(([, , v]) => v !== '' && v !== null && v !== undefined && v !== 'Undefined');
    // Grouped per the module's print profile; anything the profile doesn't mention still prints under "Other details".
    const used = new Set<string>(['branchId', ...(profile?.party ? [profile.party.field] : [])]);
    const sections: [string, [string, unknown][]][] = (profile?.sections ?? []).map(([t, names]) => {
      names.forEach((n) => used.add(n));
      return [t, names.map((n) => named.find(([x]) => x === n)).filter((x) => !!x).map(([, l, v]) => [l, v] as [string, unknown])];
    });
    const rest = named.filter(([n]) => !used.has(n)).map(([, l, v]): [string, unknown] => [l, v]);
    if (rest.length) sections.push([profile ? 'Other details' : 'Details', rest]);
    // Settlement split (payment vouchers) prints as its own block.
    const breakdown = rec.breakdown as Record<string, unknown> | null | undefined;
    if (breakdown && typeof breakdown === 'object') sections.push(['Settlement', Object.entries(breakdown).map(([k, v]): [string, unknown] => [humanize(k), typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v])]);
    // Bench test results (repair jobs) print as their own block.
    const qc = rec.testResults as Record<string, unknown> | null | undefined;
    if (qc && typeof qc === 'object') {
      const unit: Record<string, string> = { rfPowerW: ' W', freqErrorHz: ' Hz' };
      const rows: [string, unknown][] = [['QC result', qc.pass ? 'PASS' : 'FAIL']];
      for (const [k, label] of [['rfPowerW', 'RF output'], ['rxSensitivity', 'RX sensitivity'], ['freqErrorHz', 'Freq. error'], ['vswr', 'VSWR'], ['audioOk', 'Audio'], ['firmwareAfter', 'Firmware (after)'], ['by', 'Tested by']] as const) {
        const v = qc[k];
        if (v !== null && v !== undefined && v !== '') rows.push([label, typeof v === 'boolean' ? (v ? 'OK' : 'Fail') : `${v}${unit[k] ?? ''}`]);
      }
      sections.push(['Bench test', rows]);
    }
    const status = humanize(String(rec.status ?? ''));
    // Thermal slips keep the flat list.
    const fields: [string, unknown][] = [...(status ? [['Status', status] as [string, unknown]] : []), ...sections.flatMap(([, r]) => r)];
    // The counter-party's own details for the "To" box (read directly: printing an invoice shouldn't need customer-view rights).
    let party: { label: string; lines: string[] } | undefined;
    const pf = profile?.party?.field;
    const pRef = pf ? m.fields.find((f) => f.name === pf)?.ref : undefined;
    if (pf && pRef && rec[pf]) {
      const pr = await delegate(this.prisma, this.resources.meta(pRef).def.model.replace(/^./, (c) => c.toLowerCase())).findFirst({ where: { id: String(rec[pf]), companyId: user.companyId } });
      if (pr) party = { label: profile!.party!.label, lines: [String(pr.name ?? ''), pr.contactName && `Attn: ${pr.contactName}`, pr.address, [pr.phone, pr.email].filter(Boolean).join(' · '), pr.taxId && `NTN ${pr.taxId}`, pr.code && `Code ${pr.code}`].filter(Boolean).map(String) };
    }
    if (!party && rec.partyName) party = { label: 'Party', lines: [String(rec.partyName), rec.contactPerson, rec.contactPhone].filter(Boolean).map(String) };
    const lineRows = (Array.isArray(rec.lines) ? rec.lines : Array.isArray(rec.parts) ? rec.parts : []) as Row[];
    // Linked columns print by name (account, employee…) when every row has one; raw ids never print.
    const named_ = (r: Row, c: string) => { const v = (r._refs as Row | undefined)?.[c]; return typeof v === 'string' && v !== '—'; };
    let lineCols = lineRows.length
      ? Object.keys(lineRows[0]).filter((c) => c !== '_refs' && c !== 'refId' && c !== 'kind' && !['companyId', 'entryId', 'claimId', 'date'].includes(c) && (!/(^id|Id)$/.test(c) || c === 'productId' || lineRows.some((r) => named_(r, c))) && lineRows.some((r) => r[c] !== null && r[c] !== '' && Number(r[c]) !== 0))
      : [];
    // A journal reads account first, then debit and credit.
    if (lineCols.includes('debit')) lineCols = [...lineCols.filter((c) => c === 'accountId'), ...lineCols.filter((c) => !['accountId', 'debit', 'credit'].includes(c)), 'debit', 'credit'];
    // Priced lines (quotations, invoices) read: description, qty, price, amount.
    if (lineCols.includes('qty') && lineCols.includes('price')) {
      for (const r of lineRows) r.amount = (Number(r.qty) || 0) * (Number(r.price) || 0);
      const first = lineCols.filter((c) => ['description', 'productId'].includes(c));
      lineCols = [...first, ...lineCols.filter((c) => !first.includes(c) && c !== 'qty' && c !== 'price'), 'qty', 'price', 'amount'];
    }
    const num = (v: unknown) => Number(v ?? 0) || 0;
    const receipt = lineRows.map((r) => {
      const qty = num(r.qty) || 1;
      const price = num(r.price ?? r.unitPrice ?? r.amount);
      const lineRefs = Object.values((r._refs as Row | undefined) ?? {}).filter((x) => x && x !== '—');
      const desc = String(r.description || (r._refs as Row | undefined)?.productId || lineRefs[0] || r.serial || r.name || '');
      return { desc, qty, price, amount: r.price !== undefined || r.unitPrice !== undefined ? qty * price : num(r.amount) + num(r.tax) };
    });
    const fmt = (v: unknown) => Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const totals: [string, unknown][] = ['subtotal', 'discount', 'tax', 'paid', 'credited'].filter((k) => num(rec[k]) !== 0).map((k): [string, unknown] => [humanize(k), fmt(rec[k])]);
    const journal = lineCols.includes('debit');
    if (journal) {
      totals.push(['Total debit', fmt(lineRows.reduce((t, r) => t + num(r.debit), 0))], ['Total credit', fmt(lineRows.reduce((t, r) => t + num(r.credit), 0))]);
    } else if (rec.approvedTotal != null || rec.reimbursed !== undefined) {
      // Claims: what was asked, what was allowed, what has been paid, what is still owed.
      const approved = num(rec.approvedTotal ?? rec.total);
      totals.push(['Claimed', fmt(rec.total)]);
      if (rec.approvedTotal != null) totals.push(['Approved', fmt(approved)]);
      if (num(rec.fromAdvance)) totals.push(['From advance', fmt(rec.fromAdvance)]);
      if (num(rec.reimbursed)) totals.push(['Reimbursed', fmt(rec.reimbursed)]);
      totals.push(['Still owed', fmt(Math.max(approved - num(rec.fromAdvance) - num(rec.reimbursed), 0))]);
    } else if (rec.total !== undefined) {
      totals.splice(totals.findIndex(([k]) => k === 'Paid') >= 0 ? totals.findIndex(([k]) => k === 'Paid') : totals.length, 0, ['Total', fmt(rec.total)]);
      if (rec.paid !== undefined) totals.push(['Balance due', fmt(num(rec.total) - num(rec.paid) - num(rec.credited))]);
    } else if (m.def.amountField && rec[m.def.amountField] !== undefined) totals.push([humanize(m.def.amountField), fmt(rec[m.def.amountField])]);

    // Repair documents carry the equipment they are about, read from the job(s): the intake lists every unit handed in,
    // a quotation/invoice shows the device, serial, reported fault and findings it prices.
    if (['repair.intake', 'repair.quotation', 'repair.invoice', 'repair.job'].includes(key)) {
      const intakeId = key === 'repair.intake' ? id : (rec.intakeId as string | null);
      const jobs = key === 'repair.job' ? [rec] : rec.jobId
        ? await this.prisma.job.findMany({ where: { id: String(rec.jobId), companyId: user.companyId } })
        : intakeId ? await this.prisma.job.findMany({ where: { intakeId, companyId: user.companyId, deletedAt: null }, orderBy: { number: 'asc' } }) : [];
      const device = (j: Row) => [j.brand, j.model, j.productType && `(${j.productType})`].filter(Boolean).join(' ');
      const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
      const cond = (j: Row) => String((j.condition as { notes?: string } | null)?.notes ?? '');
      const findings = (j: Row) => String((j.diagnosis as { findings?: string } | null)?.findings ?? '');
      if (key === 'repair.intake') {
        for (const j of jobs as Row[]) lineRows.push({ job: j.number, equipment: device(j), serial: [j.serial, j.assetTag].filter(Boolean).join(' / '), accessories: list(j.accessories) || 'None', condition: cond(j) || 'As received', fault: j.fault, warranty: j.warranty ? 'Yes' : 'No', promised: j.expectedAt ? String((j.expectedAt as Date).toISOString?.() ?? j.expectedAt).slice(0, 10) : '' });
        lineCols = ['job', 'equipment', 'serial', 'accessories', 'condition', 'fault', 'warranty', 'promised'].filter((c) => lineRows.some((r) => r[c]));
        sections.unshift(['Summary', [['Units received', jobs.length], ['Warranty claims', (jobs as Row[]).filter((j) => j.warranty).length || 'None']]]);
      } else if (key === 'repair.job') {
        const extra: [string, unknown][] = [['Condition on arrival', cond(rec)], ['Findings', findings(rec)], ['Warranty', rec.warranty ? 'Yes' : '']].filter(([, v]) => v) as [string, unknown][];
        const fw = sections.find(([t]) => t === 'Fault & work');
        if (fw) fw[1].push(...extra); else if (extra.length) sections.push(['Fault & work', extra]);
      } else if (jobs.length === 1) {
        const j = jobs[0] as Row;
        sections.unshift(['Equipment', ([['Device', device(j)], ['Serial', j.serial], ['Asset tag', j.assetTag], ['Accessories', list(j.accessories)], ['Reported fault', j.fault], ['Findings', findings(j)], ['Warranty', j.warranty ? 'Yes' : '']] as [string, unknown][]).filter(([, v]) => v)]);
      } else if (jobs.length > 1) {
        sections.unshift(['Equipment', (jobs as Row[]).map((j): [string, unknown] => [String(j.number), [device(j), j.serial && `S/N ${j.serial}`, j.fault].filter(Boolean).join(' · ')])]);
      }
    }

    const custom = await this.prisma.template.findFirst({ where: { companyId: user.companyId, kind: 'print', key, deletedAt: null } });
    if (custom) {
      const vars: Record<string, unknown> = { ...Object.fromEntries(Object.keys(rec).map((k) => [k, cell(rec, k)])), company: company.name, qr: this.print.qrSvg(qr) };
      return this.print.fill(custom.body, vars);
    }
    const grand = rec.total !== undefined ? num(rec.approvedTotal ?? rec.total) : m.def.amountField ? num(rec[m.def.amountField]) : 0;
    const when = (rec.date ?? rec.createdAt) as Date | undefined;
    return this.print.render({
      company, title: profile?.title ?? m.def.label.replace(/s$/, ''), number: title, fields, size, qr, barcode: m.def.barcode ? code : undefined,
      status: status || undefined, branch: rec.branchId ? String(cell(rec, 'branchId')) : undefined, date: when instanceof Date ? when.toISOString().slice(0, 10) : undefined, party, sections,
      words: profile?.words && grand ? amountInWords(grand, company.currency) : undefined, note: profile?.note, printedBy: user.name,
      // Thermal slips still get plain signature lines for money documents.
      signatures: profile?.signatures, footer: !isPage(size) && key === 'repair.job' ? 'Scan to track your repair' : undefined,
      lines: lineRows.length ? { columns: lineCols.map(humanize), rows: lineRows.map((r) => lineCols.map((c) => (['qty', 'price', 'amount', 'approved', 'tax'].includes(c) ? fmt(r[c]) : ['debit', 'credit'].includes(c) ? (num(r[c]) ? fmt(r[c]) : '') : cell(r, c)))) } : undefined,
      receipt: receipt.some((l) => l.desc || l.amount) ? receipt : undefined,
      totals: totals.length ? totals : undefined,
    });
  }
}

/** One field as a printed document shows it: money with separators, types and directions in words. */
function printValue(rec: Row, f: { name: string; type: string }): unknown {
  const v = rec[f.name];
  if (f.type === 'enum') return humanize(String(v ?? ''));
  if ((f.type === 'money' || f.type === 'decimal') && v !== null && v !== undefined && v !== '') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (/(ref|source)Type$/.test(f.name) && typeof v === 'string') return v === 'payables.due' ? 'Payable / receivable' : RESOURCE_MAP[v]?.label.replace(/s$/, '') ?? humanize(v);
  if (f.name === 'direction') return v === 'in' ? 'Received' : v === 'out' ? 'Paid out' : v;
  if (f.name === 'partyType') return v === 'other' ? '' : humanize(String(v ?? ''));
  return cell(rec, f.name);
}

/** Stopwatch time tracking on any record (repair jobs, tasks…). One running timer per user. */
@Controller('time')
export class TimeController {
  constructor(private prisma: PrismaService, private resources: ResourceService) {}

  @Get(':key/:id')
  async list(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    await this.resources.get(user, key, id);
    const logs = await this.prisma.timeLog.findMany({ where: { companyId: user.companyId, entityType: key, entityId: id }, orderBy: { startedAt: 'desc' } });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: logs.map((l) => l.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return { total: logs.reduce((s, l) => s + l.minutes, 0), running: logs.find((l) => !l.endedAt && l.userId === user.id) ?? null, logs: logs.map((l) => ({ ...l, user: names.get(l.userId) })) };
  }

  @Post(':key/:id/start')
  async start(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('id') id: string) {
    assertCan(user, `${key}.update`);
    await this.resources.get(user, key, id);
    await this.stopRunning(user.id);
    return this.prisma.timeLog.create({ data: { companyId: user.companyId, entityType: key, entityId: id, userId: user.id, startedAt: new Date() } });
  }

  @Post('stop')
  async stop(@CurrentUser() user: AuthUser, @Body() body: { note?: string }) {
    return { stopped: await this.stopRunning(user.id, body?.note) };
  }

  private async stopRunning(userId: string, note?: string) {
    const open = await this.prisma.timeLog.findMany({ where: { userId, endedAt: null } });
    for (const l of open) {
      const endedAt = new Date();
      await this.prisma.timeLog.update({ where: { id: l.id }, data: { endedAt, minutes: Math.max(1, Math.round((+endedAt - +l.startedAt) / 60_000)), note } });
    }
    return open.length;
  }
}

export const ENGINE_CONTROLLERS = [TimeController, MetaController, ResourceController, SavedViewController, ApprovalsController, SearchController, AttachmentsController, NotificationsController, PrintController];

