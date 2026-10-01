'use client';
import { BarChart, Button, Card, EmptyState, ErrorBox, humanize, Input, KpiCard, Label, PageHeader, Select, Tabs, Textarea } from '@erp/ui';
import { StandardReports } from './StandardReports';
import { useEffect, useMemo, useState } from 'react';
import { api, openDoc, raw } from '@/lib/api';
import { useMeta } from '@/lib/meta';

interface Def { resource: string; columns: string[]; groupBy: string[]; aggregates: { field: string; fn: string }[]; filters: Record<string, unknown>; chart?: { type: string } }
interface Out { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
interface Saved { id: string; name: string; definition: Def }

const cellOf = (r: Record<string, unknown>, c: string) => String((r._refs as Record<string, unknown> | undefined)?.[c] ?? r[c] ?? '');

/** Dynamic report builder over any registered resource; RBAC scope and field rules are enforced server-side. */
function Builder() {
  const meta = useMeta();
  const [def, setDef] = useState<Def>({ resource: 'repair.job', columns: [], groupBy: ['status'], aggregates: [], filters: {}, chart: { type: 'bar' } });
  const [filtersText, setFiltersText] = useState('{}');
  const [params, setParams] = useState({ from: '', to: '', period: '' });
  const [out, setOut] = useState<Out | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState<unknown>(null);
  const res = meta.resources.find((r) => r.key === def.resource);
  const numeric = useMemo(() => res?.fields.filter((f) => ['int', 'float', 'money', 'decimal'].includes(f.type)) ?? [], [res]);
  const loadSaved = () => api<Saved[]>('reports/available').then(setSaved).catch(() => {});
  useEffect(() => { loadSaved(); }, []);

  const body = () => {
    let filters = {};
    try { filters = JSON.parse(filtersText || '{}'); } catch { throw new Error('Filters must be valid JSON'); }
    return { definition: { ...def, filters }, params };
  };
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
    try { await api('r/reports.report', 'POST', { name, definition: body().definition }); loadSaved(); } catch (e) { setError(e); }
  };

  const y = out && def.groupBy.length ? out.columns.find((c) => c !== def.groupBy[0] && c !== 'count' && !def.groupBy.includes(c)) ?? 'count' : null;

  return (
    <>
      <PageHeader title="Report builder" actions={<><Button onClick={run}>Run</Button><Button variant="outline" onClick={save}>Save</Button>{out && ['html', 'xlsx', 'csv'].map((f) => <Button key={f} variant="ghost" onClick={() => exportAs(f)}>{f === 'html' ? 'Print/PDF' : f.toUpperCase()}</Button>)}</>} />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card title="Saved reports">
            {!saved.length ? <EmptyState title="None yet" /> : (
              <ul className="space-y-1 text-sm">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <button className="truncate text-start text-primary hover:underline" onClick={() => { setDef({ ...s.definition, columns: s.definition.columns ?? [], groupBy: s.definition.groupBy ?? [], aggregates: s.definition.aggregates ?? [], filters: {} }); setFiltersText(JSON.stringify(s.definition.filters ?? {}, null, 1)); setOut(null); }}>{s.name}</button>
                    <Button size="sm" variant="ghost" onClick={() => openDoc(`reports/${s.id}/run?format=html&from=${params.from}&to=${params.to}&period=${params.period}`)}>Print</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Definition">
            <div className="space-y-3 text-sm">
              <div><Label htmlFor="src">Data source</Label>
                <Select id="src" value={def.resource} onChange={(e) => { setDef({ resource: e.target.value, columns: [], groupBy: [], aggregates: [], filters: {}, chart: def.chart }); setOut(null); }}>
                  {meta.resources.map((r) => <option key={r.key} value={r.key}>{r.label} ({r.key.split('.')[0]})</option>)}
                </Select>
              </div>
              <div><Label>Group by (up to 3)</Label>
                {[0, 1, 2].map((i) => (
                  <Select key={i} className="mb-1" value={def.groupBy[i] ?? ''} onChange={(e) => { const g = [...def.groupBy]; g[i] = e.target.value; setDef({ ...def, groupBy: g.filter(Boolean) }); }}>
                    <option value="">—</option>{res?.fields.filter((f) => f.type !== 'json' && f.type !== 'text').map((f) => <option key={f.name} value={f.name}>{humanize(f.name)}</option>)}
                  </Select>
                ))}
              </div>
              <div><Label>Aggregates</Label>
                {[...def.aggregates, { field: '', fn: 'sum' }].map((a, i) => (
                  <div key={i} className="mb-1 flex gap-1">
                    <Select value={a.fn} onChange={(e) => { const x = [...def.aggregates]; x[i] = { ...a, fn: e.target.value }; setDef({ ...def, aggregates: x.filter((z) => z.field) }); }} className="w-24">
                      {['sum', 'avg', 'min', 'max'].map((f) => <option key={f}>{f}</option>)}
                    </Select>
                    <Select value={a.field} onChange={(e) => { const x = [...def.aggregates]; x[i] = { ...a, field: e.target.value }; setDef({ ...def, aggregates: x.filter((z) => z.field) }); }}>
                      <option value="">—</option>{numeric.map((f) => <option key={f.name} value={f.name}>{humanize(f.name)}</option>)}
                    </Select>
                  </div>
                ))}
              </div>
              {!def.groupBy.length && (
                <details><summary className="cursor-pointer text-xs text-muted-foreground">Columns ({def.columns.length || 'default'})</summary>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    {res?.fields.map((f) => (
                      <label key={f.name} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={def.columns.includes(f.name)} onChange={(e) => setDef({ ...def, columns: e.target.checked ? [...def.columns, f.name] : def.columns.filter((c) => c !== f.name) })} />{humanize(f.name)}</label>
                    ))}
                  </div>
                </details>
              )}
              <div><Label htmlFor="flt">Filters (JSON; use $from $to $period)</Label><Textarea id="flt" className="font-mono text-xs" value={filtersText} onChange={(e) => setFiltersText(e.target.value)} /></div>
              <div className="grid grid-cols-3 gap-1">
                <div><Label htmlFor="pf">$from</Label><Input id="pf" type="date" value={params.from} onChange={(e) => setParams({ ...params, from: e.target.value })} /></div>
                <div><Label htmlFor="pt">$to</Label><Input id="pt" type="date" value={params.to} onChange={(e) => setParams({ ...params, to: e.target.value })} /></div>
                <div><Label htmlFor="pp">$period</Label><Input id="pp" placeholder="2026-09" value={params.period} onChange={(e) => setParams({ ...params, period: e.target.value })} /></div>
              </div>
            </div>
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          <ErrorBox error={error} />
          {!out ? <Card><EmptyState title="Build a report and press Run" hint="Pick a source, group and aggregate. Saved reports can be shared with roles and pinned to dashboards." /></Card> : (
            <>
              {out.rows.length === 1 && def.groupBy.length === 0 && def.aggregates.length > 0 && <KpiCard label={out.columns[0]} value={cellOf(out.rows[0], out.columns[0])} />}
              {y && <Card title={`${humanize(y)} by ${humanize(def.groupBy[0])}`}><BarChart label="Report chart" data={out.rows.map((r) => ({ label: cellOf(r, def.groupBy[0]) || '—', value: Number(r[y] ?? 0) }))} /></Card>}
              <Card title={`${out.rows.length} rows${out.truncated ? ' (limit reached — export for more)' : ''}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-xs text-muted-foreground"><tr>{out.columns.map((c) => <th key={c} className="px-2 py-1.5 text-start font-medium">{humanize(c)}</th>)}</tr></thead>
                    <tbody>{out.rows.map((r, i) => <tr key={i} className="border-t border-border">{out.columns.map((c) => <td key={c} className="px-2 py-1.5">{cellOf(r, c)}</td>)}</tr>)}</tbody>
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
  const [tab, setTab] = useState('standard');
  return (
    <>
      {tab === 'standard' && <PageHeader title="Reports" subtitle="Standard reports for every module — pick one, set the period, export" />}
      {canBuild && <Tabs value={tab} onChange={setTab} tabs={[{ key: 'standard', label: 'Standard reports' }, { key: 'builder', label: 'Report builder' }]} />}
      {tab === 'standard' ? <StandardReports /> : <Builder />}
    </>
  );
}
