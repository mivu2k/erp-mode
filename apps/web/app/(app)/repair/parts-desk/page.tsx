'use client';
import { Button, Card, EmptyState, ErrorBox, Input, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Row { id: string; jobId: string; job: string; device: string; technician: string; part: string; sku?: string; serialized: boolean; requested: number; requestedAt: string | null; handback: number; inStore: number }
const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** The store's side of repair parts: issue what technicians asked for, receive what they handed back. */
export default function PartsDesk() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api<Row[]>('repair/parts-desk').then(setRows).catch(setError), []);
  useEffect(() => { load(); }, [load]);
  const run = async (key: string, path: string, body: object) => {
    setBusy(key); setError(null);
    try { await api(path, 'POST', body); await load(); } catch (e) { setError(e); } finally { setBusy(''); }
  };
  const jobs = [...new Set((rows ?? []).map((r) => r.jobId))].map((id) => (rows ?? []).filter((r) => r.jobId === id));
  const asked = jobs.filter((j) => j.some((r) => r.requested > 0));
  const back = jobs.filter((j) => j.some((r) => r.handback > 0));

  return (
    <>
      <PageHeader title="Parts desk" />
      <div className="mb-3"><ErrorBox error={error} /></div>
      {rows && !rows.length && <EmptyState title="Nothing waiting" hint="Parts requests from technicians and parts they hand back show up here." />}
      {asked.length > 0 && <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">To issue ({asked.length})</h2>}
      <div className="space-y-3">
        {asked.map((j) => {
          const rs = j.filter((r) => r.requested > 0);
          return (
            <Card key={`i${j[0].jobId}`} title={<span><Link className="text-primary hover:underline" href={`/r/repair.job/${j[0].jobId}`}>{j[0].job}</Link> <span className="text-sm font-normal text-muted-foreground">{j[0].device} · asked by {j[0].technician || '—'}{rs[0].requestedAt ? ` · ${new Date(rs[0].requestedAt).toLocaleString()}` : ''}</span></span>}
              actions={<Button size="sm" disabled={!!busy} onClick={() => run(`i${j[0].jobId}`, `repair/jobs/${j[0].jobId}/issue-parts`, { serials: Object.fromEntries(rs.filter((r) => serials[r.id]).map((r) => [r.id, serials[r.id].split(/[\s,;]+/).filter(Boolean)])) })}>{busy === `i${j[0].jobId}` ? 'Issuing…' : 'Issue'}</Button>}>
              <ul className="divide-y divide-border/60 text-sm">
                {rs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span>{r.part} <span className="text-xs text-muted-foreground">{r.sku}</span></span>
                    <span className="flex items-center gap-3">
                      {r.serialized && <Input className="w-56 font-mono" aria-label={`Serial of ${r.part}`} placeholder="Scan serial(s)" value={serials[r.id] ?? ''} onChange={(e) => setSerials({ ...serials, [r.id]: e.target.value })} />}
                      <span className="tabular-nums"><b>{n(r.requested)}</b> <span className={r.inStore < r.requested ? 'text-red-600' : 'text-muted-foreground'}>({n(r.inStore)} in store)</span></span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
      {back.length > 0 && <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Handed back — to receive ({back.length})</h2>}
      <div className="space-y-3">
        {back.map((j) => (
          <Card key={`r${j[0].jobId}`} title={<span><Link className="text-primary hover:underline" href={`/r/repair.job/${j[0].jobId}`}>{j[0].job}</Link> <span className="text-sm font-normal text-muted-foreground">{j[0].device} · {j[0].technician || '—'}</span></span>}
            actions={<Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(`r${j[0].jobId}`, `repair/jobs/${j[0].jobId}/return-parts`, { lines: j.filter((r) => r.handback > 0).map((r) => ({ partId: r.id, qty: r.handback })) })}>{busy === `r${j[0].jobId}` ? 'Receiving…' : 'Receive into store'}</Button>}>
            <ul className="divide-y divide-border/60 text-sm">
              {j.filter((r) => r.handback > 0).map((r) => <li key={r.id} className="flex justify-between py-2"><span>{r.part} <span className="text-xs text-muted-foreground">{r.sku}</span></span><b className="tabular-nums">{n(r.handback)}</b></li>)}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
