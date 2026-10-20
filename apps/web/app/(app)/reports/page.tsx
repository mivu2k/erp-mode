'use client';
import { BarChart, Button, Card, EmptyState, ErrorBox, humanize, Input, KpiCard, Label, PageHeader, Select, Tabs } from '@erp/ui';
import { StandardReports } from './StandardReports';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, raw } from '@/lib/api';
import { useMeta } from '@/lib/meta';
import { RefPicker } from '@/lib/RefPicker';

interface Def { resource: string; columns: string[]; groupBy: string[]; aggregates: { field: string; fn: string }[]; filters: Record<string, unknown>; chart?: { type: string } }
interface Out { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
interface Saved { id: string; name: string; definition: Def }

const cellOf = (r: Record<string, unknown>, c: string) => String((r._refs as Record<string, unknown> | undefined)?.[c] ?? r[c] ?? '');

type Cond = { field: string; value: unknown };
const DATE = ['date', 'datetime'];

/** Saved filters → the simple form: one date range (bound to $from/$to) and "field is value" conditions. */
function fromFilters(filters: Record<string, unknown>) {
  let dateField = '';
  const conds: Cond[] = [];
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && ((v as Record<string, unknown>).gte === '$from' || (v as Record<string, unknown>).lte === '$to')) dateField = k;
    else conds.push({ field: k, value: v && typeof v === 'object' && 'eq' in (v as object) ? (v as { eq: unknown }).eq : v });
  }
  return { dateField, conds };
}

/**
 * Report builder in plain steps: what to show, split by what, count or total, only where…, and a date range.
 * The saved definition is the same as before ($from/$to bound to the chosen date field), so saved reports keep their period box.
 */
function Builder() {
  const meta = useMeta();
  const [def, setDef] = useState<Def>({ resource: 'repair.job', columns: [], groupBy: ['status'], aggregates: [], filters: {}, chart: { type: 'bar' } });
  const [conds, setConds] = useState<Cond[]>([]);
  const [dateField, setDateField] = useState('createdAt');
  const [params, setParams] = useState({ from: '', to: '' });
  const [out, setOut] = useState<Out | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState<unknown>(null);
  const res = meta.resources.find((r) => r.key === def.resource);
  const label = (name: string) => res?.fields.find((f) => f.name === name)?.label ?? (name === 'createdAt' ? 'Created on' : humanize(name.replace(/Id$/, '')));
  // Fields a person would split or filter by: no raw ids (only linked ones), no JSON / long text.
  const usable = useMemo(() => res?.fields.filter((f) => !['json', 'text', 'richtext'].includes(f.type) && (!/Id$/.test(f.name) || f.ref)) ?? [], [res]);
  const numeric = useMemo(() => res?.fields.filter((f) => ['int', 'float', 'money', 'decimal'].includes(f.type)) ?? [], [res]);
  const dates = useMemo(() => [{ name: 'createdAt', type: 'datetime' }, ...(res?.fields.filter((f) => DATE.includes(f.type)) ?? [])], [res]);
  const loadSaved = () => api<Saved[]>('reports/available').then(setSaved).catch(() => {});
  useEffect(() => { loadSaved(); }, []);

  const definition = (): Def => ({
    ...def,
    filters: {
      ...Object.fromEntries(conds.filter((c) => c.field && c.value !== '' && c.value != null).map((c) => [c.field, c.value])),
      ...(dateField ? { [dateField]: { gte: '$from', lte: '$to' } } : {}),
    },
  });
  const body = () => ({ definition: definition(), params });
  const run = async () => { setError(null); try { setOut(await api<Out>('reports/run', 'POST', body())); } catch (e) { setError(e); } };
  const exportAs = async (format: string) => {
    try {
      const r = await raw('reports/run', { method: 'POST', body: JSON.stringify({ ...body(), format }) });
      const url = URL.createObjectURL(await r.blob());
      if (format === 'html') window.open(url, '_blank');
      else Object.assign(document.createElement('a'), { href: url, download: `report.${format}` }).click();
    } catch (e) { setError(e); }
  };
  const save = async () => {
    const name = prompt('Report name');
    if (!name) return;
    try { const rec = await api<{ id: string }>('r/reports.report', 'POST', { name, definition: definition() }); window.location.assign(`/reports/saved/${rec.id}`); } catch (e) { setError(e); }
  };
  const pickSource = (resource: string) => { setDef({ resource, columns: [], groupBy: [], aggregates: [], filters: {}, chart: def.chart }); setConds([]); setDateField('createdAt'); setOut(null); };
  const open = (s: Saved) => {
    const f = fromFilters(s.definition.filters as Record<string, unknown>);
    setDef({ ...s.definition, columns: s.definition.columns ?? [], groupBy: s.definition.groupBy ?? [], aggregates: s.definition.aggregates ?? [], filters: {} });
    setConds(f.conds); setDateField(f.dateField); setOut(null);
  };
  const total = def.aggregates[0];
  const y = out && def.groupBy.length ? out.columns.find((c) => c !== def.groupBy[0] && !def.groupBy.includes(c)) ?? 'count' : null;
  const valueInput = (c: Cond, i: number) => {
    const f = res?.fields.find((x) => x.name === c.field);
    const set = (value: unknown) => setConds(conds.map((x, j) => (j === i ? { ...x, value } : x)));
    const opts = f?.options ?? (f?.name === 'status' ? res?.statuses : undefined);
    if (!f) return <Input disabled placeholder="value" />;
    if (opts?.length) return <Select aria-label={`${label(f.name)} is`} value={String(c.value ?? '')} onChange={(e) => set(e.target.value)}><option value="">— any —</option>{opts.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}</Select>;
    if (f.ref) return <RefPicker f={f} value={c.value} onChange={set} />;
    if (f.type === 'bool') return <Select aria-label={`${label(f.name)} is`} value={String(c.value ?? '')} onChange={(e) => set(e.target.value === '' ? '' : e.target.value === 'true')}><option value="">— any —</option><option value="true">Yes</option><option value="false">No</option></Select>;
    return <Input aria-label={`${label(f.name)} is`} value={String(c.value ?? '')} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <>
      <PageHeader title="Report builder" actions={<><Button onClick={run}>Run</Button><Button variant="outline" onClick={save}>Save</Button>{out && ['html', 'xlsx'].map((f) => <Button key={f} variant="ghost" onClick={() => exportAs(f)}>{f === 'html' ? 'Print / PDF' : 'Excel'}</Button>)}</>} />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card title="Build">
            <ol className="space-y-4 text-sm">
              <li><Label htmlFor="src">1. Show me</Label>
                <Select id="src" value={def.resource} onChange={(e) => pickSource(e.target.value)}>
                  {meta.modules.map((m) => { const rs = meta.resources.filter((r) => (r.group ?? r.key.split('.')[0]) === m.key); return rs.length ? <optgroup key={m.key} label={m.label}>{rs.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup> : null; })}
                </Select></li>
              <li><Label htmlFor="by">2. Split by</Label>
                <Select id="by" value={def.groupBy[0] ?? ''} onChange={(e) => setDef({ ...def, groupBy: e.target.value ? [e.target.value] : [] })}>
                  <option value="">Nothing — list every row</option>{usable.map((f) => <option key={f.name} value={f.name}>{label(f.name)}</option>)}
                </Select></li>
              <li><Label htmlFor="sum">3. Show</Label>
                <Select id="sum" value={total ? `${total.fn}:${total.field}` : ''} onChange={(e) => { const [fn, field] = e.target.value.split(':'); setDef({ ...def, aggregates: field ? [{ fn, field }] : [] }); }}>
                  <option value="">How many (count)</option>
                  {numeric.map((f) => <option key={f.name} value={`sum:${f.name}`}>Total {label(f.name).toLowerCase()}</option>)}
                  {numeric.map((f) => <option key={`a${f.name}`} value={`avg:${f.name}`}>Average {label(f.name).toLowerCase()}</option>)}
                </Select></li>
              <li><Label>4. Only where</Label>
                <div className="space-y-2">
                  {conds.map((c, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1">
                      <Select aria-label="Field" value={c.field} onChange={(e) => setConds(conds.map((x, j) => (j === i ? { field: e.target.value, value: '' } : x)))}>
                        <option value="">— field —</option>{usable.filter((f) => !DATE.includes(f.type)).map((f) => <option key={f.name} value={f.name}>{label(f.name)}</option>)}
                      </Select>
                      {valueInput(c, i)}
                      <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => setConds(conds.filter((_, j) => j !== i))}>✕</Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => setConds([...conds, { field: '', value: '' }])}>+ Add condition</Button>
                </div></li>
              <li><Label htmlFor="df">5. Date range on</Label>
                <Select id="df" value={dateField} onChange={(e) => setDateField(e.target.value)}>
                  <option value="">No date range</option>{dates.map((f) => <option key={f.name} value={f.name}>{label(f.name)}</option>)}
                </Select>
                {dateField && <div className="mt-1 grid grid-cols-2 gap-1">
                  <div><Label htmlFor="pf">From</Label><Input id="pf" type="date" value={params.from} onChange={(e) => setParams({ ...params, from: e.target.value })} /></div>
                  <div><Label htmlFor="pt">To</Label><Input id="pt" type="date" value={params.to} onChange={(e) => setParams({ ...params, to: e.target.value })} /></div>
                </div>}</li>
            </ol>
            {!def.groupBy.length && (
              <details className="mt-4 text-sm"><summary className="cursor-pointer text-xs text-muted-foreground">Choose columns ({def.columns.length || 'default'})</summary>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {res?.fields.filter((f) => f.type !== 'json').map((f) => (
                    <label key={f.name} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={def.columns.includes(f.name)} onChange={(e) => setDef({ ...def, columns: e.target.checked ? [...def.columns, f.name] : def.columns.filter((c) => c !== f.name) })} />{label(f.name)}</label>
                  ))}
                </div>
              </details>
            )}
          </Card>
          <Card title="Saved reports">
            {!saved.length ? <EmptyState title="None yet" /> : (
              <ul className="space-y-1 text-sm">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <button className="truncate text-start text-primary hover:underline" onClick={() => open(s)}>{s.name}</button>
                    <a className="text-xs text-muted-foreground hover:underline" href={`/reports/saved/${s.id}`}>Open</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          <ErrorBox error={error} />
          {!out ? <Card><EmptyState title="Pick what to show and press Run" hint="Then Save it to keep it, share it with roles or have it emailed." /></Card> : (
            <>
              {out.rows.length === 1 && def.groupBy.length === 0 && def.aggregates.length > 0 && <KpiCard label={humanize(out.columns[0])} value={cellOf(out.rows[0], out.columns[0])} />}
              {y && <Card title={`${humanize(y)} by ${label(def.groupBy[0])}`}><BarChart label="Report chart" data={out.rows.map((r) => ({ label: cellOf(r, def.groupBy[0]) || '—', value: Number(r[y] ?? 0) }))} /></Card>}
              <Card title={`${out.rows.length} rows${out.truncated ? ' (limit reached — export for more)' : ''}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-xs text-muted-foreground"><tr>{out.columns.map((c) => <th key={c} className="px-2 py-1.5 text-start font-medium">{humanize(c)}</th>)}</tr></thead>
                    <tbody>{out.rows.map((r, i) => <tr key={i} className="border-t border-border">{out.columns.map((c) => <td key={c} className="px-2 py-1.5">{cellOf(r, c) || '—'}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Reports: the standard library (ready-made, per module) and the builder for anything else. */
export default function Reports() {
  const meta = useMeta();
  const canBuild = meta.user.permissions['reports.builder.view'] !== undefined;
  // ?tab=builder (e.g. "New" on saved reports) opens straight on the builder.
  const [tab, setTab] = useState(useSearchParams().get('tab') === 'builder' && canBuild ? 'builder' : 'standard');
  return (
    <>
      {tab === 'standard' && <PageHeader title="Reports" subtitle="Standard reports for every module — pick one, set the period, export" />}
      {canBuild && <Tabs value={tab} onChange={setTab} tabs={[{ key: 'standard', label: 'Standard reports' }, { key: 'builder', label: 'Report builder' }]} />}
      {tab === 'standard' ? <StandardReports /> : <Builder />}
    </>
  );
}
