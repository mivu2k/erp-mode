'use client';
import { Button, Card, cx, EmptyState, ErrorBox, Input } from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { can, useMeta } from './meta';
import { RefPicker } from './RefPicker';

type Row = Record<string, unknown> & { id: string; _refs?: Record<string, string | null> };
export interface Col { name: string; label: string; ref?: string; width?: string; required?: boolean }

/**
 * A short setup list edited in place: type in a cell and leave it to save, add with Enter, ✕ to delete.
 * For branches, departments, designations, cost centers — records that are a name (and a code or a link).
 */
export function InlineList({ resource, title, hint, cols }: { resource: string; title: string; hint?: string; cols: Col[] }) {
  const meta = useMeta();
  const edit = can(meta, `${resource}.update`);
  const add = can(meta, `${resource}.create`);
  const del = can(meta, `${resource}.delete`);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ rows: Row[] }>(`r/${resource}?pageSize=500&sort=name:asc`).then((d) => setRows(d.rows)).catch(setError), [resource]);
  useEffect(() => { load(); }, [load]);
  const run = (p: Promise<unknown>) => { setError(null); return p.then(load).catch(setError); };
  const ready = cols.every((c) => !c.required || String(draft[c.name] ?? '').trim());
  const save = () => { if (ready) run(api(`r/${resource}`, 'POST', draft)).then(() => setDraft({})); };
  const grid = { gridTemplateColumns: `${cols.map((c) => c.width ?? '1fr').join(' ')} 2.5rem` };

  return (
    <Card title={<span>{title}{rows && <span className="ms-2 text-xs font-normal text-muted-foreground">{rows.length}</span>}</span>}>
      {hint && <p className="-mt-1 mb-3 text-xs text-muted-foreground">{hint}</p>}
      <ErrorBox error={error} />
      <div className="space-y-1.5 text-sm">
        <div className="grid gap-2 px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground" style={grid}>{cols.map((c) => <span key={c.name}>{c.label}</span>)}<span /></div>
        {rows && !rows.length && <EmptyState title="None yet" hint={add ? 'Add the first one below.' : undefined} />}
        {rows?.map((r) => (
          <div key={r.id} className="grid items-center gap-2" style={grid}>
            {cols.map((c) => c.ref
              ? <RefPicker key={c.name} f={{ name: c.name, type: 'string', ref: c.ref, label: `${c.label} of ${String(r.name ?? '')}` }} value={r[c.name] ?? null} knownLabel={r._refs?.[c.name]} onChange={(v) => edit && run(api(`r/${resource}/${r.id}`, 'PATCH', { [c.name]: v || null }))} />
              : <Input key={c.name} aria-label={`${c.label} of ${String(r.name ?? r.id)}`} defaultValue={String(r[c.name] ?? '')} readOnly={!edit} className="h-9"
                  onBlur={(e) => { const v = e.target.value.trim(); if (edit && v !== String(r[c.name] ?? '') && (v || !c.required)) run(api(`r/${resource}/${r.id}`, 'PATCH', { [c.name]: v || null })); }} />)}
            {del ? <Button size="sm" variant="ghost" aria-label={`Delete ${String(r.name ?? '')}`} onClick={() => confirm(`Delete “${String(r.name ?? '')}”?`) && run(api(`r/${resource}/${r.id}`, 'DELETE'))}>✕</Button> : <span />}
          </div>
        ))}
        {add && (
          <form className={cx('grid items-center gap-2 border-t border-border pt-2')} style={grid} onSubmit={(e) => { e.preventDefault(); save(); }}>
            {cols.map((c) => c.ref
              ? <RefPicker key={c.name} f={{ name: c.name, type: 'string', ref: c.ref, label: `New ${c.label.toLowerCase()}` }} value={draft[c.name] ?? null} onChange={(v) => setDraft({ ...draft, [c.name]: v })} />
              : <Input key={c.name} aria-label={`New ${c.label.toLowerCase()}`} placeholder={`${c.label}${c.required ? '' : ' (optional)'}`} value={String(draft[c.name] ?? '')} className="h-9" onChange={(e) => setDraft({ ...draft, [c.name]: e.target.value })} />)}
            <Button size="sm" type="submit" disabled={!ready} aria-label={`Add to ${title}`}>+</Button>
          </form>
        )}
      </div>
    </Card>
  );
}
