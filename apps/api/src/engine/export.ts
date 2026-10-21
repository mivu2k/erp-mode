import ExcelJS from 'exceljs';
import { Row } from './hooks';

/**
 * How an export reads: column headers in words, date-times in the company's timezone,
 * and coded values (status, kind, document type) as words.
 */
export interface ExportOpts { headers?: string[]; tz?: string; values?: Record<string, (v: string) => string> }

/** Human value for a cell: ref titles instead of ids, dates as ISO date, times in `tz` when given. */
export function cell(row: Row, field: string, opts: ExportOpts = {}): string | number {
  const refs = row._refs as Row | undefined;
  if (refs && field in refs) return String(refs[field] ?? '');
  const v = field.startsWith('custom.') ? (row.custom as Row | null)?.[field.slice(7)] : row[field];
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) {
    if (v.toISOString().endsWith('T00:00:00.000Z')) return v.toISOString().slice(0, 10);
    if (!opts.tz) return v.toISOString().slice(0, 16).replace('T', ' ');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: opts.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(v).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }
  if (typeof v === 'string' && opts.values?.[field]) return opts.values[field](v);
  // Other stored codes (rotating_qr, half_day…) read as words in a worded export.
  if (typeof v === 'string' && opts.headers && /^[a-z]+(_[a-z]+)+$/.test(v)) return v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ');
  if (typeof v === 'object') return 'toFixed' in (v as object) ? Number(v) : JSON.stringify(v);
  return typeof v === 'number' ? v : String(v);
}

export function toCsv(columns: string[], rows: Row[], opts: ExportOpts = {}): string {
  const q = (v: unknown) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [(opts.headers ?? columns).map(q).join(','), ...rows.map((r) => columns.map((c) => q(cell(r, c, opts))).join(','))].join('\r\n');
}

export async function toXlsx(title: string, columns: string[], rows: Row[], opts: ExportOpts = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31));
  const head = opts.headers ?? columns;
  ws.columns = columns.map((c, i) => ({ header: head[i], key: c, width: Math.max(12, head[i].length + 2) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c, cell(r, c, opts)])));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface TableReport {
  title: string;
  company: { name: string; address?: string | null; phone?: string | null; taxId?: string | null; branding?: unknown };
  columns: string[];
  rows: Row[];
  fields?: [string, unknown][];
  totals?: [string, unknown][];
}

/** One report, four outputs: json (default), csv, xlsx, html (printable → PDF via browser). */
export async function sendReport(res: import('express').Response, format: string | undefined, r: TableReport) {
  const name = `${r.title}-${new Date().toISOString().slice(0, 10)}`.replace(/[^\w.-]+/g, '_');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(r.columns, r.rows));
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(await toXlsx(r.title, r.columns, r.rows));
  }
  if (format === 'html' || format === 'pdf') {
    const { PrintService } = await import('../platform/print.service');
    const html = new PrintService().render({
      company: r.company, title: r.title, fields: r.fields ?? [], totals: r.totals,
      lines: { columns: r.columns, rows: r.rows.map((row) => r.columns.map((c) => cell(row, c))) },
    });
    return sendHtmlOrPdf(res, format, html, name);
  }
  return res.json({ columns: r.columns, rows: r.rows, fields: r.fields, totals: r.totals });
}

/** Sends printable HTML, or the same HTML rendered to PDF by headless Chromium. */
export async function sendHtmlOrPdf(res: import('express').Response, format: string | undefined, html: string, name: string, thermalWidthMm?: number) {
  if (format === 'pdf') {
    const { PdfService } = await import('../platform/pdf.service');
    const pdf = await PdfService.instance.render(html, thermalWidthMm);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
    return res.send(pdf);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}
