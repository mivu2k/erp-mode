'use client';
import { Card, cx, FieldMeta, formatCell, humanize, RichView } from '@erp/ui';
import { RESOURCE_MAP } from '@erp/shared';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from './api';

type Rec = Record<string, unknown> & { _refs?: Record<string, string | null> };
const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
const label = (f: FieldMeta) => f.label ?? humanize(f.name);
const money = (v: unknown) => Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One value, read-only: linked records are links, lists are chips, long text keeps its line breaks. */
function Value({ rec, f }: { rec: Rec; f: FieldMeta }) {
  const v = rec[f.name];
  if (f.ref && rec._refs?.[f.name] === '—') return '—';
  if (f.ref && typeof v === 'string') return <Link className="text-primary hover:underline" href={`/r/${f.ref}/${v}`}>{rec._refs?.[f.name] ?? v}</Link>;
  // refType+refId / sourceType+sourceId: the type reads as its label, the id as the linked record's number.
  const pairType = rec[f.name.replace(/Id$/, 'Type')];
  if (/(ref|source)Id$/.test(f.name) && typeof pairType === 'string' && typeof v === 'string') {
    const name = rec._refs?.[f.name];
    return !name || name === '—' ? '—' : <Link className="text-primary hover:underline" href={`/r/${pairType}/${v}`}>{name}</Link>;
  }
  if (/(ref|source)Type$/.test(f.name) && typeof v === 'string') return <>{RESOURCE_MAP[v]?.label ?? humanize(v)}</>;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return <span className="flex flex-wrap justify-end gap-1">{v.map((x) => <span key={String(x)} className="rounded-full bg-muted px-2 py-0.5 text-xs">{String(x)}</span>)}</span>;
  if (f.type === 'bool') return <span>{v ? 'Yes' : 'No'}</span>;
  if (f.type === 'richtext') return <RichView html={String(v)} className="text-start" />;
  if (f.type === 'text') return <span className="whitespace-pre-line">{String(v)}</span>;
  return <>{formatCell(rec as never, f, f.name)}</>;
}

/** Document header for a posted/locked record: what it is, its state, for whom and how much. */
export function DocHeader({ rec, title, kind, amount, party, date }: { rec: Rec; title: string; kind: string; amount?: number | null; party?: { label: string; href?: string; name?: string | null }; date?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{kind} · {title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {typeof rec.status === 'string' && <span className="text-muted-foreground">Read-only — {humanize(rec.status)}</span>}
            {date && <span className="text-muted-foreground">{date}</span>}
            {party?.name && <span className="text-base font-semibold">{party.href ? <Link className="text-primary hover:underline" href={party.href}>{party.name}</Link> : party.name}<span className="ms-1 text-xs font-normal text-muted-foreground">({party.label})</span></span>}
          </div>
        </div>
        {amount != null && (
          <div className="text-end">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{rec.approvedTotal != null ? 'Approved' : 'Amount'}</div>
            <div className="text-3xl font-semibold tabular-nums">{money(amount)}</div>
            {rec.approvedTotal != null && rec.total != null && <div className="text-xs text-muted-foreground">of {money(rec.total)} claimed</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Label/value grid of the filled-in fields; empty ones are hidden (count shown). */
export function ReadDetails({ rec, fields, title = 'Details' }: { rec: Rec; fields: FieldMeta[]; title?: string }) {
  const zero = (f: FieldMeta) => ['money', 'decimal'].includes(f.type) && Number(rec[f.name]) === 0;
  const filled = fields.filter((f) => !empty(rec[f.name]) && !zero(f) && f.type !== 'json' || (f.type === 'json' && Array.isArray(rec[f.name]) && (rec[f.name] as unknown[]).length && (rec[f.name] as unknown[]).every((x) => typeof x === 'string')));
  const long = (f: FieldMeta) => f.type === 'text' || f.type === 'richtext' || String(rec[f.name] ?? '').length > 60;
  const hidden = fields.length - filled.length;
  return (
    <Card title={title} actions={hidden > 0 ? <span className="text-xs text-muted-foreground">{hidden} empty field{hidden > 1 ? 's' : ''} hidden</span> : undefined}>
      {filled.length ? (
        <dl className="grid gap-x-8 sm:grid-cols-2">
          {filled.map((f) => (
            <div key={f.name} className={cx('flex items-baseline justify-between gap-4 border-b border-dashed border-border py-2.5 text-sm', long(f) && 'flex-col items-stretch gap-1 sm:col-span-2')}>
              <dt className="shrink-0 text-muted-foreground">{label(f)}</dt>
              <dd className={cx('min-w-0 font-medium', long(f) ? 'text-start' : 'text-end')}><Value rec={rec} f={f} /></dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-sm text-muted-foreground">Nothing filled in.</p>}
    </Card>
  );
}

const SUM = new Set(['amount', 'total', 'lineTotal', 'tax', 'qty', 'debit', 'credit', 'approved']);
/** Line items as a read-only table with a totals row for amount-like columns. */
export function ReadLines({ title, rows: raw, fields: rawFields }: { title: string; rows: Rec[]; fields: FieldMeta[] }): ReactNode {
  // Priced lines without an amount (quotations): show qty × price so the total means money, not a count.
  const priced = rawFields.some((f) => f.name === 'qty') && rawFields.some((f) => f.name === 'price') && !rawFields.some((f) => f.name === 'amount');
  const rows: Rec[] = priced ? raw.map((r) => ({ ...r, amount: (Number(r.qty) || 0) * (Number(r.price) || 0) })) : raw;
  const fields: FieldMeta[] = priced ? [...rawFields, { name: 'amount', type: 'money', label: 'Amount' }] : rawFields;
  const cols = fields.filter((f) => rows.some((r) => !empty(r[f.name]) && r[f.name] !== 0 && r[f.name] !== '0'));
  const num = (f: FieldMeta) => ['money', 'decimal', 'int', 'float', 'number'].includes(f.type);
  const sums = cols.map((f) => (num(f) && SUM.has(f.name) ? rows.reduce((s, r) => s + (Number(r[f.name]) || 0), 0) : null));
  return (
    <Card title={<span>{title} <span className="ms-1 text-xs font-normal text-muted-foreground">{rows.length} line{rows.length === 1 ? '' : 's'}</span></span>}>
      {rows.length ? (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="w-10 px-5 py-2 text-start font-medium">#</th>{cols.map((f) => <th key={f.name} className={cx('px-3 py-2 font-medium', num(f) ? 'text-end' : 'text-start')}>{label(f)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={String(r.id ?? i)} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2 text-muted-foreground">{i + 1}</td>
                  {cols.map((f) => <td key={f.name} className={cx('px-3 py-2', num(f) && 'text-end tabular-nums')}>{empty(r[f.name]) ? <span className="text-muted-foreground">—</span> : <Value rec={r} f={f} />}</td>)}
                </tr>
              ))}
            </tbody>
            {sums.some((s) => s !== null) && (
              <tfoot className="border-t-2 border-border font-semibold">
                <tr><td className="px-5 py-2 text-xs uppercase text-muted-foreground">Total</td>{sums.map((s, i) => <td key={cols[i].name} className="px-3 py-2 text-end tabular-nums">{s === null ? '' : cols[i].name === 'qty' ? s.toLocaleString() : money(s)}</td>)}</tr>
              </tfoot>
            )}
          </table>
        </div>
      ) : <p className="text-sm text-muted-foreground">No lines.</p>}
    </Card>
  );
}

export const objectList = (v: unknown): v is Rec[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));

/** Lines kept as JSON on the record (invoice/quotation lines): columns from the data, ids hidden, qty × price = amount. */
export function JsonLines({ title, rows }: { title: string; rows: Rec[] }) {
  const skip = (k: string) => k === '_refs' || k === 'kind' || k === 'refId' || k === 'id' || k.endsWith('Id');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !skip(k));
  const order = ['description', 'name', 'serial', 'qty', 'unit', 'price', 'discount', 'tax'];
  keys.sort((a, b) => (order.indexOf(a) + 1 || 50) - (order.indexOf(b) + 1 || 50));
  const priced = keys.includes('qty') && keys.includes('price') && !keys.includes('amount');
  const data = priced ? rows.map((r) => ({ ...r, amount: (Number(r.qty) || 0) * (Number(r.price) || 0) })) : rows;
  const cols = [...keys, ...(priced ? ['amount'] : [])];
  const fields: FieldMeta[] = cols.map((k) => ({ name: k, type: data.every((r) => r[k] == null || r[k] === '' || typeof r[k] === 'number') ? (k === 'qty' ? 'float' : 'money') : 'string', label: k === 'qty' ? 'Qty' : humanize(k) }));
  return <ReadLines title={title} rows={data} fields={fields} />;
}

/** What a system-posted journal means, in words, keyed by the memo the ledger writes. */
const MEANING: [RegExp, string][] = [
  [/^Expense claim /, 'Books the approved expense. No cash moves here: the company now owes the employee this amount. Cash goes out in the "Reimbursement" entries — one per payment, so a half-paid claim has one of those for the half paid.'],
  [/^Reimbursement /, 'Cash paid to the employee against their claim. It reduces what the company owes them; any part not yet paid stays on their account.'],
  [/^Advance /, 'Cash given to the employee as an advance; they owe it back until it is settled by claims or salary deductions.'],
];

/** Journal lines as an accountant reads them: account, who, debit, credit, and a balanced total. */
export function JournalLines({ rec }: { rec: Rec }): ReactNode {
  const lines = (rec.lines as Rec[] | undefined) ?? [];
  const sum = (k: string) => lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const [dr, cr] = [sum('debit'), sum('credit')];
  const meaning = MEANING.find(([re]) => re.test(String(rec.memo ?? '')))?.[1];
  const refs = (l: Rec) => l._refs ?? {};
  const cell = (v: unknown) => (Number(v) ? money(v) : '');
  return (
    <Card title="Entry" actions={<span className={cx('text-xs font-medium', Math.abs(dr - cr) < 0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600')}>{Math.abs(dr - cr) < 0.005 ? 'Balanced' : `Out of balance by ${money(dr - cr)}`}</span>}>
      {meaning && <p className="mb-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">{meaning}</p>}
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-5 py-2 text-start font-medium">Account</th><th className="px-3 py-2 text-start font-medium">Employee / party</th><th className="px-3 py-2 text-start font-medium">Memo</th><th className="px-3 py-2 text-end font-medium">Debit</th><th className="px-5 py-2 text-end font-medium">Credit</th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={String(l.id)} className="border-b border-border/60 last:border-0">
                {/* Credits are indented, the way a journal is written by hand. */}
                <td className={cx('px-5 py-2', Number(l.credit) > 0 && 'ps-10')}><Link className="text-primary hover:underline" href={`/r/finance.account/${l.accountId}`}>{refs(l).accountId ?? '—'}</Link></td>
                <td className="px-3 py-2 text-muted-foreground">{refs(l).employeeId ?? (l.partyType ? humanize(String(l.partyType)) : '')}</td>
                <td className="px-3 py-2 text-muted-foreground">{String(l.memo ?? '')}</td>
                <td className="px-3 py-2 text-end tabular-nums">{cell(l.debit)}</td>
                <td className="px-5 py-2 text-end tabular-nums">{cell(l.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border font-semibold">
            <tr><td className="px-5 py-2" colSpan={3}>Total</td><td className="px-3 py-2 text-end tabular-nums">{money(dr)}</td><td className="px-5 py-2 text-end tabular-nums">{money(cr)}</td></tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

/** Where a booked claim's money stands: approved, covered by the advance, reimbursed so far, still owed. */
export function ClaimProgress({ rec }: { rec: Rec }): ReactNode {
  const n = (k: string) => Number(rec[k]) || 0;
  const approved = rec.approvedTotal != null ? n('approvedTotal') : n('total');
  const [adv, paid] = [n('fromAdvance'), n('reimbursed')];
  const owed = Math.max(approved - adv - paid, 0);
  const pct = (v: number) => `${approved ? (v / approved) * 100 : 0}%`;
  const items: [string, number, string][] = [['From advance', adv, 'bg-sky-500'], ['Reimbursed', paid, 'bg-emerald-500'], ['Still owed', owed, 'bg-amber-400']];
  return (
    <Card title="Payment progress" actions={<span className="text-xs text-muted-foreground">Approved {money(approved)}</span>}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={items.map(([l, v]) => `${l} ${money(v)}`).join(', ')}>
        {items.map(([l, v, c]) => v > 0 && <div key={l} className={c} style={{ width: pct(v) }} />)}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        {items.map(([l, v, c]) => (
          <div key={l}><dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cx('size-2 rounded-full', c)} />{l}</dt><dd className="font-semibold tabular-nums">{money(v)}</dd></div>
        ))}
      </dl>
      {n('refundDue') > 0 && <p className="mt-2 text-xs text-muted-foreground">Employee returns {money(n('refundDue'))} of unspent advance.</p>}
    </Card>
  );
}

/** A quotation/invoice shows the equipment it is about, read from its repair job. */
export function RepairUnit({ jobId }: { jobId: string }): ReactNode {
  const [j, setJ] = useState<Rec | null>(null);
  useEffect(() => { api<Rec>(`r/repair.job/${jobId}`).then(setJ).catch(() => setJ(null)); }, [jobId]);
  if (!j) return null;
  const rows: [string, unknown][] = ([
    ['Device', [j.brand, j.model, j.productType && `(${j.productType})`].filter(Boolean).join(' ')],
    ['Serial', j.serial], ['Asset tag', j.assetTag],
    ['Accessories', Array.isArray(j.accessories) ? (j.accessories as string[]).join(', ') : ''],
    ['Reported fault', j.fault], ['Findings', (j.diagnosis as { findings?: string } | null)?.findings],
    ['Technician', j._refs?.technicianId], ['Status', humanize(String(j.status ?? ''))],
  ] as [string, unknown][]).filter(([, v]) => v);
  return (
    <Card title="Equipment" actions={<Link className="text-xs text-primary hover:underline" href={`/r/repair.job/${jobId}`}>Open job {String(j.number ?? '')}</Link>}>
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border py-1"><dt className="text-muted-foreground">{k}</dt><dd className="text-end">{String(v)}</dd></div>)}
      </dl>
    </Card>
  );
}
