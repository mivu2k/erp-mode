'use client';
import { BarChart, Button, Card, cx, EmptyState, ErrorBox, humanize, Input, Label, Select } from '@erp/ui';
import type { StandardReport } from '@erp/shared';
import { MODULES } from '@erp/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';

interface Out { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const PRESETS: [string, () => [string, string]][] = [
  ['This month', () => [iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1))), iso(today)]],
  ['Last month', () => [iso(new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1))), iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0)))]],
  ['This quarter', () => [iso(new Date(Date.UTC(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1))), iso(today)]],
  ['This year', () => [`${today.getFullYear()}-01-01`, iso(today)]],
];
/** sum_total → "Total", count → "Count", cost_per_litre → "Cost per litre". */
const colLabel = (c: string) => humanize(c.replace(/^(sum|avg|min|max)_/, (_, f) => (f === 'sum' ? '' : `${f} `)).replace(/Id$/, ''));
const cell = (r: Record<string, unknown>, c: string) => (r._refs as Record<string, unknown> | undefined)?.[c] ?? r[c];
const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && !/^\d{4}-\d{2}/.test(v));
const fmt = (v: unknown) => (v == null || v === '' ? '—' : isNum(v) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? String(v).slice(0, 10) : humanize(String(v)));

/** Ready-made reports per module: pick, set the period/branch, read, export. */
export function StandardReports() {
  const [list, setList] = useState<StandardReport[]>([]);
  const [key, setKey] = useState('');
  const [q, setQ] = useState('');
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[0][1]());
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [out, setOut] = useState<Out | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<StandardReport[]>('reports/standard').then((l) => { setList(l); setKey((k) => k || l[0]?.key || ''); }).catch(setError);
    api<{ rows: { id: string; name: string }[] }>('r/core.branch?pageSize=100').then((d) => setBranches(d.rows)).catch(() => {});
  }, []);
  const rep = list.find((r) => r.key === key);
  const params = qs({ from, to, branchId });
  useEffect(() => {
    if (!key) return;
    setBusy(true); setError(null);
    api<Out>(`reports/standard/${key}?${params}`).then(setOut).catch(setError).finally(() => setBusy(false));
  }, [key, params]);

  const groups = useMemo(() => {
    const f = list.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
    return [...new Set(f.map((r) => r.module))].map((m) => ({ m, label: MODULES[m]?.label ?? humanize(m), items: f.filter((r) => r.module === m) }));
  }, [list, q]);
  const numericCols = out ? out.columns.filter((c) => out.rows.some((r) => isNum(r[c])) && !/Id$/.test(c) && !['period', 'type', 'status', 'direction', 'purpose'].includes(c)) : [];
  const valueCol = numericCols.find((c) => c.startsWith('sum_')) ?? (out?.columns.includes('count') ? 'count' : numericCols[0]);
  const labelCols = rep?.groupBy ?? [];
  const chart = rep?.groupBy?.length && out?.rows.length && valueCol
    ? out.rows.map((r) => ({ label: labelCols.map((g) => fmt(cell(r, g))).join(' · '), value: Number(r[valueCol]) || 0 })).sort((a, b) => b.value - a.value).slice(0, 15) : null;
  const totals = out && out.rows.length > 1 ? Object.fromEntries(numericCols.filter((c) => !/per_|avg_|min_|max_/.test(c)).map((c) => [c, out.rows.reduce((s, r) => s + (Number(r[c]) || 0), 0)])) : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_1fr]">
      <Card className="lg:sticky lg:top-20">
        <Input aria-label="Find report" placeholder="Find a report…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        <nav className="max-h-[70vh] space-y-3 overflow-y-auto" aria-label="Standard reports">
          {groups.map((g) => (
            <div key={g.m}>
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
              {g.items.map((r) => (
                <button key={r.key} type="button" onClick={() => setKey(r.key)} aria-current={r.key === key}
                  className={cx('block w-full rounded-md px-2 py-1.5 text-start text-sm transition', r.key === key ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>{r.name}</button>
              ))}
            </div>
          ))}
          {!groups.length && <p className="px-2 text-sm text-muted-foreground">No report matches.</p>}
        </nav>
      </Card>

      <div className="min-w-0 space-y-4">
        {rep && (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{MODULES[rep.module]?.label ?? rep.module}</div>
                <h2 className="text-lg font-semibold">{rep.name}</h2>
                <p className="text-sm text-muted-foreground">{rep.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {[['xlsx', 'Excel'], ['pdf', 'PDF'], ['csv', 'CSV'], ['html', 'Print']].map(([f, l]) => (
                  <Button key={f} size="sm" variant="outline" onClick={() => openDoc(`reports/standard/${key}?${params}&format=${f}`).catch(setError)}>{l}</Button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
              {rep.dateField ? (
                <>
                  <div><Label htmlFor="rf">From</Label><Input id="rf" type="date" value={from} onChange={(e) => setRange([e.target.value, to])} /></div>
                  <div><Label htmlFor="rt">To</Label><Input id="rt" type="date" value={to} onChange={(e) => setRange([from, e.target.value])} /></div>
                  <div className="flex flex-wrap gap-1 pb-1">{PRESETS.map(([l, fn]) => <Button key={l} size="sm" variant="ghost" onClick={() => setRange(fn())}>{l}</Button>)}</div>
                </>
              ) : <span className="pb-2 text-sm text-muted-foreground">As of today</span>}
              <div className="ms-auto"><Label htmlFor="rb">Branch</Label>
                <Select id="rb" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-48"><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></div>
            </div>
          </Card>
        )}
        <ErrorBox error={error} />
        {chart && chart.length > 1 && <Card title={`${out!.rows.length > 15 ? 'Top 15 by ' : ''}${colLabel(valueCol!).toLowerCase()}`}><BarChart label={rep!.name} data={chart} /></Card>}
        {out && (
          <Card title={<span>{busy ? 'Loading…' : `${out.rows.length} row${out.rows.length === 1 ? '' : 's'}`}{out.truncated && <span className="ms-2 text-xs text-amber-500">(limit reached)</span>}</span>}>
            {!out.rows.length ? <EmptyState title="No data for this period" hint="Try a wider date range or all branches." /> : (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>{out.columns.map((c) => <th key={c} className={cx('px-4 py-2 font-medium', numericCols.includes(c) ? 'text-end' : 'text-start')}>{colLabel(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {out.rows.map((r, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        {out.columns.map((c) => <td key={c} className={cx('px-4 py-2', numericCols.includes(c) && 'text-end tabular-nums')}>{fmt(cell(r, c))}</td>)}
                      </tr>
                    ))}
                  </tbody>
                  {totals && Object.keys(totals).length > 0 && (
                    <tfoot className="border-t-2 border-border font-semibold">
                      <tr>{out.columns.map((c, i) => <td key={c} className={cx('px-4 py-2', numericCols.includes(c) && 'text-end tabular-nums')}>{c in totals ? fmt(totals[c]) : i === 0 ? 'Total' : ''}</td>)}</tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
