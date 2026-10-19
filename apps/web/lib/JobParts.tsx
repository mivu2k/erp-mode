'use client';
import { Button, Card, cx, ErrorBox, Input } from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { can, useMeta } from './meta';
import { RefPicker } from './RefPicker';

interface Part { id: string; name: string; sku?: string; serialized: boolean; reserved: number; issued: number; returned: number; inUse: number; requested: number; handback: number; toIssue: number; unitCost: number; serial: string | null; inStore: number }
interface Move { at: string; type: string; part: string; qty: number; serial: string | null; store: string; by: string }
interface Data { store: { id: string; name: string } | null; parts: Part[]; movements: Move[] }
const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * A repair job's parts on its own page: reserved → issued → returned → in use per part, issue / return right here
 * (store defaults to the Workshop store), and every movement with who did it.
 */
export function JobParts({ jobId, onChanged }: { jobId: string; onChanged?(): void }) {
  const meta = useMeta();
  const canMove = can(meta, 'inventory.movement.create'); // the store: issues and receives
  const canWork = can(meta, 'repair.job.update'); // the technician: asks for parts, hands unused ones back
  const [d, setD] = useState<Data | null>(null);
  const [mode, setMode] = useState<'issue' | 'return' | 'request' | 'handback' | null>(null);
  const [store, setStore] = useState<unknown>(null);
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [back, setBack] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Data>(`repair/jobs/${jobId}/parts`).then(setD).catch(setError), [jobId]);
  useEffect(() => { load(); }, [load]);
  // "Issue parts" from the job's next-step panel opens the form here.
  useEffect(() => {
    const open = () => { setMode(canMove ? 'issue' : 'request'); document.getElementById('job-parts')?.scrollIntoView({ behavior: 'smooth' }); };
    window.addEventListener('job:issue-parts', open);
    return () => window.removeEventListener('job:issue-parts', open);
  }, []);
  if (!d) return null;
  if (!d.parts.length && !d.movements.length) // nothing reserved for this job
    return mode === 'issue' ? <div id="job-parts"><Card title="Parts"><p className="text-sm text-muted-foreground">The accepted quotation has no parts — this is a labour-only job. Do the work, then record the QC test.</p></Card></div> : null;

  const toIssue = d.parts.filter((p) => p.toIssue > 0);
  const inUse = d.parts.filter((p) => p.inUse > 0);
  const toAsk = toIssue.filter((p) => p.requested < p.toIssue);
  const canHandBack = inUse.filter((p) => p.handback < p.inUse);
  const handedBack = d.parts.filter((p) => p.handback > 0);
  const run = async (path: string, body: object) => {
    setBusy(true); setError(null);
    try { await api(`repair/jobs/${jobId}/${path}`, 'POST', { ...(store ? { warehouseId: store } : {}), ...body }); setMode(null); setSerials({}); setBack({}); await load(); onChanged?.(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const storePicker = (
    <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Store (empty = automatic: {d.store?.name ?? 'Workshop store'} first, else a store that has it)</span>
      <RefPicker f={{ name: 'warehouseId', type: 'string', ref: 'inventory.warehouse', label: 'Store' }} value={store} onChange={setStore} /></label>
  );

  return (
    <div id="job-parts"><Card title={<span>Parts<span className="ms-2 text-xs font-normal text-muted-foreground">from the accepted quotation</span></span>}
      actions={!mode ? <div className="flex flex-wrap gap-1.5">
        {canWork && toAsk.length > 0 && <Button size="sm" variant={canMove ? 'outline' : undefined} onClick={() => setMode('request')}>Request parts</Button>}
        {canMove && toIssue.length > 0 && <Button size="sm" onClick={() => setMode('issue')}>Issue parts</Button>}
        {canWork && canHandBack.length > 0 && <Button size="sm" variant="outline" onClick={() => { setBack(Object.fromEntries(canHandBack.map((p) => [p.id, String(p.inUse)]))); setMode('handback'); }}>Hand back unused</Button>}
        {canMove && inUse.length > 0 && <Button size="sm" variant="outline" onClick={() => { setBack(Object.fromEntries(inUse.map((p) => [p.id, String(p.handback || p.inUse)]))); setMode('return'); }}>{handedBack.length ? 'Receive handed back' : 'Return to store'}</Button>}
      </div> : undefined}>
      <ErrorBox error={error} />
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>{['Part', 'Reserved', 'Issued', 'Returned', 'In use', 'Unit cost', d.store ? `In ${d.store.name}` : 'In store', ''].map((h, i) => <th key={h + i} className={cx('px-3 py-2 font-medium', i === 0 ? 'ps-5 text-start' : 'text-end', i === 7 && 'pe-5')}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.parts.map((p) => (
              <tr key={p.id} className="border-t border-border/60">
                <td className="px-3 py-2 ps-5">{p.name}<div className="text-xs text-muted-foreground">{[p.sku, p.serial && `S/N ${p.serial}`].filter(Boolean).join(' · ')}</div></td>
                <td className="px-3 py-2 text-end tabular-nums">{n(p.reserved)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{n(p.issued)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{n(p.returned)}</td>
                <td className="px-3 py-2 text-end font-semibold tabular-nums">{n(p.inUse)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{p.unitCost ? n(p.unitCost) : '—'}</td>
                <td className={cx('px-3 py-2 text-end tabular-nums', p.toIssue > p.inStore && 'text-red-600')}>{n(p.inStore)}</td>
                <td className="whitespace-nowrap px-3 py-2 pe-5 text-end text-xs">
                  {p.handback > 0 ? <span style={{ color: 'var(--tone-amber)' }}>{n(p.handback)} handed back — store to receive</span>
                    : p.requested > 0 ? <span style={{ color: 'var(--tone-amber)' }}>{n(p.requested)} requested — waiting for the store</span>
                    : p.toIssue > 0 ? <span style={{ color: 'var(--tone-amber)' }}>{n(p.toIssue)} to issue{p.toIssue > p.inStore ? ' — short' : ''}</span>
                    : p.inUse > 0 ? <span style={{ color: 'var(--tone-green)' }}>on the job</span> : <span className="text-muted-foreground">done</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mode === 'request' && (
        <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
          <div className="text-sm font-semibold">Ask the store for these parts</div>
          {toAsk.length ? <p className="text-sm">{toAsk.map((p) => `${n(p.toIssue)} × ${p.name}`).join(', ')}</p> : <p className="text-sm text-muted-foreground">Everything is already requested or issued.</p>}
          <p className="text-xs text-muted-foreground">The store sees this on its Parts desk and issues them to this job.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !toAsk.length} onClick={() => run('request-parts', {})}>{busy ? 'Sending…' : 'Send request'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'handback' && (
        <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
          <div className="text-sm font-semibold">Hand unused parts back to the store</div>
          {canHandBack.map((p) => (
            <label key={p.id} className="flex items-center justify-between gap-3 text-sm"><span>{p.name} <span className="text-xs text-muted-foreground">({n(p.inUse)} on the job)</span></span>
              <Input type="number" min={0} max={p.inUse} step="any" aria-label={`Hand back ${p.name}`} className="w-28 text-end" value={back[p.id] ?? ''} onChange={(e) => setBack({ ...back, [p.id]: e.target.value })} /></label>
          ))}
          <p className="text-xs text-muted-foreground">They stay on the job until the store receives them.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !Object.values(back).some((v) => Number(v) > 0)}
              onClick={() => run('handback-parts', { lines: Object.entries(back).filter(([, v]) => Number(v) > 0).map(([partId, v]) => ({ partId, qty: Number(v) })) })}>{busy ? 'Saving…' : 'Hand back'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'issue' && (
        <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
          <div className="text-sm font-semibold">Issue parts to this job</div>
          {!canMove && <p className="text-sm" style={{ color: 'var(--tone-amber)' }}>You don’t have the right to move stock — ask the store keeper to issue these parts.</p>}
          {!toIssue.length && <p className="text-sm text-muted-foreground">Everything reserved is already issued.</p>}
          {storePicker}
          {toIssue.filter((p) => p.serialized).map((p) => (
            <label key={p.id} className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Serial number(s) of {p.name} — {n(p.toIssue)} needed</span>
              <Input className="font-mono" value={serials[p.id] ?? ''} placeholder="Scan or type; separate with spaces" onChange={(e) => setSerials({ ...serials, [p.id]: e.target.value })} /></label>
          ))}
          <p className="text-xs text-muted-foreground">Issues {toIssue.map((p) => `${n(p.toIssue)} × ${p.name}`).join(', ')}. The job moves to “in repair”.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !canMove || !toIssue.length} onClick={() => run('issue-parts', { serials: Object.fromEntries(Object.entries(serials).map(([k, v]) => [k, v.split(/[\s,;]+/).filter(Boolean)]).filter(([, v]) => v.length)) })}>{busy ? 'Issuing…' : 'Issue'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'return' && (
        <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
          <div className="text-sm font-semibold">{handedBack.length ? 'Receive the handed-back parts into the store' : 'Return unused parts to the store'}</div>
          {storePicker}
          {inUse.map((p) => (
            <label key={p.id} className="flex items-center justify-between gap-3 text-sm"><span>{p.name} <span className="text-xs text-muted-foreground">({n(p.inUse)} on the job)</span></span>
              <Input type="number" min={0} max={p.inUse} step="any" aria-label={`Return ${p.name}`} className="w-28 text-end" value={back[p.id] ?? ''} onChange={(e) => setBack({ ...back, [p.id]: e.target.value })} /></label>
          ))}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !Object.values(back).some((v) => Number(v) > 0)}
              onClick={() => run('return-parts', { lines: Object.entries(back).filter(([, v]) => Number(v) > 0).map(([partId, v]) => ({ partId, qty: Number(v) })) })}>{busy ? 'Returning…' : 'Return'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {d.movements.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Movements</h3>
          <ul className="mt-1 divide-y divide-border/60 text-sm">
            {d.movements.map((m, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0"><b className="font-medium">{m.type === 'job_issue' ? 'Issued' : m.type === 'job_return' ? 'Returned' : m.type.replace(/_/g, ' ')}</b> {m.part}{m.serial ? ` (S/N ${m.serial})` : ''}
                  <span className="block text-xs text-muted-foreground">{new Date(m.at).toLocaleString()} · {m.store}{m.by ? ` · ${m.by}` : ''}</span></span>
                <span className={cx('tabular-nums', m.qty < 0 ? 'text-red-600' : 'text-emerald-600')}>{m.qty > 0 ? '+' : ''}{n(m.qty)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card></div>
  );
}
