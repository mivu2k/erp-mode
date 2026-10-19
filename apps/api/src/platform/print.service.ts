import { Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A5 (148×210mm) is the A4 document at ~70%: same layout, smaller type and spacing. Declared after the A4 rules so it wins.
 */
const A5 = `
  @page { size: A5; margin: 8mm 8mm 10mm; }
  html { zoom: 0.7; }
  @media screen { .sheet { width: 212mm !important; min-height: 300mm !important; } }`;

export type PaperSize = 'a4' | 'a5' | '80' | '58';
/** Full-page documents (A4, A5); the rest are thermal receipt widths. */
export const isPage = (s?: PaperSize) => !s || s === 'a4' || s === 'a5';

export interface ReceiptLine { desc: string; qty: number; price: number; amount: number }

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== null ? n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : String(v ?? '');
};

export interface PrintDoc {
  company: { name: string; address?: string | null; phone?: string | null; taxId?: string | null; branding?: unknown };
  title: string;
  number?: string;
  fields: [string, unknown][];
  lines?: { columns: string[]; rows: unknown[][] };
  /** Item rows for thermal receipts (description / qty × price = amount). */
  receipt?: ReceiptLine[];
  totals?: [string, unknown][];
  qr?: string;
  barcode?: string;
  footer?: string;
  size?: PaperSize;
  /** A4 only: status badge, "To" box, grouped details, words, terms, signature boxes, printed-by. */
  status?: string;
  date?: string;
  branch?: string;
  party?: { label: string; lines: string[] };
  sections?: [string, [string, unknown][]][];
  words?: string;
  note?: string;
  signatures?: string[];
  printedBy?: string;
}

interface Branding { primary?: string; font?: string; logo?: string; logoDark?: string; footer?: string; terms?: string }

@Injectable()
export class PrintService {
  qrSvg(text: string) {
    return bwipjs.toSVG({ bcid: 'qrcode', text, scale: 3 });
  }

  barcodeSvg(text: string) {
    return bwipjs.toSVG({ bcid: 'code128', text, height: 10, includetext: true, textxalign: 'center' });
  }

  /** One template for every document; size switches between A4 and 80/58mm thermal. */
  render(d: PrintDoc): string {
    if (!isPage(d.size)) return this.thermal(d);
    const b = (d.company.branding ?? {}) as Branding;
    const p = /^#[0-9a-f]{3,8}$/i.test(b.primary ?? '') ? b.primary! : '#1e293b';
    const logo = /^data:image\//.test(b.logo ?? '') ? b.logo : '';
    const num = (s: string) => /^-?[\d,]+(\.\d+)?$/.test(s);
    const kv = (rows: [string, unknown][]) => rows.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const sections = d.sections ?? (d.fields.length ? [['Details', d.fields] as [string, [string, unknown][]]] : []);
    const table = d.lines?.rows.length
      ? `<table class="lines"><thead><tr><th class="n">#</th>${d.lines.columns.map((c, i) => `<th${d.lines!.rows.every((r) => num(String(r[i] ?? '')) || r[i] === '' || r[i] == null) ? ' class="r"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${d.lines.rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${r.map((c) => `<td${num(String(c ?? '')) ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '';
    const tone = /reject|cancel|void|fail/i.test(d.status ?? '') ? '#b91c1c' : /unpaid|partial|pending|draft/i.test(d.status ?? '') ? '#b45309' : /paid|approved|settled|closed|delivered|complete|pass|received|posted/i.test(d.status ?? '') ? '#15803d' : '#b45309';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)} ${esc(d.number)}</title>
<style>
  @page { size: A4; margin: 12mm 12mm 16mm; }${d.size === 'a5' ? A5 : ''}
  * { box-sizing: border-box; }
  body { font: 10pt/1.45 ${b.font ? `'${esc(b.font)}',` : ''}'Inter','Segoe UI',system-ui,sans-serif; color: #0f172a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @media screen { body { background: #e2e8f0; } .sheet { width: 210mm; min-height: 297mm; margin: 8mm auto; background: #fff; padding: 12mm; box-shadow: 0 2mm 8mm rgba(0,0,0,.15); } }
  .top { display: flex; justify-content: space-between; gap: 8mm; padding-bottom: 5mm; border-bottom: 1mm solid ${p}; }
  .co { display: flex; gap: 4mm; align-items: flex-start; } .co img { max-height: 16mm; max-width: 40mm; object-fit: contain; }
  .co b { font-size: 13pt; display: block; } .co small { color: #475569; display: block; white-space: pre-line; }
  .doc { text-align: right; } .doc h1 { margin: 0; font-size: 16pt; white-space: nowrap; letter-spacing: .02em; color: ${p}; text-transform: uppercase; }
  .doc .no { font: 700 11pt ui-monospace, monospace; } .doc .dt { color: #475569; }
  .badge { display: inline-block; margin-top: 1.5mm; padding: .5mm 2.5mm; border-radius: 99px; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: ${tone}; border: .3mm solid ${tone}; }
  .row { display: flex; gap: 5mm; margin-top: 5mm; }
  .box { flex: 1; border: .3mm solid #cbd5e1; border-radius: 2mm; padding: 3mm 4mm; break-inside: avoid; }
  .box h3 { margin: 0 0 1.5mm; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .12em; color: ${p}; }
  .party b { font-size: 11pt; } .party div { color: #334155; }
  .codes { display: flex; gap: 3mm; align-items: center; } .codes svg { height: 22mm; width: auto; } .codes .bc svg { height: 12mm; }
  .secs { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-top: 5mm; } .secs .wide { grid-column: span 2; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr; gap: 0 6mm; } .wide dl { grid-template-columns: 1fr 1fr; }
  .kv { display: flex; justify-content: space-between; gap: 3mm; border-bottom: .2mm dotted #cbd5e1; padding: .9mm 0; }
  .kv dt { color: #64748b; white-space: nowrap; } .kv dd { margin: 0; text-align: right; font-weight: 500; overflow-wrap: anywhere; white-space: pre-line; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 5mm; font-size: 9.5pt; }
  table.lines th { background: ${p}; color: #fff; text-align: left; padding: 1.8mm 2mm; font-weight: 600; font-size: 8.5pt; }
  table.lines td { padding: 1.6mm 2mm; border-bottom: .2mm solid #e2e8f0; vertical-align: top; }
  table.lines tbody tr:nth-child(even) td { background: #f8fafc; }
  table.lines .n { width: 8mm; color: #64748b; } table.lines .r { text-align: right; font-variant-numeric: tabular-nums; }
  .sum { display: flex; gap: 5mm; margin-top: 4mm; align-items: flex-start; }
  .words { flex: 1; font-style: italic; color: #334155; padding-top: 1mm; } .words b { font-style: normal; color: #0f172a; }
  .totals { width: 75mm; } .totals div { display: flex; justify-content: space-between; padding: 1mm 2mm; font-variant-numeric: tabular-nums; }
  .totals div:last-child { background: ${p}; color: #fff; font-weight: 700; font-size: 11pt; border-radius: 1.5mm; margin-top: 1mm; }
  .note { margin-top: 5mm; font-size: 8.5pt; color: #475569; white-space: pre-line; border-left: .8mm solid ${p}; padding: 1mm 3mm; }
  .signs { display: flex; gap: 6mm; margin-top: 16mm; break-inside: avoid; } .signs div { flex: 1; text-align: center; font-size: 8.5pt; color: #475569; border-top: .3mm solid #334155; padding-top: 1.5mm; }
  .foot { margin-top: 8mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #94a3b8; border-top: .2mm solid #e2e8f0; padding-top: 2mm; }
  @media print { .noprint { display: none; } }
  .noprint { position: fixed; right: 6mm; bottom: 6mm; }
</style></head><body><div class="sheet">
<div class="top">
  <div class="co">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<div><b>${esc(d.company.name)}</b><small>${esc([d.company.address, d.company.phone].filter(Boolean).join('\n'))}${d.company.taxId ? `\nNTN ${esc(d.company.taxId)}` : ''}</small></div></div>
  <div class="doc"><h1>${esc(d.title)}</h1>${d.number ? `<div class="no">${esc(d.number)}</div>` : ''}${d.date || d.branch ? `<div class="dt">${esc([d.date, d.branch].filter(Boolean).join(' · '))}</div>` : ''}${d.status ? `<span class="badge">${esc(d.status)}</span>` : ''}</div>
</div>
${d.party || d.qr || d.barcode ? `<div class="row">
  ${d.party ? `<div class="box party"><h3>${esc(d.party.label)}</h3>${d.party.lines.map((l, i) => (i ? `<div>${esc(l)}</div>` : `<b>${esc(l)}</b>`)).join('')}</div>` : '<div style="flex:1"></div>'}
  <div class="codes">${d.barcode ? `<div class="bc">${this.barcodeSvg(d.barcode)}</div>` : ''}${d.qr ? this.qrSvg(d.qr) : ''}</div>
</div>` : ''}
${(() => {
  // Short sections sit side by side; long ones take the full width in two columns. A lone short section at the end also goes wide.
  const secs = sections.filter(([, rows]) => rows.length);
  const wide = secs.map(([, rows]) => rows.length > 4);
  let run = 0; // short sections pair up; the odd one out of a run goes full width
  secs.forEach((_, i) => { if (wide[i]) { run = 0; return; } run++; if ((i === secs.length - 1 || wide[i + 1]) && run % 2 === 1) wide[i] = true; });
  return secs.length ? `<div class="secs">${secs.map(([t, rows], i) => `<div class="box${wide[i] ? ' wide' : ''}"><h3>${esc(t)}</h3><dl>${kv(rows)}</dl></div>`).join('')}</div>` : '';
})()}
${table}
${d.totals?.length || d.words ? `<div class="sum"><div class="words">${d.words ? `<b>Amount in words:</b> ${esc(d.words)}` : ''}</div>${d.totals?.length ? `<div class="totals">${d.totals.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>` : ''}</div>` : ''}
${d.note || d.footer || b.terms ? `<div class="note">${esc([d.note, d.footer, b.terms].filter(Boolean).join('\n'))}</div>` : ''}
${d.signatures?.length ? `<div class="signs">${d.signatures.map((s) => `<div>${esc(s)}</div>`).join('')}</div>` : ''}
<div class="foot"><span>${esc(b.footer ?? '')}</span><span>${d.printedBy ? `Printed by ${esc(d.printedBy)} · ` : ''}${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</span></div>
</div>
<button class="noprint" onclick="print()">Print</button><script>addEventListener('load',()=>print())</script>
</body></html>`;
  }

  /**
   * Thermal receipt. 80mm paper prints ~72mm, 58mm prints ~48mm; everything is sized to that width,
   * monospace digits, no tables wider than the roll.
   */
  thermal(d: PrintDoc): string {
    const b = (d.company.branding ?? {}) as Branding;
    const w = d.size === '58' ? 48 : 72;
    const row = (l: string, r: string, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`;
    const has = (v: unknown) => v !== null && v !== undefined && v !== '';
    // Priced lines (invoices, job parts) as items; any other table (e.g. the units on an intake) as one numbered block per row.
    const items = d.receipt?.length && d.receipt.some((l) => l.amount)
      ? d.receipt.map((l) => `<div class="item"><div class="desc">${esc(l.desc)}</div>${row(`${money(l.qty)} × ${money(l.price)}`, money(l.amount))}</div>`).join('')
      : d.lines ? d.lines.rows.map((r, n) => `<div class="item"><div class="h">${n + 1}. ${esc(r[0])}</div>${d.lines!.columns.slice(1).map((c, i) => has(r[i + 1]) ? row(esc(c), esc(r[i + 1])) : '').join('')}</div>`).join('') : '';
    // Grouped like the A4 copy when the document has sections; otherwise the flat field list.
    const body = d.sections?.length
      ? d.sections.filter(([, rows]) => rows.some(([, v]) => has(v))).map(([t, rows]) => `<div class="h">${esc(t)}</div>${rows.filter(([, v]) => has(v)).map(([k, v]) => row(esc(k), esc(v))).join('')}`).join('')
      : d.fields.filter(([k, v]) => has(v) && k !== 'Status').map(([k, v]) => row(esc(k), esc(v))).join('');
    const sign = d.signatures?.length ? `<div class="sign">${d.signatures.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)} ${esc(d.number)}</title>
<style>
  /* An "auto" height is not valid CSS (Chrome then prints on Letter/A4 and the roll printer crops it): a real page size, and the
     load script below sets the height to the slip's own length so it prints as one strip. */
  @page { size: ${d.size}mm 297mm; margin: 0; }
  * { box-sizing: border-box; }
  body { width: ${w}mm; margin: 0 auto; padding: 3mm 0; font: ${d.size === '58' ? 10 : 11}px/1.35 ui-monospace, 'DejaVu Sans Mono', Menlo, monospace; color: #000; }
  .c { text-align: center; }
  .co { font-weight: 700; font-size: 1.25em; }
  .muted { color: #333; }
  .title { margin: 2mm 0 0; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .num { font-weight: 700; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  /* Labels stay whole ("Equipment", not "Equip / ment"); long values wrap on the right. */
  .row span:first-child { white-space: nowrap; flex: none; max-width: 48%; overflow: hidden; text-overflow: ellipsis; }
  .row span:last-child { text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .h { font-weight: 700; text-transform: uppercase; font-size: .85em; letter-spacing: .05em; margin: 2mm 0 .5mm; border-bottom: 1px solid #000; }
  .item .h { text-transform: none; font-size: 1em; letter-spacing: 0; border-bottom: 0; margin-top: 1.5mm; }
  .party { border: 1px solid #000; padding: 1mm 1.5mm; margin-top: 1mm; }
  .party b { display: block; }
  .note { font-size: .85em; margin-top: 2mm; white-space: pre-line; }
  .sign div { margin-top: 7mm; border-top: 1px solid #000; padding-top: .5mm; font-size: .85em; }
  .qrcap { font-size: .85em; text-align: center; }
  .item { margin-bottom: 1.2mm; }
  .desc { overflow-wrap: anywhere; }
  .total { font-weight: 700; font-size: 1.2em; border-top: 1px solid #000; padding-top: 1mm; margin-top: 1mm; }
  .codes { display: flex; flex-direction: column; align-items: center; gap: 2mm; margin-top: 3mm; }
  .codes .bc svg { width: ${w - 8}mm; height: 11mm; }
  .codes .qr svg { width: ${d.size === '58' ? 20 : 24}mm; height: auto; }
  img.logo { max-height: 12mm; max-width: 40mm; display: block; margin: 0 auto 1mm; }
  .noprint { display: block; margin: 4mm auto 0; font: inherit; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="c">${b.logo ? `<img class="logo" src="${esc(b.logo)}" alt="">` : ''}<div class="co">${esc(d.company.name)}</div>
<div class="muted">${[d.company.address, d.company.phone].filter(Boolean).map(esc).join('<br>')}${d.company.taxId ? `<br>NTN ${esc(d.company.taxId)}` : ''}</div>
<div class="title">${esc(d.title)}</div>${d.number ? `<div class="num">${esc(d.number)}</div>` : ''}
<div class="muted">${[d.date, d.branch, d.status && d.status.toUpperCase()].filter(Boolean).map(esc).join(' · ')}</div></div>
${d.party ? `<div class="party"><span class="muted">${esc(d.party.label)}</span><b>${esc(d.party.lines[0] ?? '')}</b>${d.party.lines.slice(1).map(esc).join('<br>')}</div>` : ''}
<hr>
${body}
${items ? `<hr>${items}` : ''}
${d.totals?.length ? `<hr>${d.totals.map(([k, v], i) => row(esc(k), esc(money(v)), i === d.totals!.length - 1 ? 'total' : '')).join('')}` : ''}
${d.words ? `<div class="note"><b>In words:</b> ${esc(d.words)}</div>` : ''}
<div class="codes">${d.barcode ? `<div class="bc">${this.barcodeSvg(d.barcode)}</div>` : ''}${d.qr ? `<div class="qr">${this.qrSvg(d.qr)}</div>` : ''}</div>
${d.qr && d.footer ? `<div class="qrcap">${esc(d.footer)}</div>` : ''}
${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
${sign}
<hr><div class="c muted" style="white-space:pre-line">${esc(b.terms ?? b.footer ?? 'Thank you!')}</div>
<div class="c muted" style="font-size:.85em">${esc(new Date().toLocaleString('en-GB'))}</div>
<button class="noprint" onclick="print()">Print</button><script>addEventListener('load',()=>{const s=document.createElement('style');s.textContent='@page{size:${d.size}mm '+Math.ceil(document.body.scrollHeight*25.4/96+4)+'mm;margin:0}';document.head.appendChild(s);print()})</script>
</body></html>`;
  }

  /** Small sticker: barcode + name (products, job tags, asset tags). */
  label(title: string, subtitle: string, code: string) {
    return this.labels(title, subtitle, [code], 1);
  }

  /** A run of 50×30 mm labels, one per page (label printers cut on page breaks): each code × copies. */
  labels(title: string, subtitle: string, codes: (string | { code: string; sub?: string })[], copies: number, qr = false) {
    // QR labels: code beside its text (scans from any angle, works on curved items); otherwise a Code 128 barcode.
    // A code can bring its own line (e.g. a unit's other codes) in place of the shared subtitle.
    const one = (c: string | { code: string; sub?: string }) => {
      const code = typeof c === 'string' ? c : c.code;
      const sub = (typeof c === 'string' ? undefined : c.sub) ?? subtitle;
      return qr
        ? `<div class="l q"><div class="qr">${this.qrSvg(code)}</div><div class="t"><b>${esc(title)}</b><div class="s">${esc(sub)}</div><div class="c">${esc(code)}</div></div></div>`
        : `<div class="l"><b>${esc(title)}</b><div class="s">${esc(sub)}</div>${this.barcodeSvg(code)}</div>`;
    };
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} labels</title><style>@page{size:50mm 30mm;margin:1mm}body{font:10px system-ui;margin:0;text-align:center}
.l{height:27.5mm;overflow:hidden;break-after:page}.l:last-child{break-after:auto}.l b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.s{font-size:8px}svg{width:46mm;height:14mm}
*{box-sizing:border-box}.l{padding:.5mm 1mm}
/* QR: white quiet zone (≥ 4 modules) all round so it scans off paper; text in its own column, never past the edge. */
.q{display:flex;gap:1.5mm;align-items:center;text-align:start}.q .qr{flex:none;background:#fff;padding:1.2mm}.q .qr svg{display:block;width:20mm;height:20mm}
.q .t{flex:1;min-width:0;overflow:hidden}.q .t b{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:9px;line-height:1.15}
.q .s{font-size:7px;line-height:1.2;margin-top:.5mm;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.c{font:8px/1.15 ui-monospace,monospace;margin-top:.8mm;word-break:break-all}
@media screen{body{background:#e2e8f0}.l{width:50mm;margin:2mm auto;background:#fff;padding:1mm}}</style></head>
<body>${codes.flatMap((c) => Array.from({ length: copies }, () => one(c))).join('')}<script>addEventListener('load',()=>print())</script></body></html>`;
  }

  /** CR80 ID card, front and back (two 54×86 mm pages), in the company's brand colour. */
  idCard(d: {
    company: { name: string; phone?: string | null; address?: string | null; branding?: unknown };
    name: string; code: string; designation?: string; department?: string; branch?: string;
    photoUrl: string | null; qr: string; joinDate?: Date | null; phone?: string | null; cnic?: string | null; emergency?: string;
  }) {
    const b = (d.company.branding ?? {}) as Branding;
    const p = /^#[0-9a-f]{3,8}$/i.test(b.primary ?? '') ? b.primary! : '#1d4ed8';
    // The band is coloured: prefer the logo made for dark backgrounds, else the normal logo on a white chip.
    const dark = /^data:image\//.test(b.logoDark ?? '') ? b.logoDark : '';
    const logo = dark || (/^data:image\//.test(b.logo ?? '') ? b.logo : '');
    const initials = d.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const dt = (x?: Date | null) => (x ? x.toISOString().slice(0, 10) : '');
    const row = (k: string, v?: string | null) => (v ? `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>ID card — ${esc(d.name)}</title><style>
@page{size:54mm 86mm;margin:0}
*{box-sizing:border-box}body{margin:0;font:8pt/1.35 'Inter','Segoe UI',system-ui,sans-serif;color:#0f172a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@media screen{body{background:#475569;display:flex;gap:6mm;justify-content:center;padding:8mm}.card{box-shadow:0 2mm 6mm rgba(0,0,0,.4);border-radius:3mm}}
.card{width:54mm;height:86mm;position:relative;overflow:hidden;background:#fff;page-break-after:always;display:flex;flex-direction:column}
.band{height:30mm;background:linear-gradient(135deg,${p},${p}cc);color:#fff;padding:3.5mm 4mm;position:relative}
.band:after{content:'';position:absolute;left:-10mm;right:-10mm;bottom:-9mm;height:18mm;background:#fff;border-radius:50% 50% 0 0}
.co{display:flex;align-items:center;gap:2mm;font-weight:700;font-size:8.5pt;letter-spacing:.02em}.co img{height:6mm;max-width:20mm;object-fit:contain;background:#fff;border-radius:1mm;padding:.5mm}.co img.on-dark{background:none;padding:0}
.tag{font-size:6pt;letter-spacing:.2em;text-transform:uppercase;opacity:.85;margin-top:1mm}
.photo{position:absolute;left:50%;top:15mm;transform:translateX(-50%);width:24mm;height:24mm;border-radius:50%;border:1mm solid #fff;background:${p}22;box-shadow:0 .6mm 2mm rgba(0,0,0,.25);overflow:hidden;display:grid;place-items:center;font-size:16pt;font-weight:700;color:${p};z-index:1}
.photo img{width:100%;height:100%;object-fit:cover}
.body{flex:1;text-align:center;padding:11mm 4mm 0}
h1{font-size:11pt;margin:0;line-height:1.15}.role{color:${p};font-weight:600;font-size:8pt;margin-top:.8mm}.dept{color:#64748b;font-size:7pt}
.foot{display:flex;align-items:center;justify-content:space-between;gap:2mm;padding:2mm 4mm 3mm}
.id{font-size:6pt;color:#64748b;text-transform:uppercase;letter-spacing:.12em}.id b{display:block;font-size:10pt;color:#0f172a;letter-spacing:.04em;font-family:ui-monospace,monospace}
.qr svg{width:16mm;height:16mm;display:block}
.stripe{height:2.5mm;background:${p}}
.back .band{height:12mm}.back .band:after{display:none}
.back .body{padding:4mm 4mm 0;text-align:left}
.kv{display:flex;justify-content:space-between;gap:2mm;border-bottom:.2mm solid #e2e8f0;padding:1.2mm 0;font-size:7pt}.kv span{color:#64748b}
.note{font-size:6.5pt;color:#475569;margin-top:3mm;text-align:center}
.sign{margin-top:auto;padding:0 4mm 3mm;text-align:center;font-size:6pt;color:#64748b}.sign i{display:block;border-top:.2mm solid #94a3b8;margin:0 6mm 1mm;height:9mm}
.noprint{position:fixed;right:4mm;bottom:4mm}@media print{.noprint{display:none}}
</style></head><body>
<section class="card front">
  <div class="band"><div class="co">${logo ? `<img class="${dark ? 'on-dark' : ''}" src="${esc(logo)}" alt="">` : ''}<span>${esc(d.company.name)}</span></div><div class="tag">Employee identity card</div></div>
  <div class="photo">${d.photoUrl ? `<img src="${esc(d.photoUrl)}" alt="">` : esc(initials)}</div>
  <div class="body"><h1>${esc(d.name)}</h1>${d.designation ? `<div class="role">${esc(d.designation)}</div>` : ''}${d.department || d.branch ? `<div class="dept">${esc([d.department, d.branch].filter(Boolean).join(' · '))}</div>` : ''}</div>
  <div class="foot"><div class="id">Employee ID<b>${esc(d.code)}</b></div><div class="qr">${this.qrSvg(d.qr)}</div></div>
  <div class="stripe"></div>
</section>
<section class="card back">
  <div class="band"><div class="co">${esc(d.company.name)}</div></div>
  <div class="body">
    ${row('Employee ID', d.code)}${row('Joined', dt(d.joinDate))}${row('CNIC', d.cnic)}${row('Phone', d.phone)}${row('Emergency', d.emergency)}${row('Issued', dt(new Date()))}
    <div class="note">This card is company property and must be shown on request.<br>If found, please return to:<br><b>${esc(d.company.name)}</b>${d.company.address ? `<br>${esc(d.company.address)}` : ''}${d.company.phone ? `<br>${esc(d.company.phone)}` : ''}</div>
  </div>
  <div class="sign"><i></i>Authorised signature</div>
  <div class="stripe"></div>
</section>
<button class="noprint" onclick="print()">Print</button><script>addEventListener('load',()=>print())</script>
</body></html>`;
  }

  /** Mustache-lite for admin-edited templates: {{field}} (escaped) and {{{raw}}}. */
  fill(tpl: string, vars: Record<string, unknown>) {
    return tpl.replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => String(vars[k] ?? '')).replace(/\{\{(\w+)\}\}/g, (_, k) => esc(vars[k]));
  }
}
