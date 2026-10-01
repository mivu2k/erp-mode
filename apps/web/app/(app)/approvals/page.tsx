'use client';
import { Button, cx, EmptyState, ErrorBox, humanize, Input, PageHeader, Select, StatusBadge, Tabs } from '@erp/ui';
import { MODULES, RESOURCE_MAP } from '@erp/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

interface Req {
  id: string; resource: string; recordId: string; title: string; amount?: string | null; status: string; stepName?: string; createdAt: string;
  myAction?: string; comment?: string; module: string; requestedBy?: string | null; details: [string, unknown][];
}
const WHY = ['purpose', 'reason', 'description', 'notes'];
const label = (c: string) => humanize(c.replace(/Id$/, ''));
const show = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
const kindOf = (r: Req) => RESOURCE_MAP[r.resource]?.label ?? humanize(r.resource);
/** "Expense Claims: EXP-…" → "EXP-…"; the type already shows on the line below. */
const name = (r: Req) => r.title.replace(`${kindOf(r)}: `, '');
const decided = (r: Req) => (r.myAction === 'approve' ? 'approved' : r.myAction === 'reject' ? 'rejected' : r.myAction ? 'returned' : r.status);
const money = (v?: string | null) => (v ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '');
const ago = (d: string) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 60 ? `${Math.max(m, 1)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : m < 10080 ? `${Math.round(m / 1440)}d ago` : new Date(d).toLocaleDateString();
};
/** Splits the record's fields into the "why" line and the small facts shown as chips. */
const split = (r: Req) => ({ why: r.details.find(([k]) => WHY.includes(k))?.[1], facts: r.details.filter(([k]) => !WHY.includes(k)) });

export default function ApprovalsPage() {
  const [tab, setTab] = useState('inbox');
  const [rows, setRows] = useState<Req[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [mod, setMod] = useState('');
  const [view, setView] = useState<'grid' | 'table'>(() => { try { return localStorage.getItem('approvals.view') === 'table' ? 'table' : 'grid'; } catch { return 'grid'; } });
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    const path = tab === 'inbox' ? 'approvals/inbox' : `approvals/mine?kind=${tab}`;
    api<Req[]>(path).then(setRows).catch(setError);
  }, [tab]);
  useEffect(load, [load]);
  const pickView = (v: 'grid' | 'table') => { setView(v); try { localStorage.setItem('approvals.view', v); } catch { /* private mode */ } };
  const act = (id: string, action: string) => api(`approvals/${id}/${action}`, 'POST', { comment: notes[id] }).then(load).catch(setError);

  const modules = useMemo(() => [...new Set(rows.map((r) => r.module))].map((m) => [m, MODULES[m]?.label ?? humanize(m), rows.filter((r) => r.module === m).length] as const), [rows]);
  const shown = rows.filter((r) => (!mod || r.module === mod)
    && (!q || [r.title, kindOf(r), r.requestedBy, r.stepName, ...r.details.map(([, v]) => v)].join(' ').toLowerCase().includes(q.toLowerCase())));

  const decide = (r: Req, row?: boolean) => tab === 'inbox' ? (
    <div className={cx('flex items-center gap-1.5 [&_button]:whitespace-nowrap', !row && 'flex-wrap')}>
      <Input aria-label={`Comment on ${r.title}`} placeholder="Comment (to reject / send back)" value={notes[r.id] ?? ''}
        onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} className={cx('h-8 flex-1 text-xs', row ? 'w-40' : 'min-w-40')} />
      <Button size="sm" onClick={() => act(r.id, 'approve')}>Approve</Button>
      <Button size="sm" variant="outline" onClick={() => act(r.id, 'return')}>Send back</Button>
      <Button size="sm" variant="danger" onClick={() => act(r.id, 'reject')}>Reject</Button>
    </div>
  ) : null;
  const meta = (r: Req) => <>{kindOf(r)}{r.stepName && ` · ${r.stepName}`} · {r.requestedBy ?? 'Unknown'} · <span title={new Date(r.createdAt).toLocaleString()}>{ago(r.createdAt)}</span></>;

  return (
    <>
      <PageHeader title="Approvals" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'inbox', label: 'Waiting for me' }, { key: 'acted', label: 'Decided by me' }, { key: 'requested', label: 'My requests' }]} />
      <div className="my-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Search approvals" placeholder="Search title, person, purpose…" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-full text-sm sm:w-64" />
        <Select aria-label="Module" value={mod} onChange={(e) => setMod(e.target.value)} className="h-9 w-44 text-sm">
          <option value="">All modules ({rows.length})</option>
          {modules.map(([m, l, n]) => <option key={m} value={m}>{l} ({n})</option>)}
        </Select>
        <div className="ms-auto inline-flex rounded-md border border-border p-0.5 text-xs" role="group" aria-label="View">
          {(['grid', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => pickView(v)}
              className={cx('rounded px-2.5 py-1 capitalize', view === v ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>{v}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={error} />
      {!shown.length && <EmptyState title={rows.length ? 'No approval matches' : tab === 'inbox' ? 'Nothing waiting for you' : 'Nothing here'} />}

      {view === 'grid' ? (
        <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((r) => {
            const { why, facts } = split(r);
            return (
              <article key={`${r.id}${r.myAction ?? ''}`} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Link className="text-sm font-semibold hover:underline" href={`/r/${r.resource}/${r.recordId}`}>{name(r)}</Link>
                    <div className="truncate text-xs text-muted-foreground">{meta(r)}</div>
                  </div>
                  <div className="text-end">
                    {r.amount && <div className="text-sm font-semibold tabular-nums">{money(r.amount)}</div>}
                    <StatusBadge status={decided(r)} />
                  </div>
                </div>
                <p className={cx('line-clamp-2 text-sm', !why && 'italic text-muted-foreground')}>{why ? show(why) : 'No purpose given'}</p>
                {facts.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {facts.map(([k, v]) => <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{label(k)}: <span className="text-foreground">{show(v)}</span></span>)}
                  </div>
                )}
                {r.comment && <p className="text-xs italic text-muted-foreground">“{r.comment}”</p>}
                {decide(r)}
              </article>
            );
          })}
        </div>
      ) : shown.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-xs">
            <thead className="border-b border-border uppercase tracking-wide text-muted-foreground">
              <tr>{['Request', 'Purpose', 'Details', 'Amount', tab === 'inbox' ? 'Decide' : 'Status'].map((h) => <th key={h} className={cx('px-3 py-2 font-medium', h === 'Amount' ? 'text-end' : 'text-start')}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const { why, facts } = split(r);
                return (
                  <tr key={`${r.id}${r.myAction ?? ''}`} className="border-b border-border/60 align-top last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2"><Link className="text-sm font-medium hover:underline" href={`/r/${r.resource}/${r.recordId}`}>{name(r)}</Link>
                      <div className="text-muted-foreground">{meta(r)}</div></td>
                    <td className="max-w-56 px-3 py-2 text-sm">{why ? show(why) : '—'}</td>
                    <td className="max-w-64 px-3 py-2 text-muted-foreground">{facts.map(([k, v]) => `${label(k)}: ${show(v)}`).join(' · ') || '—'}</td>
                    <td className="px-3 py-2 text-end text-sm font-medium tabular-nums">{money(r.amount) || '—'}</td>
                    <td className="min-w-72 px-3 py-2">{decide(r, true) ?? <StatusBadge status={decided(r)} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
