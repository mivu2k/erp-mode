import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, HttpCode, Put, Query, Res } from '@nestjs/common';
import bwipjs from 'bwip-js';
import type { Response } from 'express';
import PptxGenJS from 'pptxgenjs';
import { sendHtmlOrPdf } from '../engine/export';
import { HooksService } from '../engine/hooks';
import { ResourceService } from '../engine/resource.service';
import { esc, PrintService } from '../platform/print.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { z } from 'zod';
import { parse } from '../engine/resource.service';
import { StorageService } from '../platform/storage.service';
import { assertCan, AuthUser, CurrentUser } from '../rbac/rbac';

/** "one per line" text → list (blank lines and bullet characters dropped). */
export const lines = (t: unknown): string[] =>
  String(t ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*[-•*·]\s*/, '').trim()).filter(Boolean);

/** Spec lines "Label: value" (or "Label = value") → pairs; lines without a separator become a full-width note. */
export const specPairs = (t: unknown): [string, string][] =>
  lines(t).map((l) => {
    const m = l.match(/^([^:=]{1,60})[:=]\s*(.+)$/);
    return m ? [m[1].trim(), m[2].trim()] : ['', l];
  });

/** Normalised entry for brochures/decks — from a catalog item or straight from an inventory product. */
export interface Entry {
  name: string; code: string; kind: string; category: string; tagline: string; summary: string; description: string;
  features: string[]; specs: [string, string][]; benefits: string[]; applications: string[]; price: number | null; imageIds: string[];
  /** Per-item custom page and CSS (already sanitised); `slug` is the class that scopes the CSS to this item's pages. */
  slug?: string; customHtml?: string; customCss?: string;
}

/**
 * Comparison rows for several entries: the spec labels most items share (up to `max`), each with every entry's value.
 * Labels only one item has are left out so the table stays readable.
 */
export function comparison(entries: Entry[], max = 10): { label: string; values: string[] }[] {
  const count = new Map<string, number>();
  for (const e of entries) for (const [k] of e.specs) if (k) count.set(k.toLowerCase(), (count.get(k.toLowerCase()) ?? 0) + 1);
  const labels = [...count.entries()].filter(([, n]) => n > 1 || entries.length === 1).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
  return labels.map((l) => ({
    label: entries.flatMap((e) => e.specs).find(([k]) => k.toLowerCase() === l)![0],
    values: entries.map((e) => e.specs.find(([k]) => k.toLowerCase() === l)?.[1] ?? '—'),
  }));
}

export interface Location { name: string; address: string; phone: string; email: string }
/** Location lines "Name | address | phone | email" (missing parts allowed). */
export const locationLines = (t: unknown): Location[] =>
  lines(t).map((l) => {
    const [name = '', address = '', phone = '', email = ''] = l.split('|').map((x) => x.trim());
    return { name, address, phone, email };
  });

/** Parses "c:id,p:id,id" (plain id = catalog item) into ordered refs. */
export function parseRefs(raw: string | undefined): { type: 'c' | 'p'; id: string }[] {
  const seen = new Set<string>();
  return String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [t, id] = x.includes(':') ? x.split(':') : ['c', x];
    return { type: (t === 'p' ? 'p' : 'c') as 'c' | 'p', id };
  }).filter((r) => r.id && !seen.has(`${r.type}:${r.id}`) && seen.add(`${r.type}:${r.id}`)).slice(0, 40);
}

interface Brand { name: string; phone?: string | null; email?: string | null; website?: string | null; address?: string | null; logo?: string; logoDark?: string; primary: string }
interface Opts { title?: string; subtitle?: string; theme: 'editorial' | 'modern' | 'light'; prices: 'item' | 'show' | 'hide'; about: boolean; locations: boolean; compare: boolean; custom: boolean; perPage: 1 | 2 | 3; intro?: string }
interface About { intro: string; mission: string; highlights: [string, string][]; certifications: string[]; locations: Location[]; photo: string; customCss: string; customHtml: string }

/**
 * Custom brochure HTML is display markup only: scripts, frames, embeds, forms, <meta>/<base>/<link>, event handlers and
 * javascript: URLs are removed. The page's CSP (below) is the real guard; this keeps the saved markup honest.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|form|input|button|textarea|select|link|meta|base|template|noscript)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '');
}
/** Rich-text fields hold HTML; older/plain entries are text. */
export const isHtml = (s: string) => /<\/?[a-z][^>]*>/i.test(s);
/** Plain text of a rich field (PowerPoint, clamping). */
export const plainText = (s: string) => (isHtml(s) ? s.replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() : s);
/** A rich field for the brochure: sanitised HTML, or escaped (and clamped) text. */
const richOrText = (s: string, max: number) => (isHtml(s) ? `<div class="rich">${sanitizeHtml(s)}</div>` : esc(s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s));

/** Custom CSS can't break out of its <style> or pull in remote stylesheets. */
export function sanitizeCss(css: string): string {
  return css.replace(/<\/?style/gi, '').replace(/<\//g, '').replace(/@import[^;]*;?/gi, '');
}
/** Only inline styles, data: images/fonts and the Print button's handler may run — also inside a blob: window. */
const PRINT_HASH = createHash('sha256').update('print()').digest('base64');
export const BROCHURE_CSP = `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-hashes' 'sha256-${PRINT_HASH}'; base-uri 'none'; form-action 'none'`;

@Controller('catalog')
export class CatalogController {
  constructor(private prisma: PrismaService, private resources: ResourceService, private storage: StorageService, private settings: SettingsService, hooks: HooksService) {
    // Item HTML/CSS is display-only, cleaned on save (and again when rendered).
    const clean = (_c: unknown, data: Record<string, unknown>) => {
      for (const k of ['customHtml', 'summary', 'description']) if (typeof data[k] === 'string') data[k] = sanitizeHtml(data[k] as string).slice(0, 200_000);
      if (typeof data.customCss === 'string') data.customCss = sanitizeCss(data.customCss).slice(0, 20_000);
    };
    hooks.on('catalog.item', { beforeCreate: clean, beforeUpdate: clean });
  }

  /** Loads the selected entries in the chosen order (permission and data scope apply per record). */
  private async load(user: AuthUser, q: Record<string, string | undefined>, perm: string) {
    assertCan(user, perm);
    const refs = parseRefs(q.items ?? q.ids);
    if (!refs.length) throw new BadRequestException('Select at least one item');
    const opts: Opts = {
      title: q.title?.slice(0, 120), subtitle: q.subtitle?.slice(0, 200), theme: q.theme === 'light' || q.theme === 'modern' ? q.theme : 'editorial', prices: q.prices === 'show' || q.prices === 'hide' ? q.prices : 'item',
      about: q.about !== '0', locations: q.locations !== '0', compare: q.compare !== '0', custom: q.custom !== '0', perPage: q.perPage === '2' ? 2 : q.perPage === '3' ? 3 : 1, intro: q.intro?.slice(0, 3000) || undefined,
    };
    const entries: Entry[] = [];
    for (const r of refs) {
      if (r.type === 'c') {
        const it = await this.resources.get(user, 'catalog.item', r.id);
        const priceOk = opts.prices === 'show' || (opts.prices === 'item' && it.showPrice === true);
        entries.push({
          name: String(it.name), code: String(it.code ?? ''), kind: String(it.kind ?? ''), category: String(it.category ?? ''), tagline: String(it.tagline ?? ''),
          summary: String(it.summary ?? ''), description: String(it.description ?? ''), features: lines(it.features), specs: specPairs(it.specs),
          benefits: lines(it.benefits), applications: lines(it.applications), price: priceOk && it.price != null ? Number(it.price) : null,
          imageIds: Array.isArray(it.images) ? (it.images as string[]) : [],
          slug: `ci-${entries.length}`,
          customHtml: opts.custom && it.customHtml ? sanitizeHtml(String(it.customHtml)) : '', customCss: opts.custom && it.customCss ? sanitizeCss(String(it.customCss)) : '',
        });
      } else {
        const p = await this.resources.get(user, 'inventory.product', r.id);
        const refsP = (p._refs ?? {}) as Record<string, string | null>;
        entries.push({
          name: String(p.name), code: String(p.sku ?? ''), kind: 'product', category: refsP.categoryId ?? '', tagline: [p.brand, p.model].filter(Boolean).join(' '),
          summary: '', description: String(p.compatible ?? ''), features: [], applications: [], benefits: [],
          specs: ([['SKU', p.sku], ['Brand', p.brand], ['Model', p.model], ['Category', refsP.categoryId], ['Unit', refsP.unitId], ['Warranty', Number(p.warrantyMonths) ? `${p.warrantyMonths} months` : null]] as [string, unknown][])
            .filter(([, v]) => v).map(([k, v]) => [k, String(v)] as [string, string]),
          // Products have no per-item "show price" flag: their list price appears only when prices are switched on.
          price: opts.prices === 'show' && p.price != null ? Number(p.price) : null,
          imageIds: Array.isArray(p.images) ? (p.images as string[]) : [],
        });
      }
    }
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    const b = (c.branding ?? {}) as Record<string, string>;
    const brand: Brand = { name: c.name, phone: c.phone, email: c.email, website: c.website, address: c.address, logo: b.logo || b.logoDark || undefined, logoDark: b.logoDark || b.logo || undefined, primary: b.primary || '#2563eb' };
    const a = await this.settings.get(user.companyId, 'catalog.about');
    const about: About = {
      intro: opts.intro ?? a.intro, mission: a.mission, highlights: specPairs(a.highlights).filter(([k]) => k), certifications: lines(a.certifications),
      locations: locationLines(a.locations), photo: /^data:image\/(png|jpeg|webp);base64,/.test(a.photo) ? a.photo : '',
      customCss: opts.custom ? sanitizeCss(a.customCss ?? '') : '', customHtml: opts.custom ? sanitizeHtml(a.customHtml ?? '') : '',
    };
    // Sections appear only when switched on and there is something to show.
    const showAbout = opts.about && !!(about.intro || about.mission || about.highlights.length || about.certifications.length);
    const showLocations = opts.locations && about.locations.length > 0;
    return { entries, brand, opts, about, showAbout, showLocations };
  }

  /** Company introduction used in every brochure/deck. */
  @Get('about')
  async getAbout(@CurrentUser() user: AuthUser) {
    assertCan(user, 'catalog.item.view');
    return this.settings.get(user.companyId, 'catalog.about');
  }

  @Put('about')
  @HttpCode(204)
  async setAbout(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    assertCan(user, 'catalog.item.update');
    const v = parse(z.object({
      intro: z.string().max(4000).default(''), mission: z.string().max(2000).default(''), highlights: z.string().max(2000).default(''),
      certifications: z.string().max(2000).default(''), locations: z.string().max(4000).default(''),
      photo: z.string().max(1_200_000).refine((x) => x === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x), 'Photo must be a PNG, JPEG or WebP image').default(''),
      customCss: z.string().max(20_000).default('').transform(sanitizeCss),
      customHtml: z.string().max(200_000).default('').transform(sanitizeHtml),
    }), body);
    await this.settings.set(user.companyId, 'catalog.about', v);
  }

  /** Item images as data URLs, so the brochure/PDF/pptx is self-contained. */
  private async images(user: AuthUser, ids: string[], max = 4): Promise<string[]> {
    const list = ids.slice(0, max);
    if (!list.length) return [];
    const atts = await this.prisma.attachment.findMany({ where: { id: { in: list }, companyId: user.companyId, deletedAt: null, mimeType: { startsWith: 'image/' } } });
    const byId = new Map(atts.map((a) => [a.id, a]));
    const out: string[] = [];
    for (const id of list) {
      const a = byId.get(id);
      if (a) out.push(`data:${a.mimeType};base64,${(await this.storage.read(a.objectKey)).toString('base64')}`);
    }
    return out;
  }

  private fmtPrice = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

  // ─── Brochure ──────────────────────────────────────────────

  /** Modern A4 brochure: cover mosaic, contents, magazine-style item pages, comparison, back cover with QR. */
  @Get('brochure')
  async brochure(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>, @Res() res: Response) {
    const { entries, brand, opts, about, showAbout, showLocations } = await this.load(user, q, 'catalog.item.print');
    const imgs = await Promise.all(entries.map((e) => this.images(user, e.imageIds)));
    const multi = entries.length > 1;
    const title = opts.title || (multi ? 'Products & Solutions' : entries[0].name);
    const subtitle = opts.subtitle || (multi ? brand.name : entries[0].tagline);
    if (opts.theme === 'editorial') {
      const html = this.editorial(entries, imgs, brand, about, opts, title);
      return sendHtmlOrPdf(res, q.format, html, (multi ? 'catalogue' : `brochure-${entries[0].code || entries[0].name}`).replace(/[^\w-]+/g, '_'));
    }
    const pages: string[] = [];

    // A single item is a tight two-page brochure (front + details); several items get the full catalogue.
    if (!multi) pages.push(...this.singlePages(entries[0], imgs[0], brand, about, opts.theme === 'modern'));
    else {
    // Dark cover/back (modern) use the dark-background logo; light theme keeps the normal one.
    const darkLogo = opts.theme === 'modern' ? brand.logoDark : brand.logo;
    pages.push(`<section class="page cover">
  ${(() => { const hero = imgs.map((i) => i[0]).find(Boolean); return hero ? `<div class="cover-bg" style="background-image:url('${hero}')"></div>` : ''; })()}
  <div class="cover-shade"></div>
  <div class="cover-inner">${darkLogo ? `<img class="logo" src="${esc(darkLogo)}" alt="">` : `<div class="brand">${esc(brand.name)}</div>`}
    <div class="cover-title"><span class="eyebrow">${esc(multi ? `${entries.length} offerings` : [entries[0].kind, entries[0].category].filter(Boolean).join(' · '))}</span>
      <h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
    <div class="cover-foot">${esc(new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}${brand.website ? ` · ${esc(brand.website)}` : ''}</div></div>
</section>`);

    if (showAbout) {
      pages.push(`<section class="page about">
  ${about.photo ? `<div class="about-photo" style="background-image:url('${about.photo}')"></div>` : '<div class="about-photo none"></div>'}
  <div class="about-body"><span class="eyebrow">Who we are</span><h2>About ${esc(brand.name)}</h2>
    ${about.intro ? `<p class="lead">${esc(about.intro)}</p>` : ''}
    ${about.highlights.length ? `<div class="stats about-stats">${about.highlights.slice(0, 4).map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : ''}
    ${about.mission ? `<h3>Our mission</h3><blockquote>${esc(about.mission)}</blockquote>` : ''}
    ${about.certifications.length ? `<h3>Certifications &amp; accreditations</h3><div class="chips">${about.certifications.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
  </div>${this.footer(brand, pages.length + 1)}</section>`);
    }
    if (showLocations) {
      pages.push(`<section class="page locations"><span class="eyebrow">Where to find us</span><h2>Our locations</h2>
  <div class="loc-grid">${about.locations.map((l, i) => `<div class="loc${i === 0 ? ' hq' : ''}"><span class="pin">${i === 0 ? 'HQ' : String(i + 1).padStart(2, '0')}</span>
    <b>${esc(l.name)}</b>${l.address ? `<p>${esc(l.address)}</p>` : ''}${l.phone ? `<small>☎ ${esc(l.phone)}</small>` : ''}${l.email ? `<small>✉ ${esc(l.email)}</small>` : ''}</div>`).join('')}</div>
  ${this.footer(brand, pages.length + 1)}</section>`);
    }

    if (multi) {
      pages.push(`<section class="page contents"><span class="eyebrow">Inside</span><h2>Contents</h2>
  <ol class="toc">${entries.map((e, i) => `<li><span class="num">${String(i + 1).padStart(2, '0')}</span><div><b>${esc(e.name)}</b>${e.tagline ? `<small>${esc(e.tagline)}</small>` : ''}</div><span class="kind">${esc(e.kind)}</span></li>`).join('')}
  ${opts.compare ? `<li><span class="num">${String(entries.length + 1).padStart(2, '0')}</span><div><b>At a glance — comparison</b></div></li>` : ''}</ol>${this.footer(brand, 2)}</section>`);
    }

    entries.forEach((e, i) => {
      pages.push(this.itemPage(e, imgs[i], brand, i, pages.length + 1));
      // The item's own custom page follows it, carrying the same class so the item's CSS styles both.
      if (e.customHtml?.trim()) pages.push(`<section class="page custom ${e.slug}"><div class="custom-body">${e.customHtml}</div>${this.footer(brand, pages.length + 1)}</section>`);
    });

    if (multi && opts.compare) {
      const rows = comparison(entries);
      const hasPrice = entries.some((e) => e.price != null);
      pages.push(`<section class="page compare"><span class="eyebrow">At a glance</span><h2>Comparison</h2>
  <table class="cmp"><thead><tr><th></th>${entries.map((e) => `<th>${esc(e.name)}</th>`).join('')}</tr></thead><tbody>
  <tr><th>Type</th>${entries.map((e) => `<td>${esc(e.kind)}</td>`).join('')}</tr>
  ${rows.map((r) => `<tr><th>${esc(r.label)}</th>${r.values.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
  <tr><th>Highlights</th>${entries.map((e) => `<td>${e.features.slice(0, 3).map((f) => `<div>✓ ${esc(f)}</div>`).join('')}</td>`).join('')}</tr>
  ${hasPrice ? `<tr class="price-row"><th>Price</th>${entries.map((e) => `<td>${e.price != null ? this.fmtPrice(e.price) : 'On request'}</td>`).join('')}</tr>` : ''}
  </tbody></table>${this.footer(brand, pages.length + 1)}</section>`);
    }

    // Custom page (company-authored HTML), last before the back cover.
    if (about.customHtml.trim()) pages.push(`<section class="page custom"><div class="custom-body">${about.customHtml}</div>${this.footer(brand, pages.length + 1)}</section>`);

    const qr = brand.website ? new PrintService().qrSvg(brand.website.startsWith('http') ? brand.website : `https://${brand.website}`) : '';
    pages.push(`<section class="page back"><div class="back-inner">${darkLogo ? `<img class="logo" src="${esc(darkLogo)}" alt="">` : `<div class="brand">${esc(brand.name)}</div>`}
  <h2>Let's talk</h2><p>Talk to our team about configuration, pricing and delivery.</p>
  <ul class="contact-list">${[brand.phone, brand.email, brand.website, brand.address].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  ${qr ? `<div class="qr">${qr}<small>Scan to visit us</small></div>` : ''}</div></section>`);
    }

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${BROCHURE_CSP}"><title>${esc(title)} — brochure</title><style>${this.css(brand.primary, opts.theme)}
.page.custom{background:#fff;padding:0}.custom-body{padding:16mm 14mm 20mm}
.rich{white-space:normal}.rich p{margin:0 0 2mm}.rich h2,.rich h3{font-size:11pt;margin:3mm 0 1.5mm;text-transform:none;letter-spacing:0;color:inherit}.rich ul,.rich ol{margin:1mm 0 2mm;padding-left:5mm}.rich img{max-width:100%;border-radius:2mm}.rich blockquote{margin:2mm 0;padding-left:3mm;border-left:1mm solid #cbd5e1}
/* item HTML inside the single-item overview: flush, section-sized headings */
.s2 .overview.custom-body{padding:0}.s2 .overview h1,.s2 .overview h2{font-size:13pt;margin:0 0 3mm;line-height:1.2}.s2 .overview h3{margin-top:4mm}
/* company custom CSS */
${about.customCss}
/* per-item custom CSS, each nested under its item's class so it can't touch other pages */
${entries.filter((e) => e.customCss?.trim()).map((e) => `.${e.slug} {\n${e.customCss}\n}`).join('\n')}</style></head>
<body>${pages.join('')}<button class="noprint" onclick="print()">Print</button></body></html>`;
    return sendHtmlOrPdf(res, q.format, html, (multi ? 'catalogue' : `brochure-${entries[0].code || entries[0].name}`).replace(/[^\w-]+/g, '_'));
  }

  /**
   * Single-item brochure, exactly two A4 pages.
   * Front: brand bar, hero, key numbers, summary, features. Details: overview (plain text — or the item's own HTML/CSS),
   * specifications, applications, benefits, gallery, and a company strip (intro, highlights, contacts, QR).
   * Long lists are capped so nothing spills onto a third page.
   */
  private singlePages(e: Entry, imgs: string[], brand: Brand, about: About, dark = false): string[] {
    const [hero, ...gallery] = imgs;
    const stats = e.specs.filter(([k]) => k).slice(0, 3);
    const specs = e.specs.filter((s) => !stats.includes(s)).slice(0, 14);
    const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
    const qr = brand.website ? new PrintService().qrSvg(brand.website.startsWith('http') ? brand.website : `https://${brand.website}`) : '';
    const slug = e.slug ? ` ${e.slug}` : '';
    const overview = e.customHtml?.trim()
      ? `<div class="overview custom-body">${e.customHtml}</div>`
      : e.description ? `<h3>Overview</h3><div class="desc">${richOrText(e.description, 1400)}</div>` : '';
    const tone = dark ? ' dark' : '';
    const logo = dark ? brand.logoDark : brand.logo;
    const front = `<section class="page s1 item${tone}${slug}">
  <div class="s-bar">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : `<div class="brand">${esc(brand.name)}</div>`}<span>${esc([e.kind, e.category].filter(Boolean).join(' · '))}</span></div>
  <header class="item-hero s-hero${hero ? '' : ' no-img'}"${hero ? ` style="background-image:url('${hero}')"` : ''}>
    <div class="hero-shade"></div>
    <div class="hero-text"><h1>${esc(e.name)}</h1>${e.tagline ? `<p>${esc(e.tagline)}</p>` : ''}</div>
    ${e.price != null ? `<div class="price-tag">${this.fmtPrice(e.price)}</div>` : ''}
  </header>
  ${stats.length ? `<div class="stats">${stats.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : ''}
  ${e.summary ? `<div class="lead">${richOrText(e.summary, 600)}</div>` : ''}
  ${e.features.length ? `<h3>Key features</h3><div class="features">${e.features.slice(0, 8).map((f) => `<div class="feature"><i>✓</i><span>${esc(clamp(f, 120))}</span></div>`).join('')}</div>` : ''}
  ${e.applications.length ? `<h3>Where it's used</h3><div class="chips">${e.applications.slice(0, 10).map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
  ${this.footer(brand, 1)}
</section>`;
    const details = `<section class="page s2 item${tone}${slug}">
  <div class="two">
    <div>${overview}
      ${specs.length ? `<h3>Specifications</h3><table class="specs">${specs.map(([k, v]) => (k ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : `<tr><td colspan="2">${esc(v)}</td></tr>`)).join('')}</table>` : ''}</div>
    <div>${e.benefits.length ? `<h3>Benefits</h3><ul class="benefits">${e.benefits.slice(0, 6).map((b) => `<li>${esc(clamp(b, 140))}</li>`).join('')}</ul>` : ''}
      ${gallery.length ? `<div class="gallery">${gallery.slice(0, 4).map((g) => `<img src="${g}" alt="">`).join('')}</div>` : ''}</div>
  </div>
  <div class="s-company">
    <div class="s-about"><b>${esc(brand.name)}</b>${about.intro ? `<p>${esc(clamp(about.intro, 320))}</p>` : ''}
      ${about.highlights.length ? `<div class="s-hl">${about.highlights.slice(0, 4).map(([k, v]) => `<span><b>${esc(v)}</b> ${esc(k)}</span>`).join('')}</div>` : ''}</div>
    <div class="s-contact"><ul>${[brand.phone, brand.email, brand.website, about.locations[0]?.address ?? brand.address].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${qr ? `<div class="qr">${qr}</div>` : ''}</div>
  </div>
  ${this.footer(brand, 2)}
</section>`;
    return [front, details];
  }

  /**
   * Editorial theme (A4 landscape): white/grey pages, thin rules, category line + title-case headings,
   * photo grids, black text panels and black page-number squares. One item = two pages; several = full catalogue.
   */
  private editorial(entries: Entry[], imgs: string[][], brand: Brand, about: About, opts: Opts, title: string): string {
    const multi = entries.length > 1;
    const qr = brand.website ? new PrintService().qrSvg(brand.website.startsWith('http') ? brand.website : `https://${brand.website}`) : '';
    const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
    const num = (n: number) => `<span class="pn ${n % 2 ? 'r' : 'l'}">${String(n).padStart(2, '0')}</span>`;
    const img = (src: string | undefined, cls = '') => (src ? `<div class="ph ${cls}" style="background-image:url('${src}')"></div>` : `<div class="ph none ${cls}"></div>`);
    const pages: string[] = [];
    const add = (cls: string, body: string) => pages.push(`<section class="pg ${cls}">${body}${cls.includes('cover') || cls === 'backpage' ? '' : num(pages.length + 1)}</section>`);
    const specsTable = (e: Entry, max: number) => (e.specs.length ? `<table class="sp">${e.specs.slice(0, max).map(([k, v]) => `<tr>${k ? `<th>${esc(k)}</th><td>${esc(v)}</td>` : `<td colspan="2">${esc(v)}</td>`}</tr>`).join('')}</table>` : '');
    const panel = (heading: string, e: Entry) => `<div class="panel"><h4>${esc(heading)}</h4>${e.features.length ? `<ul>${e.features.slice(0, 7).map((f) => `<li>${esc(clamp(f, 90))}</li>`).join('')}</ul>` : `<p>${esc(clamp(plainText(e.summary), 380))}</p>`}${e.price != null ? `<div class="price">${this.fmtPrice(e.price)}</div>` : ''}</div>`;
    const text = (s: string, max: number) => (s ? `<div class="tx">${isHtml(s) ? `<div class="rich">${sanitizeHtml(s)}</div>` : `<p>${esc(clamp(s, max))}</p>`}</div>` : '');

    const eyebrow = (e: Entry) => [e.category, e.kind].filter(Boolean).map((x) => esc(x)).join(' · ');
    const miniSpecs = (e: Entry, n: number) => (e.specs.length ? `<table class="sp mini">${e.specs.filter(([k]) => k).slice(0, n).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : '');
    const priceTag = (e: Entry) => (e.price != null ? `<span class="pt">${this.fmtPrice(e.price)}</span>` : '');

    // Cover (catalogues only — a single product stays at two pages)
    if (multi) add('cover', `<div class="band">${img(imgs.find((i) => i[0])?.[0], 'cover-img')}
      <div class="ct"><span class="ey">${esc(brand.name)}</span><h1>${esc(opts.title || 'Product Catalogue')}</h1>${opts.subtitle ? `<p>${esc(opts.subtitle)}</p>` : ''}</div></div>
      ${brand.logo ? `<img class="logo" src="${esc(brand.logo)}" alt="">` : `<div class="brand">${esc(brand.name)}</div>`}
      <div class="url">${esc([new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), brand.website].filter(Boolean).join('  ·  '))}</div>`);

    if (multi) {
      // Introduction + contents
      add('intro', `<div class="col l"><span class="ey">About us</span><h2>${esc(brand.name)}</h2><div class="rule2"></div>${about.intro ? `<p class="lead">${esc(clamp(about.intro, 900))}</p>` : ''}
        ${about.mission ? `<p class="quote">“${esc(clamp(about.mission, 220))}”</p>` : ''}
        ${about.highlights.length ? `<div class="hl">${about.highlights.slice(0, 4).map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : ''}</div>
        <div class="col r">${(() => {
          // Photo grid from every item's images (heroes first); sized to what exists, no empty tiles.
          const pics = [...imgs.map((x) => x[0]), ...imgs.flatMap((x) => x.slice(1))].filter(Boolean).slice(0, 4);
          return pics.length ? `<div class="grid4 n${pics.length}">${pics.map((p) => img(p)).join('')}</div>` : '';
        })()}
        <h3 class="sec">Contents</h3><ol class="toc">${entries.map((e, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${esc(e.name)}</li>`).join('')}</ol></div>`);
    }

    if (!multi) {
      // Single product: product page + details page
      const e = entries[0];
      const [hero, ...gallery] = imgs[0] ?? [];
      const slug = e.slug ? ` ${e.slug}` : '';
      add(`product${slug}`, `${brand.logo ? `<img class="plogo" src="${esc(brand.logo)}" alt="">` : `<div class="plogo brand">${esc(brand.name)}</div>`}<div class="col l"><span class="ey">${eyebrow(e)}</span><h2>${esc(e.name)}</h2>${e.tagline ? `<p class="tag">${esc(e.tagline)}</p>` : ''}<div class="rule2"></div>
          ${img(hero, 'hero')}${text(e.summary, 520)}</div>
        <div class="col r">${gallery.length ? `<div class="stack">${gallery.slice(0, 2).map((g) => img(g)).join('')}</div>` : ''}${panel('Key features', e)}</div>`);
      const overview = e.customHtml?.trim() ? `<div class="tx custom-body">${e.customHtml}</div>` : text(e.description, 1500);
      add(`detail${slug}`, `<div class="col l"><span class="ey">Overview</span><h2>${esc(e.name)}</h2><div class="rule2"></div>${overview}
          ${e.applications.length ? `<h4 class="sm">Applications</h4><p class="chips">${e.applications.slice(0, 8).map((a) => `<span>${esc(a)}</span>`).join('')}</p>` : ''}</div>
        <div class="col r"><h4 class="sm">Specifications</h4>${specsTable(e, 14)}
          ${e.benefits.length ? `<div class="panel small"><h4>Why it matters</h4><ul>${e.benefits.slice(0, 5).map((b) => `<li>${esc(clamp(b, 110))}</li>`).join('')}</ul></div>` : ''}
          <div class="contact"><b>${esc(brand.name)}</b> ${[brand.phone, brand.email, brand.website].filter(Boolean).map((x) => ` · ${esc(x)}`).join('')}${qr ? `<span class="qr">${qr}</span>` : ''}</div></div>`);
    } else if (opts.perPage === 1) {
      // One product per page: photo + story on the left, specs and features on the right
      entries.forEach((e, i) => {
        const [hero, ...gallery] = imgs[i] ?? [];
        const slug = e.slug ? ` ${e.slug}` : '';
        add(`product one${slug}`, `<div class="col l"><span class="ey">${eyebrow(e)}</span><h2>${esc(e.name)} ${priceTag(e)}</h2>${e.tagline ? `<p class="tag">${esc(e.tagline)}</p>` : ''}<div class="rule2"></div>
            ${img(hero, 'hero')}${text(e.summary, 420)}</div>
          <div class="col r">${gallery.length ? `<div class="thumbs">${gallery.slice(0, 3).map((g) => img(g)).join('')}</div>` : ''}<h4 class="sm">Specifications</h4>${specsTable(e, 9)}
            ${e.features.length ? `<div class="panel small"><h4>Key features</h4><ul>${e.features.slice(0, 5).map((f) => `<li>${esc(clamp(f, 90))}</li>`).join('')}</ul></div>` : ''}</div>`);
        if (e.customHtml?.trim()) add(`custom${slug}`, `<div class="custom-body">${e.customHtml}</div>`);
      });
    } else {
      // Two or three products per page as cards
      const per = opts.perPage;
      for (let k = 0; k < entries.length; k += per) {
        const cards = entries.slice(k, k + per).map((e, j) => {
          const hero = imgs[k + j]?.[0];
          return `<article class="card${e.slug ? ` ${e.slug}` : ''}">${img(hero, 'card-img')}<div class="card-b"><span class="ey">${eyebrow(e)}</span><h3>${esc(e.name)}</h3>
            ${e.tagline ? `<p class="tag">${esc(e.tagline)}</p>` : ''}<p class="sum">${esc(clamp(plainText(e.summary || e.description), per === 2 ? 320 : 180))}</p>
            ${miniSpecs(e, 4)}${per === 2 && e.features.length ? `<ul class="fl">${e.features.slice(0, 3).map((f) => `<li>${esc(clamp(f, 70))}</li>`).join('')}</ul>` : ''}${priceTag(e)}</div></article>`;
        });
        add(`cardpage c${per}`, `<div class="cards">${cards.join('')}</div>`);
      }
    }

    if (multi) {
      if (opts.compare) {
        const rows = comparison(entries);
        add('compare', `<span class="ey">At a glance</span><h2>Comparison</h2><div class="rule2"></div><table class="cmp"><thead><tr><th></th>${entries.map((e) => `<th>${esc(e.name)}</th>`).join('')}</tr></thead><tbody>
          ${rows.map((r) => `<tr><th>${esc(r.label)}</th>${r.values.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
          ${entries.some((e) => e.price != null) ? `<tr><th>Price</th>${entries.map((e) => `<td><b>${e.price != null ? this.fmtPrice(e.price) : 'On request'}</b></td>`).join('')}</tr>` : ''}</tbody></table>`);
      }
      if (about.customHtml.trim()) add('custom', `<div class="custom-body">${about.customHtml}</div>`);
      add('backpage', `<div class="bk"><div>${brand.logo ? `<img class="bk-logo" src="${esc(brand.logo)}" alt="">` : `<div class="bk-brand">${esc(brand.name)}</div>`}<h2>Get in touch</h2>
        <p>${[brand.address, brand.phone, brand.email, brand.website].filter(Boolean).map((x) => esc(x)).join('<br>')}</p></div>${qr ? `<span class="qr">${qr}</span>` : ''}</div>`);
    }

    const accent = /^#[0-9a-f]{6}$/i.test(brand.primary) ? brand.primary : '#111111';
    const css = `@page{size:297mm 210mm;margin:0}*{box-sizing:border-box}
body{margin:0;font:9pt/1.6 'Inter','Ubuntu Sans','Helvetica Neue','Liberation Sans',Arial,sans-serif;color:#3f3f46;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:297mm;height:210mm;position:relative;overflow:hidden;background:#fff;page-break-after:always;display:grid;grid-template-columns:1fr 1fr;gap:12mm;padding:16mm 16mm 18mm}
.lt{font-weight:300;color:#a1a1aa}h1,h2,h3,h4{margin:0;font-weight:500;color:#18181b;letter-spacing:-.01em}
h2{font-size:18pt}.ph-h{font-size:14pt}.rule,.rule2{height:.3mm;background:#d4d4d8}.rule2{margin:2.5mm 0 5mm}
.ph{background:#e4e4e7 center/cover no-repeat}.ph.none{background:linear-gradient(135deg,#f4f4f5,#d4d4d8)}
.pn{position:absolute;bottom:7mm;width:7mm;height:7mm;background:#18181b;color:#fff;font-size:6.5pt;display:grid;place-items:center}.pn.l{left:16mm}.pn.r{right:16mm}
/* cover */
.cover{display:block;padding:0;background:#fafafa}.cover .band{position:absolute;left:0;right:0;top:62mm;height:62mm;background:#f4f4f5;border-top:.3mm solid #d4d4d8;border-bottom:.3mm solid #d4d4d8}
.cover .band .rule{display:none}.cover .cover-img{position:absolute;right:28mm;top:-10mm;width:92mm;height:74mm;clip-path:polygon(8% 0,100% 0,100% 100%,0 100%,0 12%);box-shadow:0 2mm 6mm rgba(0,0,0,.15)}
.cover h1{position:absolute;right:128mm;bottom:12mm;font-size:26pt;font-weight:400;text-align:right;max-width:140mm;line-height:1.1}
.cover .logo{position:absolute;left:16mm;top:16mm;max-height:12mm;max-width:50mm}.cover .brand{position:absolute;left:16mm;top:16mm;font-weight:600;font-size:12pt;color:#18181b}
.cover .url{position:absolute;right:16mm;bottom:12mm;font-size:7.5pt;letter-spacing:.08em;color:#a1a1aa}
/* intro */
.intro .col.l{display:flex;flex-direction:column;justify-content:center}.intro h2{font-size:22pt;margin-bottom:5mm;border-bottom:.3mm solid #d4d4d8;padding-bottom:3mm}
.lead{font-size:9.5pt;color:#52525b}.quote{font-style:italic;color:#71717a;border-left:.6mm solid #18181b;padding-left:3mm;margin:4mm 0}
.hl{display:flex;gap:6mm;margin-top:3mm}.hl b{display:block;font-size:14pt;font-weight:500;color:#18181b}.hl span{font-size:7pt;color:#a1a1aa}
.sig{display:flex;align-items:center;gap:3mm;margin-top:6mm}.avatar{width:16mm;height:16mm;border-radius:50%}
.grid4{display:grid;grid-template-columns:1fr 1fr;gap:2mm;height:100mm}.grid4.n1{grid-template-columns:1fr}.grid4.n2{grid-template-columns:1fr 1fr;grid-template-rows:1fr}.grid4.n3>:first-child{grid-row:span 2}.toc-h{display:flex;align-items:center;gap:3mm;margin:5mm 0 2mm}.toc-h h3{font-size:13pt;font-weight:400}
.toc{list-style:none;margin:0;padding:0;columns:2;font-size:8.5pt}.toc li{padding:1mm 0;border-bottom:.2mm solid #f4f4f5}.toc span{color:#a1a1aa;margin-right:2mm}
/* product */
.product .col.l,.detail .col.l{display:flex;flex-direction:column}.hero{height:92mm;margin-bottom:4mm}.name{font-size:15pt;font-weight:500}.tag{margin:.5mm 0 2mm;color:#71717a;font-size:9pt}
.tx{font-size:8.8pt;color:#52525b}.tx p{margin:0 0 2mm}.stack{display:grid;grid-template-rows:1fr 1fr;gap:2mm;height:96mm;margin-bottom:3mm}
.panel{background:#18181b;color:#e4e4e7;padding:6mm 7mm;position:relative}.panel h4{color:#fff;font-weight:400;font-size:13pt;margin-bottom:3mm}
.panel ul{margin:0;padding:0;list-style:none}.panel li{padding:1.2mm 0;border-bottom:.2mm solid #3f3f46;font-size:8.5pt}.panel li:last-child{border:0}
.panel .price{position:absolute;right:7mm;top:6mm;color:#fff;font-weight:500;border:.3mm solid #52525b;padding:.8mm 3mm;font-size:9pt}
.panel.small{padding:5mm 6mm;margin-top:5mm}.sm{font-size:7.5pt;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:#18181b;margin:4mm 0 2mm}
table.sp{width:100%;border-collapse:collapse;font-size:8pt}.sp th{text-align:left;font-weight:500;color:#71717a;width:42%;padding:1.2mm 0;border-bottom:.2mm solid #e4e4e7}.sp td{padding:1.2mm 0;border-bottom:.2mm solid #e4e4e7;color:#27272a}
.chips span{display:inline-block;border:.2mm solid #d4d4d8;padding:.6mm 2.4mm;margin:0 1.5mm 1.5mm 0;font-size:7.5pt}
.contact{margin-top:auto;padding-top:4mm;border-top:.3mm solid #d4d4d8;font-size:7.5pt;color:#71717a;display:flex;align-items:center;gap:3mm}.contact b{color:#18181b}
.detail .col.r{display:flex;flex-direction:column}.qr svg{width:18mm;height:18mm;display:block}.contact .qr{margin-left:auto}
.rich h2,.rich h3{font-size:11pt;font-weight:500;margin:2mm 0 1.5mm;color:#18181b}.rich ul{padding-left:4mm;margin:1mm 0 2mm}.rich blockquote{margin:2mm 0;padding-left:3mm;border-left:.6mm solid #18181b;font-style:italic}.rich img{max-width:100%}
.custom-body{padding:0}.pg.custom{display:block}
.ey{display:block;font-size:7pt;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#a1a1aa;margin-bottom:1.5mm}
.pg h2{font-size:17pt;font-weight:500}.tag{margin:1mm 0 0;color:#71717a;font-size:9pt}.sec{font-size:7.5pt;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin:5mm 0 2mm}
.pt{display:inline-block;vertical-align:middle;margin-left:2mm;border:.3mm solid #18181b;color:#18181b;font-size:8.5pt;font-weight:600;padding:.4mm 2.5mm}
.one .hero{height:78mm}.thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:2mm;height:30mm;margin-bottom:2mm}
.cardpage .cards{grid-column:1/-1;display:grid;gap:6mm;height:170mm;min-height:0}.c2 .cards{grid-template-rows:repeat(2,minmax(0,1fr))}.card{min-height:0}.c3 .cards{grid-template-columns:repeat(3,1fr)}
.card{display:grid;border:.3mm solid #e4e4e7;background:#fff;overflow:hidden}.c2 .card{grid-template-columns:95mm 1fr}.c3 .card{grid-template-rows:62mm minmax(0,1fr)}
.card-img{height:100%;min-height:40mm}.card-b{padding:5mm 6mm;display:flex;flex-direction:column;gap:1mm;position:relative;overflow:hidden}.card h3{font-size:12.5pt;font-weight:500}
.card .sum{font-size:8.3pt;color:#52525b;margin:1.5mm 0}.sp.mini{font-size:7.5pt}.sp.mini th,.sp.mini td{padding:.8mm 0}
.fl{margin:1.5mm 0 0;padding-left:4mm;font-size:8pt;color:#3f3f46}.card .pt{position:absolute;right:6mm;top:5mm;margin:0}
.cover .ct{position:absolute;left:16mm;bottom:10mm;max-width:150mm}.cover .ct h1{position:static;text-align:left;font-size:28pt;font-weight:500;color:#18181b}.cover .ct p{margin:1mm 0 0;color:#71717a}
.pg.product:has(.plogo){padding-top:26mm}.plogo{position:absolute;left:16mm;top:9mm;height:9mm;max-width:45mm;object-fit:contain;object-position:left center;font-weight:600;color:#18181b;font-size:10pt;line-height:9mm}
.pg.product:has(.plogo) .hero{height:80mm}.pg.product:has(.plogo) .stack{height:74mm}
.pg.product:has(.plogo):before{content:'';position:absolute;left:16mm;right:16mm;top:21mm;border-top:.3mm solid #e4e4e7}
/* compare, back */
.compare{display:block}table.cmp{width:100%;border-collapse:collapse;font-size:8.5pt}.cmp thead th{background:#18181b;color:#fff;font-weight:500;text-align:left;padding:2.5mm 3mm}.cmp thead th:first-child{background:none}
.cmp th{text-align:left;font-weight:500;color:#71717a;padding:2mm 3mm;border-bottom:.2mm solid #e4e4e7}.cmp td{padding:2mm 3mm;border-bottom:.2mm solid #e4e4e7}
.backpage{display:block;background:#f4f4f5}.bk{position:absolute;left:16mm;right:16mm;bottom:18mm;display:flex;justify-content:space-between;align-items:flex-end;border-top:.3mm solid #d4d4d8;padding-top:7mm}
.bk-logo{display:block;max-height:10mm;max-width:45mm;margin-bottom:5mm}.bk-brand{font-weight:600;font-size:12pt;color:#18181b;margin-bottom:5mm}.bk h2{font-size:18pt;margin:0 0 2mm}.bk p{font-size:8.5pt;line-height:1.7;color:#71717a;margin:0}.bk .qr svg{width:24mm;height:24mm}
.noprint{position:fixed;right:6mm;bottom:6mm}@media print{.noprint{display:none}}@media screen{body{background:#52525b}.pg{margin:6mm auto;box-shadow:0 2mm 8mm rgba(0,0,0,.35)}}
${about.customCss}
${entries.filter((e) => e.customCss?.trim()).map((e) => `.${e.slug} {\n${e.customCss}\n}`).join('\n')}`;
    void accent;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${BROCHURE_CSP}"><title>${esc(title)} — brochure</title><style>${css}</style></head>
<body>${pages.join('')}<button class="noprint" onclick="print()">Print</button></body></html>`;
  }

  private itemPage(e: Entry, imgs: string[], brand: Brand, index: number, pageNo: number) {
    const [hero, ...gallery] = imgs;
    const stats = e.specs.filter(([k]) => k).slice(0, 3);
    const rest = e.specs.filter((s) => !stats.includes(s));
    return `<section class="page item${e.slug ? ` ${e.slug}` : ''}">
  <header class="item-hero${hero ? '' : ' no-img'}"${hero ? ` style="background-image:url('${hero}')"` : ''}>
    <div class="hero-shade"></div>
    <div class="hero-text"><span class="eyebrow">${String(index + 1).padStart(2, '0')} · ${esc([e.kind, e.category].filter(Boolean).join(' · '))}</span>
      <h1>${esc(e.name)}</h1>${e.tagline ? `<p>${esc(e.tagline)}</p>` : ''}</div>
    ${e.price != null ? `<div class="price-tag">${this.fmtPrice(e.price)}</div>` : ''}
  </header>
  ${stats.length ? `<div class="stats">${stats.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : ''}
  ${e.summary ? `<div class="lead">${richOrText(e.summary, 2000)}</div>` : ''}
  ${e.features.length ? `<h3>Key features</h3><div class="features">${e.features.slice(0, 8).map((f) => `<div class="feature"><i>✓</i><span>${esc(f)}</span></div>`).join('')}</div>` : ''}
  <div class="two">
    <div>${rest.length ? `<h3>Specifications</h3><table class="specs">${rest.map(([k, v]) => (k ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : `<tr><td colspan="2">${esc(v)}</td></tr>`)).join('')}</table>` : ''}
      ${e.description ? `<h3>Overview</h3><div class="desc">${richOrText(e.description, 3000)}</div>` : ''}</div>
    <div>${e.applications.length ? `<h3>Applications</h3><div class="chips">${e.applications.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
      ${e.benefits.length ? `<h3>Benefits</h3><ul class="benefits">${e.benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${gallery.length ? `<div class="gallery">${gallery.map((g) => `<img src="${g}" alt="">`).join('')}</div>` : ''}</div>
  </div>
  ${this.footer(brand, pageNo)}
</section>`;
  }

  private footer(b: Brand, page: number) {
    return `<footer class="foot"><span><b>${esc(b.name)}</b>${[b.phone, b.email, b.website].filter(Boolean).map((x) => ` · ${esc(x)}`).join('')}</span><span>${page}</span></footer>`;
  }

  private css(primary: string, theme: Opts['theme']) {
    const p = esc(primary);
    const dark = theme === 'modern';
    const ink = dark ? '#0b1220' : '#0f172a';
    return `@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font:9.5pt/1.55 'Inter','Ubuntu Sans','Helvetica Neue','Segoe UI','Liberation Sans',Arial,sans-serif;color:#1e293b;letter-spacing:-.005em;font-feature-settings:'tnum' 1;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;position:relative;page-break-after:always;overflow:hidden;padding:14mm 14mm 20mm;background:#fff}
.eyebrow{display:inline-block;text-transform:uppercase;letter-spacing:.14em;font-size:7pt;font-weight:700;color:${p}}
h2{font-size:20pt;font-weight:700;margin:2mm 0 6mm;color:${ink};letter-spacing:-.02em}h3{font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:${p};margin:5mm 0 2mm}
.logo{max-height:14mm;max-width:55mm}.brand{font-weight:800;font-size:14pt}
.cover{padding:0;background:${dark ? ink : '#f8fafc'};color:${dark ? '#fff' : ink}}
.cover-bg{position:absolute;inset:0;background:center/cover no-repeat;opacity:${dark ? '.6' : '.3'}}
.cover-shade{position:absolute;inset:0;background:${dark ? `linear-gradient(160deg,${ink}ee 30%,${ink}66 70%,${p}99)` : `linear-gradient(160deg,#f8fafcf2 35%,#f8fafcaa 75%,${p}55)`}}
.cover-inner{position:relative;height:100%;padding:18mm;display:flex;flex-direction:column}.cover-title{margin-top:auto}
.cover h1{font-size:34pt;line-height:1.02;margin:3mm 0 4mm;letter-spacing:-.03em;max-width:160mm}.cover-title p{font-size:12pt;opacity:.85;max-width:150mm;margin:0}
.cover-foot{margin-top:14mm;padding-top:4mm;border-top:2px solid ${p};font-size:9pt;opacity:.8}
.contents .toc{list-style:none;padding:0;margin:0}.toc li{display:flex;gap:6mm;align-items:center;padding:4.5mm 0;border-bottom:1px solid #e2e8f0}
.toc .num{font-size:16pt;font-weight:800;color:${p};width:14mm}.toc b{font-size:11pt;color:${ink}}.toc small{display:block;color:#64748b}.toc .kind{margin-left:auto;font-size:8pt;text-transform:uppercase;letter-spacing:.1em;color:#64748b}
.item-hero{position:relative;margin:-14mm -14mm 0;height:92mm;background:${ink} center/cover no-repeat;color:#fff;display:flex;align-items:flex-end;padding:0 14mm 9mm}
.item-hero.no-img{background:linear-gradient(135deg,${ink},${p})}.hero-shade{position:absolute;inset:0;background:linear-gradient(0deg,${ink}f2 5%,${ink}55 60%,transparent)}
.hero-text{position:relative;max-width:150mm}.hero-text .eyebrow{color:#fff;opacity:.85}.item-hero h1{font-size:24pt;font-weight:700;margin:1.5mm 0 1mm;line-height:1.08;letter-spacing:-.02em}.item-hero p{font-size:10.5pt;margin:0;opacity:.9}
.price-tag{position:absolute;right:14mm;top:10mm;background:${p};color:#fff;font-weight:700;padding:1.8mm 4mm;border-radius:99px;font-size:10pt}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin:-7mm 0 0;position:relative}
.stats div{background:#fff;border-radius:2.5mm;padding:3mm 3.5mm;box-shadow:0 1.5mm 5mm rgba(15,23,42,.10);border-top:.9mm solid ${p}}.stats b{display:block;font-size:12pt;font-weight:700;color:${ink};line-height:1.15}.stats span{font-size:6.5pt;text-transform:uppercase;letter-spacing:.1em;color:#64748b}
.lead{font-size:10.5pt;line-height:1.55;color:#334155;margin:5mm 0 0}.features{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm}
.feature{display:flex;gap:2mm;align-items:flex-start;background:#f8fafc;border-radius:2mm;padding:2mm 2.5mm;font-size:8.8pt;line-height:1.4}.feature i{font-style:normal;flex:none;width:4mm;height:4mm;border-radius:50%;background:${p};color:#fff;font-size:6pt;display:grid;place-items:center;margin-top:.4mm}
.two{display:grid;grid-template-columns:1.1fr .9fr;gap:8mm}table.specs{width:100%;border-collapse:collapse;font-size:8.3pt}.specs tr:nth-child(odd){background:#f8fafc}.specs th{text-align:left;color:#475569;font-weight:600;width:42%;padding:1.3mm 2mm}.specs td{padding:1.3mm 2mm;color:${ink}}
.chips{display:flex;flex-wrap:wrap;gap:1.8mm}.chips span{border:1px solid ${p}40;color:${ink};background:${p}0d;border-radius:99px;padding:.8mm 2.6mm;font-size:7.8pt}
ul.benefits{list-style:none;padding:0;margin:0}.benefits li{padding:1.1mm 0 1.1mm 4.5mm;position:relative;font-size:9pt;line-height:1.45}.benefits li:before{content:'';position:absolute;left:0;top:3.2mm;width:2.2mm;height:2.2mm;border-radius:50%;background:${p}}
.desc{white-space:pre-line;color:#475569;font-size:9pt;line-height:1.55}.gallery{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm;margin-top:5mm}.gallery img{width:100%;height:30mm;object-fit:cover;border-radius:2.5mm}
table.cmp{width:100%;border-collapse:separate;border-spacing:0;font-size:9pt}.cmp thead th{background:${ink};color:#fff;padding:3mm;text-align:left;font-size:9.5pt}.cmp thead th:first-child{background:transparent}
.cmp tbody th{text-align:left;color:#475569;font-weight:600;padding:2.2mm 3mm;width:30mm;background:#f8fafc}.cmp td{padding:2.2mm 3mm;border-bottom:1px solid #e2e8f0;vertical-align:top;color:${ink}}.cmp .price-row td{font-weight:800;color:${p};font-size:11pt}
.back{background:${dark ? ink : '#f1f5f9'};color:${dark ? '#fff' : ink};display:flex;flex-direction:column;justify-content:flex-end}.back-inner{padding:10mm 6mm 18mm;border-top:1mm solid ${p}}.back h2{color:${dark ? '#fff' : ink};font-size:28pt}.back p{font-size:11pt;opacity:.8}.back .qr{border:${dark ? '0' : `1px solid #e2e8f0`}}
.contact-list{list-style:none;padding:0;margin:8mm 0;font-size:10.5pt;line-height:1.9}.qr{display:inline-flex;flex-direction:column;align-items:center;gap:2mm;background:#fff;color:${ink};padding:4mm;border-radius:3mm}.qr svg{width:32mm;height:32mm}
.foot{position:absolute;left:14mm;right:14mm;bottom:8mm;display:flex;justify-content:space-between;font-size:8pt;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:2.5mm}
.about{padding:0}.about-photo{height:95mm;background:${ink} center/cover no-repeat}.about-photo.none{height:22mm;background:linear-gradient(135deg,${ink},${p})}
.about-body{padding:9mm 14mm 20mm}.about-stats{grid-template-columns:repeat(4,1fr);margin:6mm 0 0}.about blockquote{margin:0;padding:3mm 5mm;border-left:1mm solid ${p};background:#f8fafc;font-size:10.5pt;color:#334155;font-style:italic}
.loc-grid{display:grid;grid-template-columns:1fr 1fr;gap:5mm}.loc{position:relative;border:1px solid #e2e8f0;border-radius:3mm;padding:5mm 5mm 5mm 17mm;min-height:32mm}.loc.hq{border-color:${p};background:${p}0d}
.loc .pin{position:absolute;left:4.5mm;top:5mm;width:9mm;height:9mm;border-radius:50%;background:${p};color:#fff;display:grid;place-items:center;font-size:7.5pt;font-weight:800}
.loc b{font-size:10.5pt;color:${ink}}.loc p{margin:1.5mm 0;color:#475569;white-space:pre-line}.loc small{display:block;color:#475569}
.s-bar{display:flex;justify-content:space-between;align-items:center;height:12mm;margin:-6mm 0 5mm}.s-bar .logo{height:10mm;max-height:10mm;max-width:50mm;object-fit:contain;object-position:left center}.s-bar span{font-size:8pt;text-transform:uppercase;letter-spacing:.14em;color:#64748b}
.s-hero{margin:0 -14mm;height:112mm}.s1 .lead{font-size:10.5pt}.s1 .features{grid-template-columns:1fr 1fr}
.s2{padding-top:16mm}.s2 .desc{display:-webkit-box;-webkit-line-clamp:18;-webkit-box-orient:vertical;overflow:hidden}.overview{padding:0;margin-bottom:4mm}
.s-company{position:absolute;left:14mm;right:14mm;bottom:17mm;display:grid;grid-template-columns:1.4fr 1fr;gap:6mm;padding:4.5mm 5mm;border-radius:2.5mm;background:${ink};color:#fff;font-size:8pt}
.s-about b{font-size:10pt}.s-about p{margin:1.5mm 0 2mm;opacity:.85;line-height:1.45}.s-hl{display:flex;flex-wrap:wrap;gap:1.5mm 4mm;opacity:.9}.s-hl b{color:${p === '#ffffff' ? '#fff' : '#fff'}}
.s1.dark,.s2.dark{background:${ink};color:#cbd5e1}.dark h1,.dark h2,.dark .brand{color:#fff}.dark .lead,.dark .desc,.dark .benefits li,.dark .rich{color:#cbd5e1}
.dark .s-bar span{color:#94a3b8}.dark .feature{background:#16213a;color:#e2e8f0}.dark .stats div{background:#16213a;box-shadow:0 2mm 6mm rgba(0,0,0,.35)}.dark .stats b{color:#fff}.dark .stats span{color:#94a3b8}
.dark table.specs tr:nth-child(odd){background:#16213a}.dark .specs th{color:#94a3b8}.dark .specs td{color:#e2e8f0}.dark .chips span{color:#e2e8f0;background:${p}22;border-color:${p}66}
.dark .s-company{background:#16213a}.dark .foot{border-color:#1f2940;color:#64748b}.dark .overview h2,.dark .rich h2,.dark .rich h3{color:#fff}
.s-contact{display:flex;gap:4mm;align-items:center;justify-content:flex-end}.s-contact ul{list-style:none;margin:0;padding:0;line-height:1.7}.s-contact .qr{padding:2mm}.s-contact .qr svg{width:22mm;height:22mm}
.noprint{position:fixed;right:6mm;bottom:6mm}@media print{.noprint{display:none}}@media screen{body{background:#475569}.page{margin:6mm auto;box-shadow:0 2mm 8mm rgba(0,0,0,.4)}}`;
  }

  // ─── PowerPoint ────────────────────────────────────────────

  /** Modern widescreen deck matching the brochure: title, agenda, per-item section, comparison, contact. */
  @Get('presentation')
  async presentation(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>, @Res() res: Response) {
    const { entries, brand, opts, about, showAbout, showLocations } = await this.load(user, q, 'catalog.item.export');
    // Editorial (default): white slides, near-black accents, light lowercase "title //" headings, thin rules.
    const editorial = opts.theme === 'editorial';
    const accent = editorial ? '18181B' : brand.primary.replace('#', '').slice(0, 6).toUpperCase();
    const dark = opts.theme === 'modern';
    const INK = editorial ? '18181B' : '0B1220';
    const BG = editorial ? 'FFFFFF' : dark ? INK : 'F8FAFC';
    const FG = dark ? 'FFFFFF' : INK;
    const MUTED = editorial ? 'A1A1AA' : dark ? '94A3B8' : '64748B';
    const CARD = editorial ? 'F4F4F5' : dark ? '16213A' : 'FFFFFF';
    const multi = entries.length > 1;
    const title = opts.title || (multi ? 'Products & Solutions' : entries[0].name);
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    pptx.company = brand.name;
    pptx.title = title;
    const W = 13.33;
    const base = (s: PptxGenJS.Slide, n?: number) => {
      s.background = { color: BG };
      if (editorial) {
        s.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.5, w: W - 1.2, h: 0, line: { color: 'D4D4D8', width: 0.75 } });
        if (n) {
          s.addShape(pptx.ShapeType.rect, { x: n % 2 ? W - 0.95 : 0.6, y: 6.85, w: 0.35, h: 0.35, fill: { color: '18181B' } });
          s.addText(String(n).padStart(2, '0'), { x: n % 2 ? W - 0.95 : 0.6, y: 6.85, w: 0.35, h: 0.35, fontSize: 8, color: 'FFFFFF', align: 'center', valign: 'middle' });
          s.addText(brand.name.toLowerCase(), { x: n % 2 ? 0.6 : W - 4.6, y: 6.9, w: 4, h: 0.3, fontSize: 9, color: MUTED, align: n % 2 ? 'left' : 'right' });
        }
        return;
      }
      s.addShape(pptx.ShapeType.rect, { x: 0, y: 7.38, w: W, h: 0.12, fill: { color: accent } });
      if (n) s.addText(`${brand.name}   ${n}`, { x: W - 4.5, y: 6.95, w: 4, h: 0.3, fontSize: 9, color: MUTED, align: 'right' });
    };
    const heading = (s: PptxGenJS.Slide, eyebrow: string, text: string) => {
      if (editorial) {
        // Small spaced category line + plain title-case heading
        s.addText(eyebrow.toUpperCase(), { x: 0.6, y: 0.45, w: 10, h: 0.3, fontSize: 9, color: MUTED, charSpacing: 3 });
        s.addText(text, { x: 0.6, y: 0.75, w: 12, h: 0.7, fontSize: 26, color: '18181B', fontFace: 'Arial' });
        return;
      }
      s.addText(eyebrow.toUpperCase(), { x: 0.6, y: 0.4, w: 10, h: 0.3, fontSize: 11, bold: true, color: accent, charSpacing: 3 });
      s.addText(text, { x: 0.6, y: 0.7, w: 12, h: 0.8, fontSize: 30, bold: true, color: FG });
    };
    let n = 1;

    // Title
    const cover = pptx.addSlide();
    const heroes = (await Promise.all(entries.slice(0, 4).map((e) => this.images(user, e.imageIds, 1)))).map((x) => x[0]).filter(Boolean);
    if (editorial) {
      cover.background = { color: 'FAFAFA' };
      cover.addShape(pptx.ShapeType.rect, { x: 0, y: 2.7, w: W, h: 2.4, fill: { color: 'F4F4F5' }, line: { color: 'D4D4D8', width: 0.75 } });
      if (heroes[0]) cover.addImage({ data: heroes[0], x: 8.2, y: 2.3, w: 4.2, h: 2.9, sizing: { type: 'cover', w: 4.2, h: 2.9 } });
      cover.addText(brand.name.toUpperCase(), { x: 0.6, y: 3.05, w: 7.3, h: 0.35, fontSize: 10, color: 'A1A1AA', charSpacing: 3 });
      cover.addText(multi ? opts.title || 'Product Catalogue' : title, { x: 0.6, y: 3.4, w: 7.3, h: 1.2, fontSize: 32, color: '18181B', valign: 'top', fontFace: 'Arial' });
      if (brand.logo) cover.addImage({ data: brand.logo, x: 0.6, y: 0.6, w: 2.4, h: 0.8, sizing: { type: 'contain', w: 2.4, h: 0.8 } });
      else cover.addText(brand.name, { x: 0.6, y: 0.6, w: 6, h: 0.5, fontSize: 16, bold: true, color: '18181B' });
      cover.addText([opts.subtitle || (multi ? '' : entries[0].tagline), brand.website].filter(Boolean).join('   ·   '), { x: 4, y: 6.8, w: 8.7, h: 0.35, fontSize: 10, color: 'A1A1AA', align: 'right' });
    } else {
    cover.background = { color: INK };
    heroes.forEach((src, i) => cover.addImage({ data: src, x: 6.6 + (i % 2) * 3.37, y: (Math.floor(i / 2) * 3.75), w: 3.37, h: 3.75, sizing: { type: 'cover', w: 3.37, h: 3.75 }, transparency: 35 }));
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 7.2, h: 7.5, fill: { color: INK } });
    cover.addShape(pptx.ShapeType.rect, { x: 0.6, y: 5.6, w: 1.6, h: 0.08, fill: { color: accent } });
    if (brand.logo) cover.addImage({ data: brand.logo, x: 0.6, y: 0.6, w: 2.6, h: 0.9, sizing: { type: 'contain', w: 2.6, h: 0.9 } });
    else cover.addText(brand.name, { x: 0.6, y: 0.6, w: 6, h: 0.6, fontSize: 18, bold: true, color: 'FFFFFF' });
    cover.addText(title, { x: 0.6, y: 2.3, w: 6.3, h: 2.2, fontSize: 40, bold: true, color: 'FFFFFF', valign: 'bottom' });
    cover.addText(opts.subtitle || (multi ? `${entries.length} offerings from ${brand.name}` : entries[0].tagline), { x: 0.6, y: 4.6, w: 6.2, h: 0.9, fontSize: 16, color: 'CBD5E1', valign: 'top' });
    cover.addText(new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), { x: 0.6, y: 5.85, w: 6, h: 0.4, fontSize: 12, color: '94A3B8' });
    }

    // About us
    if (showAbout) {
      const s = pptx.addSlide();
      base(s, ++n);
      if (about.photo) s.addImage({ data: about.photo, x: 8.3, y: 0, w: 5.03, h: 7.38, sizing: { type: 'cover', w: 5.03, h: 7.38 } });
      else s.addShape(pptx.ShapeType.rect, { x: 8.3, y: 0, w: 5.03, h: 7.38, fill: { color: accent } });
      s.addText('WHO WE ARE', { x: 0.6, y: 0.5, w: 7, h: 0.3, fontSize: 11, bold: true, color: accent, charSpacing: 3 });
      s.addText(`About ${brand.name}`, { x: 0.6, y: 0.8, w: 7.4, h: 0.8, fontSize: 30, bold: true, color: FG });
      if (about.intro) s.addText(about.intro, { x: 0.6, y: 1.75, w: 7.3, h: 2.1, fontSize: 14, color: dark ? 'CBD5E1' : '334155', valign: 'top' });
      about.highlights.slice(0, 4).forEach(([k, v], j) => {
        const x = 0.6 + j * 1.85;
        s.addShape(pptx.ShapeType.roundRect, { x, y: 4.0, w: 1.7, h: 1.15, fill: { color: CARD }, line: { color: accent, width: 1.25 }, rectRadius: 0.1 });
        s.addText([{ text: v, options: { fontSize: 18, bold: true, color: FG, breakLine: true } }, { text: k.toUpperCase(), options: { fontSize: 8, color: MUTED } }], { x: x + 0.1, y: 4.0, w: 1.5, h: 1.15, align: 'center', valign: 'middle' });
      });
      if (about.mission) s.addText(`“${about.mission}”`, { x: 0.6, y: 5.35, w: 7.3, h: 0.9, fontSize: 13, italic: true, color: dark ? 'CBD5E1' : '334155', valign: 'top' });
      if (about.certifications.length) s.addText(about.certifications.join('   ·   '), { x: 0.6, y: 6.3, w: 7.3, h: 0.4, fontSize: 11, bold: true, color: accent });
    }

    // Locations
    if (showLocations) {
      const s = pptx.addSlide();
      base(s, ++n);
      heading(s, 'Where to find us', 'Our locations');
      about.locations.slice(0, 6).forEach((l, j) => {
        const x = 0.6 + (j % 3) * 4.1;
        const y = 1.9 + Math.floor(j / 3) * 2.5;
        s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.85, h: 2.25, fill: { color: CARD }, line: { color: j === 0 ? accent : dark ? '1F2940' : 'E2E8F0', width: j === 0 ? 1.5 : 0.75 }, rectRadius: 0.12 });
        s.addShape(pptx.ShapeType.ellipse, { x: x + 0.25, y: y + 0.25, w: 0.55, h: 0.55, fill: { color: accent } });
        s.addText(j === 0 ? 'HQ' : String(j + 1).padStart(2, '0'), { x: x + 0.25, y: y + 0.25, w: 0.55, h: 0.55, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
        s.addText([
          { text: l.name, options: { bold: true, fontSize: 15, color: FG, breakLine: true } },
          ...(l.address ? [{ text: l.address, options: { fontSize: 11, color: MUTED, breakLine: true } }] : []),
          ...(l.phone ? [{ text: `☎ ${l.phone}`, options: { fontSize: 11, color: MUTED, breakLine: true } }] : []),
          ...(l.email ? [{ text: `✉ ${l.email}`, options: { fontSize: 11, color: MUTED } }] : []),
        ], { x: x + 0.95, y: y + 0.2, w: 2.75, h: 1.9, valign: 'top' });
      });
    }

    // Agenda
    if (multi) {
      const s = pptx.addSlide();
      base(s, ++n);
      heading(s, 'Agenda', "What we'll cover");
      entries.slice(0, 8).forEach((e, i) => {
        const col = i < 4 ? 0 : 1;
        const y = 1.85 + (i % 4) * 1.2;
        const x = 0.6 + col * 6.2;
        s.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.9, h: 1.0, fill: { color: CARD }, line: { color: dark ? '1F2940' : 'E2E8F0' }, rectRadius: 0.12 });
        s.addText(String(i + 1).padStart(2, '0'), { x: x + 0.25, y, w: 0.9, h: 1.0, fontSize: 24, bold: true, color: accent, valign: 'middle' });
        s.addText([{ text: e.name, options: { bold: true, fontSize: 16, color: FG, breakLine: true } }, { text: e.tagline || e.kind, options: { fontSize: 11, color: MUTED } }], { x: x + 1.1, y, w: 4.6, h: 1.0, valign: 'middle' });
      });
    }

    for (const [i, e] of entries.entries()) {
      const imgs = await this.images(user, e.imageIds, 3);

      // Section / overview
      const s1 = pptx.addSlide();
      base(s1, ++n);
      if (imgs[0]) s1.addImage({ data: imgs[0], x: 7.0, y: 0, w: 6.33, h: 7.38, sizing: { type: 'cover', w: 6.33, h: 7.38 } });
      else s1.addShape(pptx.ShapeType.rect, { x: 7.0, y: 0, w: 6.33, h: 7.38, fill: { color: accent } });
      s1.addText(`${String(i + 1).padStart(2, '0')}  ·  ${[e.kind, e.category].filter(Boolean).join(' · ')}`.toUpperCase(), { x: 0.6, y: 0.6, w: 6, h: 0.3, fontSize: 11, bold: true, color: accent, charSpacing: 3 });
      s1.addText(e.name, { x: 0.6, y: 1.0, w: 6.2, h: 1.6, fontSize: 34, bold: true, color: FG, valign: 'top' });
      if (e.tagline) s1.addText(e.tagline, { x: 0.6, y: 2.6, w: 6.2, h: 0.7, fontSize: 17, color: accent, bold: true, valign: 'top' });
      if (e.summary) s1.addText(plainText(e.summary), { x: 0.6, y: 3.4, w: 6.1, h: 2.4, fontSize: 15, color: dark ? 'CBD5E1' : '334155', valign: 'top' });
      if (e.price != null) {
        s1.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 6.1, w: 2.8, h: 0.6, fill: { color: accent }, rectRadius: 0.3 });
        s1.addText(this.fmtPrice(e.price), { x: 0.6, y: 6.1, w: 2.8, h: 0.6, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center' });
      }

      // Feature cards
      if (e.features.length) {
        const s2 = pptx.addSlide();
        base(s2, ++n);
        heading(s2, e.name, 'Key features');
        e.features.slice(0, 6).forEach((f, k) => {
          const x = 0.6 + (k % 3) * 4.1;
          const y = 1.9 + Math.floor(k / 3) * 2.45;
          s2.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.85, h: 2.2, fill: { color: CARD }, line: { color: dark ? '1F2940' : 'E2E8F0' }, rectRadius: 0.15 });
          s2.addShape(pptx.ShapeType.ellipse, { x: x + 0.3, y: y + 0.3, w: 0.55, h: 0.55, fill: { color: accent } });
          s2.addText('✓', { x: x + 0.3, y: y + 0.3, w: 0.55, h: 0.55, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
          s2.addText(f, { x: x + 0.3, y: y + 1.0, w: 3.3, h: 1.05, fontSize: 15, color: FG, valign: 'top' });
        });
      }

      // Stats + specs
      if (e.specs.length) {
        const s3 = pptx.addSlide();
        base(s3, ++n);
        heading(s3, e.name, 'Specifications');
        const stats = e.specs.filter(([k]) => k).slice(0, 3);
        stats.forEach(([k, v], j) => {
          const x = 0.6 + j * 4.1;
          s3.addShape(pptx.ShapeType.roundRect, { x, y: 1.8, w: 3.85, h: 1.25, fill: { color: CARD }, line: { color: accent, width: 1.5 }, rectRadius: 0.12 });
          s3.addText([{ text: v, options: { fontSize: 22, bold: true, color: FG, breakLine: true } }, { text: k.toUpperCase(), options: { fontSize: 10, color: MUTED, charSpacing: 2 } }], { x: x + 0.25, y: 1.8, w: 3.4, h: 1.25, valign: 'middle' });
        });
        const rest = e.specs.filter((sp) => !stats.includes(sp)).slice(0, 10);
        if (rest.length) {
          s3.addTable(rest.map(([k, v], r) => [
            { text: k || ' ', options: { bold: true, color: MUTED, fill: { color: r % 2 ? BG : CARD } } },
            { text: v, options: { color: FG, fill: { color: r % 2 ? BG : CARD } } },
          ]), { x: 0.6, y: 3.35, w: 12.1, colW: [4.2, 7.9], fontSize: 13, rowH: 0.34, border: { type: 'none', pt: 0, color: BG } });
        }
      }

      // Applications & benefits
      if (e.applications.length || e.benefits.length) {
        const s4 = pptx.addSlide();
        base(s4, ++n);
        heading(s4, e.name, 'Where it fits');
        const col = (label: string, xs: string[], x: number) => {
          s4.addText(label, { x, y: 1.85, w: 5.8, h: 0.45, fontSize: 16, bold: true, color: accent });
          s4.addText(xs.slice(0, 8).map((t) => ({ text: t, options: { bullet: { code: '25CF' }, breakLine: true } })), { x, y: 2.35, w: 5.8, h: 4.4, fontSize: 16, color: FG, valign: 'top', paraSpaceAfter: 8 });
        };
        if (e.applications.length) col('Applications', e.applications, 0.6);
        if (e.benefits.length) col('Benefits', e.benefits, e.applications.length ? 6.9 : 0.6);
      }
    }

    // Comparison (optional, always last before contact)
    if (multi && opts.compare) {
      const rows = comparison(entries, 8);
      const s = pptx.addSlide();
      base(s, ++n);
      heading(s, 'At a glance', 'Comparison');
      const shown = entries.slice(0, 5);
      const head = [{ text: ' ', options: { fill: { color: BG } } }, ...shown.map((e) => ({ text: e.name, options: { bold: true, color: 'FFFFFF', fill: { color: accent } } }))];
      const body = [
        ['Type', ...shown.map((e) => e.kind)],
        ...rows.map((r) => [r.label, ...r.values.slice(0, 5)]),
        ...(shown.some((e) => e.price != null) ? [['Price', ...shown.map((e) => (e.price != null ? this.fmtPrice(e.price) : 'On request'))]] : []),
      ].map((r, k) => r.map((c, j) => ({ text: c, options: { bold: j === 0, color: j === 0 ? MUTED : FG, fill: { color: k % 2 ? BG : CARD } } })));
      s.addTable([head, ...body], { x: 0.6, y: 1.8, w: 12.1, fontSize: 12, rowH: 0.4, border: { type: 'none', pt: 0, color: BG } });
    }

    // Contact
    const end = pptx.addSlide();
    end.background = { color: INK };
    end.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: accent } });
    end.addText("Let's talk", { x: 0.8, y: 1.6, w: 8, h: 1.1, fontSize: 44, bold: true, color: 'FFFFFF' });
    end.addText([brand.name, brand.phone, brand.email, brand.website, brand.address].filter(Boolean).map((t) => ({ text: String(t), options: { breakLine: true } })), { x: 0.8, y: 2.9, w: 7.5, h: 3.2, fontSize: 18, color: 'CBD5E1', valign: 'top', paraSpaceAfter: 6 });
    if (brand.website) {
      const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: brand.website.startsWith('http') ? brand.website : `https://${brand.website}`, scale: 6, backgroundcolor: 'FFFFFF', paddingwidth: 8, paddingheight: 8 });
      end.addImage({ data: `data:image/png;base64,${png.toString('base64')}`, x: 9.6, y: 2.5, w: 2.6, h: 2.6 });
    }

    const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${(multi ? 'solutions' : entries[0].code || entries[0].name).replace(/[^\w-]+/g, '_')}.pptx"`);
    return res.send(buf);
  }
}
