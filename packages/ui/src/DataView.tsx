'use client';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { FieldMeta, FieldInput, humanize, RefRenderer } from './fields';
import { Button, cx, EmptyState, ErrorBox, Input, Menu, Pagination, Select, Skeleton } from './primitives';
import { useT } from './i18n';
import { STATUS_TONE, StatusBadge } from './theme';

export type Row = Record<string, unknown> & { id: string; _refs?: Record<string, string | null> };
export interface ListParams { page: number; pageSize: number; search: string; sort: string; filters: Record<string, unknown> }
export interface SavedViewApi { list(): Promise<{ id: string; name: string; config: Partial<ListParams> & { columns?: string[]; mode?: string } }[]>; save(name: string, config: object): Promise<unknown>; remove(id: string): Promise<unknown> }

export interface DataViewProps {
  id: string;
  fields: FieldMeta[];
  defaultColumns: string[];
  title: string;
  subtitle?: string;
  statuses?: string[];
  /** Date field for the month calendar view. */
  calendarField?: string;
  load(p: ListParams): Promise<{ rows: Row[]; total: number }>;
  onOpen(row: Row): void;
  onMove?(row: Row, status: string): Promise<unknown>;
  onExport?(format: 'csv' | 'xlsx' | 'html' | 'pdf', p: ListParams, columns: string[]): void;
  bulkActions?: { label: string; run(rows: Row[]): Promise<unknown> }[];
  savedViews?: SavedViewApi;
  renderRef?: RefRenderer;
  reloadKey?: unknown;
  toolbar?: ReactNode;
  /** Optional image for grid cards (e.g. product photo, employee photo). */
  thumbnail?(row: Row): ReactNode;
}

type Mode = 'table' | 'grid' | 'kanban' | 'calendar';

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

/** Human cell value: ref titles, badges for status, formatted dates/money. */
export function formatCell(row: Row, f: FieldMeta | undefined, name: string): ReactNode {
  const v = row._refs && name in row._refs ? row._refs[name] : name.startsWith('custom.') ? (row.custom as Record<string, unknown> | null)?.[name.slice(7)] : row[name];
  if (v === null || v === undefined || v === '') return <span className="text-muted-foreground">—</span>;
  if (name === 'status') return <StatusBadge status={String(v)} />;
  switch (f?.type) {
    case 'bool': return v ? '✓' : '—';
    case 'date': return String(v).slice(0, 10);
    case 'datetime': return new Date(String(v)).toLocaleString();
    case 'money': case 'decimal': return <span className="tabular-nums">{Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>;
    case 'json': return <span className="text-xs text-muted-foreground">{Array.isArray(v) ? `${v.length} items` : '{…}'}</span>;
    case 'files': return <span className="text-xs text-muted-foreground">{Array.isArray(v) ? `${v.length} file(s)` : '—'}</span>;
    case 'enum': return humanize(String(v));
  }
  return String(v);
}

/** The one list component every module uses: server-side paging/sort/filter/search, table/grid/kanban, columns, bulk, export, saved views. */
export function DataView(p: DataViewProps) {
  const t = useT();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const fieldMap = useMemo(() => new Map(p.fields.map((f) => [f.name, f])), [p.fields]);
  const [mode, setMode] = useState<Mode>(() => store.get(`dv:${p.id}:mode`, typeof window !== 'undefined' && innerWidth < 640 ? 'grid' : 'table'));
  const [columns, setColumns] = useState<string[]>(() => store.get(`dv:${p.id}:cols`, p.defaultColumns));
  const [params, setParams] = useState<ListParams>({ page: 1, pageSize: store.get(`dv:${p.id}:size`, 25), search: '', sort: '', filters: {} });
  const [searchText, setSearchText] = useState('');
  const [data, setData] = useState<{ rows: Row[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [views, setViews] = useState<Awaited<ReturnType<SavedViewApi['list']>>>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => store.set(`dv:${p.id}:mode`, mode), [p.id, mode]);
  useEffect(() => store.set(`dv:${p.id}:cols`, columns), [p.id, columns]);
  useEffect(() => {
    const t = setTimeout(() => setParams((s) => (s.search === searchText ? s : { ...s, search: searchText, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  useEffect(() => { p.savedViews?.list().then(setViews).catch(() => {}); }, [p.savedViews]);

  const monthRange = () => {
    const [y, m] = month.split('-').map(Number);
    return { gte: `${month}-01`, lte: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) + 'T23:59:59' };
  };
  const effective = mode === 'kanban' ? { ...params, page: 1, pageSize: 200 }
    : mode === 'calendar' && p.calendarField ? { ...params, page: 1, pageSize: 1000, filters: { ...params.filters, [p.calendarField]: monthRange() } } : params;
  useEffect(() => {
    let live = true;
    setLoading(true);
    p.load(effective)
      .then((d) => { if (live) { setData(d); setError(null); setSelected(new Set()); } })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effective), p.reloadKey, tick]);

  const reload = () => setTick((t) => t + 1);
  const set = (patch: Partial<ListParams>) => setParams((s) => ({ ...s, page: 1, ...patch }));
  const sortBy = (c: string) => {
    const [f, d] = params.sort.split(':');
    set({ sort: f === c ? (d === 'asc' ? `${c}:desc` : '') : `${c}:asc` });
  };
  const setFilter = (name: string, v: unknown) => {
    const next = { ...params.filters };
    if (v === '' || v === null || v === undefined || (typeof v === 'object' && !Object.values(v as object).some((x) => x !== '' && x != null))) delete next[name];
    else next[name] = v;
    set({ filters: next });
  };

  const rows = data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / params.pageSize));
  const chosen = rows.filter((r) => selected.has(r.id));
  const filterable = p.fields.filter((f) => !['json', 'text'].includes(f.type));
  const activeFilters = Object.keys(params.filters).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search" placeholder={`${t('Search')} ${p.title.toLowerCase()}…`} value={searchText} onChange={(e) => setSearchText(e.target.value)} className="max-w-xs" />
        <Button variant={activeFilters ? 'primary' : 'outline'} onClick={() => setShowFilters((s) => !s)}>{t('Filters')}{activeFilters ? ` (${activeFilters})` : ''}</Button>
        <div role="group" aria-label="View" className="inline-flex overflow-hidden rounded-[var(--radius)] border border-border">
          {(['table', 'grid', ...(p.statuses ? ['kanban'] : []), ...(p.calendarField ? ['calendar'] : [])] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={cx('h-9 px-3 text-sm capitalize', mode === m ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>{t(m)}</button>
          ))}
        </div>
        <Menu label={t('Columns')} items={p.fields.map((f) => ({ label: `${columns.includes(f.name) ? '☑' : '☐'} ${humanize(f.name)}`, onClick: () => setColumns((c) => (c.includes(f.name) ? c.filter((x) => x !== f.name) : [...c, f.name])) }))} />
        {p.savedViews && (
          <Menu label={t('Views')} items={[
            ...views.map((v) => ({ label: v.name, onClick: () => { setParams((s) => ({ ...s, ...v.config, page: 1 })); if (v.config.columns) setColumns(v.config.columns); setSearchText(v.config.search ?? ''); } })),
            { label: `+ ${t('Save current view')}`, onClick: () => { const name = prompt('View name'); if (name) p.savedViews!.save(name, { ...params, columns, mode }).then(() => p.savedViews!.list().then(setViews)); } },
            ...views.map((v) => ({ label: `✕ Delete “${v.name}”`, onClick: () => p.savedViews!.remove(v.id).then(() => p.savedViews!.list().then(setViews)) })),
          ]} />
        )}
        {p.onExport && (
          <Menu label={t('Export')} items={[
            { label: 'Excel (.xlsx)', onClick: () => p.onExport!('xlsx', params, columns) },
            { label: 'CSV', onClick: () => p.onExport!('csv', params, columns) },
            { label: 'PDF', onClick: () => p.onExport!('pdf', params, columns) },
            { label: 'Print', onClick: () => p.onExport!('html', params, columns) },
          ]} />
        )}
        {p.toolbar}
        {chosen.length > 0 && p.bulkActions?.map((a) => (
          <Button key={a.label} variant="outline" onClick={async () => { try { await a.run(chosen); reload(); } catch (e) { setError(e); } }}>{a.label} ({chosen.length})</Button>
        ))}
      </div>

      {showFilters && (
        <div className="grid gap-3 rounded-[var(--radius)] border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
          {filterable.map((f) => {
            const cur = params.filters[f.name] as Record<string, unknown> | string | undefined;
            const range = (cur ?? {}) as Record<string, string>;
            return (
              <div key={f.name}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{humanize(f.name)}</div>
                {f.name === 'status' && p.statuses ? (
                  <Select value={String(cur ?? '')} onChange={(e) => setFilter(f.name, e.target.value)}>
                    <option value="">{t('Any')}</option>
                    {p.statuses.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </Select>
                ) : ['date', 'datetime', 'int', 'float', 'money', 'decimal'].includes(f.type) ? (
                  <div className="flex gap-1">
                    <Input aria-label={`${f.name} from`} type={f.type.startsWith('date') ? 'date' : 'number'} value={range.gte ?? ''} onChange={(e) => setFilter(f.name, { ...range, gte: e.target.value })} />
                    <Input aria-label={`${f.name} to`} type={f.type.startsWith('date') ? 'date' : 'number'} value={range.lte ?? ''} onChange={(e) => setFilter(f.name, { ...range, lte: e.target.value })} />
                  </div>
                ) : f.type === 'bool' ? (
                  <Select value={cur === undefined ? '' : String(cur)} onChange={(e) => setFilter(f.name, e.target.value === '' ? '' : e.target.value === 'true')}>
                    <option value="">{t('Any')}</option><option value="true">Yes</option><option value="false">No</option>
                  </Select>
                ) : f.ref || f.type === 'enum' ? (
                  <FieldInput f={{ ...f, required: false, readonly: false }} value={cur} onChange={(v) => setFilter(f.name, v)} renderRef={p.renderRef} />
                ) : (
                  <Input value={String(range.contains ?? '')} onChange={(e) => setFilter(f.name, { contains: e.target.value })} />
                )}
              </div>
            );
          })}
          <div className="flex items-end"><Button variant="ghost" onClick={() => set({ filters: {} })}>{t('Clear filters')}</Button></div>
        </div>
      )}

      <ErrorBox error={error} />

      {mode === 'table' && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[var(--shadow)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                {columns.map((c) => {
                  const [f, d] = params.sort.split(':');
                  return (
                    <th key={c} className="px-3 py-2 text-start font-medium" aria-sort={f === c ? (d === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button className="hover:text-foreground" onClick={() => sortBy(c)}>{humanize(c)}{f === c ? (d === 'asc' ? ' ↑' : ' ↓') : ''}</button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && !data && [...Array(5)].map((_, i) => <tr key={i}><td colSpan={columns.length + 1} className="px-3 py-2"><Skeleton className="h-5" /></td></tr>)}
              {rows.map((r) => (
                <tr key={r.id} className={cx("cursor-pointer border-t border-border transition-colors hover:bg-primary/5", selected.has(r.id) && "bg-primary/10")} onClick={() => p.onOpen(r)}>
                  <td className="px-3 py-[calc(0.5rem*var(--density))]" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select row" checked={selected.has(r.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                  </td>
                  {columns.map((c) => <td key={c} className="max-w-64 truncate px-3 py-[calc(0.5rem*var(--density))]">{formatCell(r, fieldMap.get(c), c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && data && rows.length === 0 && <EmptyState title={t('Nothing here yet')} hint={activeFilters || params.search ? t('Try clearing search and filters.') : undefined} />}
        </div>
      )}

      {mode === 'grid' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((r) => (
            <button key={r.id} onClick={() => p.onOpen(r)} className="overflow-hidden rounded-xl border border-border bg-card text-start shadow-[var(--shadow)] transition hover:-translate-y-0.5 hover:border-primary/60">
              {p.thumbnail && <div className="aspect-[4/3] bg-muted">{p.thumbnail(r)}</div>}
              <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium">{formatCell(r, fieldMap.get(columns[0]), columns[0])}</div>
                {'status' in r && <StatusBadge status={String(r.status)} />}
              </div>
              <dl className="mt-2 space-y-0.5 text-xs">
                {columns.slice(1, 5).filter((c) => c !== 'status').map((c) => (
                  <div key={c} className="flex justify-between gap-2"><dt className="text-muted-foreground">{humanize(c)}</dt><dd className="truncate">{formatCell(r, fieldMap.get(c), c)}</dd></div>
                ))}
              </dl>
              </div>
            </button>
          ))}
          {!loading && data && rows.length === 0 && <EmptyState title="Nothing here yet" />}
        </div>
      )}

      {mode === 'kanban' && p.statuses && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {p.statuses.map((s) => (
            <div key={s} className="w-64 shrink-0 rounded-[var(--radius)] bg-muted p-2"
              onDragOver={(e) => p.onMove && e.preventDefault()}
              onDrop={async (e) => {
                const row = rows.find((r) => r.id === e.dataTransfer.getData('text/plain'));
                if (row && p.onMove && row.status !== s) { try { await p.onMove(row, s); reload(); } catch (err) { setError(err); } }
              }}>
              <div className="mb-2 flex items-center justify-between px-1"><StatusBadge status={s} /><span className="text-xs text-muted-foreground">{rows.filter((r) => r.status === s).length}</span></div>
              <div className="space-y-2">
                {rows.filter((r) => r.status === s).map((r) => (
                  <div key={r.id} draggable={!!p.onMove} onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)} onClick={() => p.onOpen(r)}
                    className="cursor-pointer rounded-[var(--radius)] border border-border bg-card p-2 text-sm hover:border-primary">
                    <div className="font-medium">{formatCell(r, undefined, columns[0])}</div>
                    <div className="text-xs text-muted-foreground">{columns.slice(1, 3).filter((c) => c !== 'status').map((c) => <div key={c} className="truncate">{formatCell(r, fieldMap.get(c), c)}</div>)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {mode === 'calendar' && p.calendarField && <Calendar month={month} setMonth={setMonth} rows={rows} field={p.calendarField} title={columns[0]} onOpen={p.onOpen} fieldMap={fieldMap} />}

      {mode !== 'kanban' && mode !== 'calendar' && data && (
        <Pagination page={params.page} pageSize={params.pageSize} total={data.total}
          onPage={(n) => { setParams((s) => ({ ...s, page: n })); scrollTo({ top: 0, behavior: 'smooth' }); }}
          onPageSize={(n) => { store.set(`dv:${p.id}:size`, n); set({ pageSize: n }); }}
          labels={{ rows: t('Rows'), of: t('of'), prev: t('Prev'), next: t('Next') }} />
      )}
    </div>
  );
}

/** Month grid; records placed on their date field (local day). */
function Calendar({ month, setMonth, rows, field, title, onOpen, fieldMap }: { month: string; setMonth(m: string): void; rows: Row[]; field: string; title: string; onOpen(r: Row): void; fieldMap: Map<string, FieldMeta> }) {
  const t = useT();
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const byDay = new Map<number, Row[]>();
  for (const r of rows) {
    const v = r[field];
    if (!v) continue;
    const d = String(v).length === 10 || String(v).endsWith('T00:00:00.000Z') ? new Date(`${String(v).slice(0, 10)}T12:00:00`) : new Date(String(v));
    if (d.getFullYear() === y && d.getMonth() === m - 1) byDay.set(d.getDate(), [...(byDay.get(d.getDate()) ?? []), r]);
  }
  const shift = (n: number) => { const d = new Date(y, m - 1 + n, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
  const today = new Date();
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="Previous month">‹</Button>
        <div className="text-sm font-medium">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
        <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setMonth(new Date().toISOString().slice(0, 7))}>{t('Today')}</Button><Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label="Next month">›</Button></div>
      </div>
      <div className="grid grid-cols-7 text-xs">
        {[...Array(7)].map((_, i) => <div key={i} className="border-b border-border px-2 py-1 text-muted-foreground">{new Date(2026, 1, i + 1).toLocaleDateString(undefined, { weekday: 'short' })}</div>)}
        {cells.map((d, i) => (
          <div key={i} className={cx('min-h-24 border-b border-e border-border p-1', !d && 'bg-muted/40')}>
            {d && <div className={cx('mb-1 w-6 rounded-full text-center', today.getFullYear() === y && today.getMonth() === m - 1 && today.getDate() === d && 'bg-primary text-primary-foreground')}>{d}</div>}
            {d && (byDay.get(d) ?? []).slice(0, 4).map((r) => (
              <button key={r.id} onClick={() => onOpen(r)} className="mb-0.5 block w-full truncate rounded bg-muted px-1 py-0.5 text-start hover:bg-primary hover:text-primary-foreground">
                {'status' in r && <span className="me-1 inline-block h-2 w-2 rounded-full" style={{ background: `var(--tone-${STATUS_TONE[String(r.status)] ?? 'gray'})` }} />}
                {formatCell(r, fieldMap.get(title), title)}
              </button>
            ))}
            {d && (byDay.get(d)?.length ?? 0) > 4 && <div className="px-1 text-muted-foreground">+{byDay.get(d)!.length - 4}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
