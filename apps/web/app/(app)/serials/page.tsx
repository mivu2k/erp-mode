'use client';
import { Button, cx, Dialog, EmptyState, ErrorBox, Input, PageHeader, Select, StatusBadge, Textarea, Timeline } from '@erp/ui';
import Link from 'next/link';
import { RefPicker } from '@/lib/RefPicker';
import { FormEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

type Rec = Record<string, unknown> & { id: string; _refs?: Record<string, string | null> };
interface Warranty { state: 'none' | 'active' | 'expiring' | 'expired'; daysLeft: number | null }
interface Lookup { serial: string; item: Rec | null; history: { at: string; title: string; detail?: string; link?: string; by?: string }[] }
interface Summary { total: number; byStatus: Record<string, number>; expiring: number; expired: number }

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const TONE: Record<Warranty['state'], string> = { active: 'green', expiring: 'amber', expired: 'red', none: 'gray' };
/** Warranty state from the date alone (same rule as the server: ≤ 30 days left is "expiring"). */
function warrantyOf(until: unknown): Warranty {
  if (!until) return { state: 'none', daysLeft: null };
  const days = Math.floor((+new Date(String(until).slice(0, 10)) - +new Date(iso(Date.now()))) / DAY);
  return { state: days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'active', daysLeft: days };
}
function WarrantyBadge({ until, long }: { until: unknown; long?: boolean }) {
  const w = warrantyOf(until);
  if (w.state === 'none') return <span className="text-xs text-muted-foreground">{long ? 'No warranty on record' : '—'}</span>;
  const date = String(until).slice(0, 10);
  const text = w.state === 'expired' ? (long ? `Warranty expired ${date}` : `Expired ${date}`) : long ? `Warranty until ${date} (${w.daysLeft} days left)` : `${date} · ${w.daysLeft}d`;
  return <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: `var(--tone-${TONE[w.state]})`, background: `var(--tone-${TONE[w.state]}-bg)` }}>{text}</span>;
}
const nice = (s: unknown) => String(s ?? '').replace(/_/g, ' ');
const ref = (r: Rec, k: string) => { const v = r._refs?.[k]; return v && v !== '—' ? v : null; };
const itemOf = (r: Rec) => ref(r, 'productId') ?? ([r.itemName, [r.brand, r.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—');
const whereOf = (r: Rec) => [ref(r, 'warehouseId'), r.location, r.holder && `with ${r.holder}`, r.status === 'sold' && ref(r, 'customerId')].filter(Boolean).join(' · ') || '—';

/** The status / warranty chips double as the list's quick filters. */
const VIEWS: { key: string; label: string; filters: () => Record<string, unknown>; count: (s: Summary) => number }[] = [
  { key: 'all', label: 'All units', filters: () => ({}), count: (s) => s.total },
  { key: 'in_stock', label: 'In stock', filters: () => ({ status: 'in_stock' }), count: (s) => s.byStatus.in_stock ?? 0 },
  { key: 'issued', label: 'Issued', filters: () => ({ status: 'issued' }), count: (s) => s.byStatus.issued ?? 0 },
  { key: 'demo', label: 'On demo', filters: () => ({ status: 'demo' }), count: (s) => s.byStatus.demo ?? 0 },
  { key: 'sold', label: 'With customers', filters: () => ({ status: 'sold' }), count: (s) => s.byStatus.sold ?? 0 },
  { key: 'rma', label: 'Out for RMA', filters: () => ({ status: 'rma' }), count: (s) => s.byStatus.rma ?? 0 },
  { key: 'scrapped', label: 'Scrapped / out', filters: () => ({ status: ['scrapped', 'out'] }), count: (s) => (s.byStatus.scrapped ?? 0) + (s.byStatus.out ?? 0) },
  { key: 'expiring', label: 'Warranty ≤ 30 days', filters: () => ({ warrantyUntil: { gte: iso(Date.now() - DAY), lte: iso(Date.now() + 30 * DAY) } }), count: (s) => s.expiring },
  { key: 'expired', label: 'Warranty expired', filters: () => ({ warrantyUntil: { lt: iso(Date.now()) }, status: { ne: 'scrapped' } }), count: (s) => s.expired },
];

export default function Page() {
  return <Suspense><Serials /></Suspense>;
}

/** Serial tracking: every unit in one list, filtered by status or warranty; pick one to see its history and move it on. */
function Serials() {
  const meta = useMeta();
  const canRegister = can(meta, 'serials.item.create');
  const canAct = can(meta, 'serials.item.update');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState('all');
  const search = useSearchParams();
  const linked = search.get('q') ?? ''; // e.g. "Track" from a product's serial units
  const [q, setQ] = useState(linked);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  // ?register=1 ("New" on the serial register) opens the register dialog straight away.
  const [dialog, setDialog] = useState<'register' | 'bulk' | null>(search.get('register') && canRegister ? 'register' : null);
  const [error, setError] = useState<unknown>(null);
  const scan = useRef<HTMLInputElement>(null);
  const [tick, setTick] = useState(0); // bump to reload after a change
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => { scan.current?.focus(); }, []);
  // Opened with ?q=SERIAL: show that unit straight away.
  useEffect(() => {
    if (linked) api<Lookup>(`serials/lookup?${qs({ serial: linked })}`).then((r) => r.item && setSel(r.item.id)).catch(() => {});
  }, [linked]);
  useEffect(() => { api<Summary>('serials/summary').then(setSummary).catch(setError); }, [tick]);
  const filters = VIEWS.find((v) => v.key === view)!.filters();
  const query = qs({ search: q.trim() || undefined, filters: JSON.stringify(filters), sort: 'updatedAt:desc', pageSize: 50 });
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ rows: Rec[]; total: number }>(`r/serials.item?${query}&page=1`).then((d) => { setRows(d.rows); setTotal(d.total); setPage(1); }).catch(setError);
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, tick, q]);
  const more = () => api<{ rows: Rec[] }>(`r/serials.item?${query}&page=${page + 1}`).then((d) => { setRows((r) => [...r, ...d.rows]); setPage(page + 1); }).catch(setError);

  // Scanner: Enter on an exact serial opens that unit straight away.
  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const s = q.trim();
    if (!s) return;
    setError(null);
    const hit = rows.find((r) => String(r.serial).toLowerCase() === s.toLowerCase());
    if (hit) return setSel(hit.id);
    try { const r = await api<Lookup>(`serials/lookup?${qs({ serial: s })}`); if (r.item) setSel(r.item.id); else setError(new Error(`${s} is not in the register (only seen on repair jobs)`)); } catch (err) { setError(err); }
  };

  return (
    <>
      <PageHeader title="Serial Tracking" subtitle="Every serialised unit: where it is, who has it, its warranty and everything that happened to it"
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog('bulk')}>Bulk check</Button>
          {can(meta, 'serials.item.export') && <Button variant="outline" onClick={() => openDoc(`r/serials.item/export?${qs({ format: 'xlsx', search: q.trim() || undefined, filters: JSON.stringify(filters) })}`).catch(setError)}>Export</Button>}
          {canRegister && <Button onClick={() => setDialog('register')}>Register serials</Button>}
        </div>} />

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter units">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setView(v.key)}
            className={cx('rounded-full border px-3 py-1 text-xs transition', view === v.key ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
            {v.label}{summary && <span className="ms-1.5 tabular-nums opacity-70">{v.count(summary)}</span>}
          </button>
        ))}
      </div>
      <form onSubmit={onScan} className="mb-3">
        <Input ref={scan} aria-label="Scan or search" placeholder="Scan a serial / asset tag, or search make, model, location, holder…" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 text-base" />
      </form>
      <ErrorBox error={error} />

      <div className={cx('grid items-start gap-4', sel && 'xl:grid-cols-[1fr_26rem]')}>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          {!rows.length ? <EmptyState title={q || view !== 'all' ? 'No unit matches' : 'No serials registered yet'} hint={canRegister && !q && view === 'all' ? 'Use “Register serials” to add units, or receive serialised stock on a purchase order.' : undefined} /> : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>{['Serial', 'Item', 'Status', 'Where / who', 'Warranty', 'Last change'].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setSel(r.id)} className={cx('cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/40', sel === r.id && 'bg-primary/10')}>
                    <td className="px-3 py-2 font-mono text-xs">{String(r.serial)}</td>
                    <td className="px-3 py-2">{itemOf(r)}</td>
                    <td className="px-3 py-2"><StatusBadge status={String(r.status)} /></td>
                    <td className="px-3 py-2 text-muted-foreground">{whereOf(r)}</td>
                    <td className="px-3 py-2"><WarrantyBadge until={r.warrantyUntil} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{new Date(String(r.updatedAt)).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length > 0 && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <span>{rows.length} of {total}</span>
              {rows.length < total && <Button size="sm" variant="ghost" onClick={more}>Show more</Button>}
            </div>
          )}
        </div>
        {sel && <UnitPanel id={sel} canAct={canAct} onClose={() => setSel(null)} onChanged={refresh} />}
      </div>

      <Dialog open={dialog === 'register'} onClose={() => setDialog(null)} title="Register serials" wide><Register onDone={refresh} /></Dialog>
      <Dialog open={dialog === 'bulk'} onClose={() => setDialog(null)} title="Bulk check" wide><Bulk onOpen={(id) => { setDialog(null); setSel(id); }} /></Dialog>
    </>
  );
}

type Field = 'employeeId' | 'holder' | 'location' | 'customerId' | 'warrantyUntil' | 'note';
/** The custody steps the server offers (POST serials/:id/action); `when` hides steps that make no sense for the current status. */
const STEPS: { key: string; label: string; fields: Field[]; ready: (f: Record<string, unknown>) => boolean; when: (s: string) => boolean; danger?: boolean }[] = [
  { key: 'issue', label: 'Issue to…', fields: ['employeeId', 'holder', 'location', 'note'], ready: (f) => !!(f.employeeId || String(f.holder ?? '').trim()), when: (s) => ['in_stock', 'demo'].includes(s) },
  { key: 'return', label: 'Return to stock', fields: ['location', 'note'], ready: () => true, when: (s) => ['issued', 'demo', 'sold', 'out', 'scrapped'].includes(s) },
  { key: 'move', label: 'Move location', fields: ['location', 'note'], ready: (f) => !!String(f.location ?? '').trim(), when: (s) => s !== 'scrapped' },
  { key: 'demo', label: 'Send on demo', fields: ['holder', 'location', 'note'], ready: () => true, when: (s) => s === 'in_stock' },
  { key: 'sell', label: 'Sell / hand to customer', fields: ['customerId', 'warrantyUntil', 'note'], ready: (f) => !!f.customerId, when: (s) => ['in_stock', 'demo', 'issued'].includes(s) },
  { key: 'rma', label: 'Send for RMA', fields: ['note'], ready: (f) => !!String(f.note ?? '').trim(), when: (s) => !['rma', 'scrapped'].includes(s) },
  { key: 'rma_in', label: 'Back from RMA', fields: ['location', 'warrantyUntil', 'note'], ready: () => true, when: (s) => s === 'rma' },
  { key: 'scrap', label: 'Scrap', fields: ['note'], ready: (f) => !!String(f.note ?? '').trim(), when: (s) => s !== 'scrapped', danger: true },
];
const FIELD_LABEL: Record<Field, string> = { employeeId: 'Employee', holder: 'Or another person / team', location: 'Location (site, vehicle, rack…)', customerId: 'Customer', warrantyUntil: 'Warranty until', note: 'Note' };
const NOTE_HINT: Record<string, string> = { rma: 'Fault, vendor, RMA / ticket number', scrap: 'Why it is written off' };

/** One unit: where it is, warranty, history, and the next custody step. */
function UnitPanel({ id, canAct, onClose, onChanged }: { id: string; canAct: boolean; onClose(): void; onChanged(): void }) {
  const [unit, setUnit] = useState<Rec | null>(null);
  const [look, setLook] = useState<Lookup | null>(null);
  const [step, setStep] = useState<(typeof STEPS)[number] | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const u = await api<Rec>(`r/serials.item/${id}`);
      setUnit(u);
      setLook(await api<Lookup>(`serials/lookup?${qs({ serial: String(u.serial) })}`));
    } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { setStep(null); setUnit(null); setLook(null); load(); }, [load]);
  const start = (s: (typeof STEPS)[number]) => { setStep(s); setForm(s.fields.includes('location') && s.key === 'move' ? { location: unit?.location ?? '' } : {}); setError(null); };
  const submit = async () => {
    if (!step) return;
    setBusy(true); setError(null);
    try {
      await api(`serials/${id}/action`, 'POST', { action: step.key, ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
      setStep(null); await load(); onChanged();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const status = String(unit?.status ?? '');

  return (
    <aside className="rounded-lg border border-border bg-card p-4 xl:sticky xl:top-20" aria-label="Unit details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-base font-semibold">{String(unit?.serial ?? '…')}</div>
          <div className="truncate text-sm text-muted-foreground">{unit ? itemOf(unit) : ''}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded px-1.5 text-muted-foreground hover:bg-muted">✕</button>
      </div>
      <ErrorBox error={error} />
      {unit && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={status} /><WarrantyBadge until={unit.warrantyUntil} long /></div>
          <dl className="mt-3 space-y-1.5 text-sm">
            {([
              ['Where', [ref(unit, 'warehouseId'), unit.location].filter(Boolean).join(' · ')],
              ['Other codes', String(unit.codes ?? '').split(/\s+/).filter(Boolean).join(' · ')],
              ['Held by', ref(unit, 'employeeId') ?? unit.holder], ['Customer', ref(unit, 'customerId')],
              ['Sold', unit.soldAt && String(unit.soldAt).slice(0, 10)], ['Supplier', ref(unit, 'vendorId')],
              ['Received', unit.receivedAt && String(unit.receivedAt).slice(0, 10)],
            ] as [string, unknown][]).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="text-end">{nice(v)}</dd></div>
            ))}
          </dl>
          {typeof unit.notes === 'string' && unit.notes && <p className="mt-2 rounded-md bg-muted p-2 text-xs">{unit.notes}</p>}

          {canAct && !step && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {STEPS.filter((s) => s.when(status)).map((s) => <Button key={s.key} size="sm" variant={s.danger ? 'ghost' : 'outline'} onClick={() => start(s)}>{s.label}</Button>)}
            </div>
          )}
          {step && (
            <div className="mt-3 space-y-2 rounded-lg border border-dashed border-border p-3">
              <div className="text-sm font-semibold">{step.label}</div>
              {step.fields.map((f) => (
                <label key={f} className="block text-sm">
                  <span className="mb-1 block text-xs text-muted-foreground">{FIELD_LABEL[f]}</span>
                  {f === 'customerId' || f === 'employeeId'
                    ? <RefPicker f={{ name: f, type: 'string', ref: f === 'customerId' ? 'sales.customer' : 'hrm.employee', label: FIELD_LABEL[f] }} value={form[f]} onChange={(v) => setForm({ ...form, [f]: v })} />
                    : f === 'note' ? <Textarea rows={2} value={String(form.note ?? '')} placeholder={NOTE_HINT[step.key]} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                    : <Input type={f === 'warrantyUntil' ? 'date' : 'text'} value={String(form[f] ?? '')} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />}
                </label>
              ))}
              {step.key === 'sell' && <p className="text-xs text-muted-foreground">Leave the warranty date empty to use the product&apos;s warranty months.</p>}
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant={step.danger ? 'danger' : undefined} disabled={busy || !step.ready(form)} onClick={submit}>{busy ? 'Saving…' : 'Save'}</Button>
                <Button size="sm" variant="ghost" onClick={() => setStep(null)}>Cancel</Button>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
            <Link href={`/r/serials.item/${id}`}><Button size="sm" variant="ghost">Edit details</Button></Link>
            <Button size="sm" variant="ghost" onClick={() => openDoc(`serials/${id}/history-page?format=html`).catch(setError)}>Print history</Button>
            <Button size="sm" variant="ghost" onClick={() => openDoc(`print/serials.item/${id}?template=label`).catch(setError)}>Label</Button>
          </div>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">History</h3>
          <div className="mt-2 max-h-[28rem] overflow-y-auto">
            {!look ? <p className="text-sm text-muted-foreground">Loading…</p> : (
              <Timeline items={[...look.history].reverse().map((h) => ({
                at: h.at,
                title: h.link ? <Link className="text-primary hover:underline" href={h.link}>{h.title}</Link> : h.title,
                body: [h.detail, h.by && `by ${h.by}`].filter(Boolean).join(' · ') || undefined,
              }))} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Bulk({ onOpen }: { onOpen(id: string): void }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ rows: Rec[]; unknown: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const check = async () => {
    setError(null);
    const serials = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (serials.length) try { setRes(await api('serials/bulk', 'POST', { serials })); } catch (e) { setError(e); }
  };
  return (
    <div className="space-y-3">
      <Textarea rows={6} aria-label="Serial numbers" placeholder="Paste or scan serial numbers — one per line, or separated by spaces/commas (up to 1000)" value={text} onChange={(e) => setText(e.target.value)} className="font-mono" />
      <div className="flex justify-end"><Button onClick={check}>Check</Button></div>
      <ErrorBox error={error} />
      {res && (
        <>
          <p className="text-sm">{res.rows.length} found{res.unknown.length > 0 && <span style={{ color: 'var(--tone-red)' }}> · not in the register: {res.unknown.join(', ')}</span>}</p>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => onOpen(r.id)}>
                    <td className="px-2 py-1.5 font-mono text-xs">{String(r.serial)}</td><td className="px-2 py-1.5">{itemOf(r)}</td>
                    <td className="px-2 py-1.5"><StatusBadge status={String(r.status)} /></td><td className="px-2 py-1.5 text-muted-foreground">{whereOf(r)}</td>
                    <td className="px-2 py-1.5"><WarrantyBadge until={r.warrantyUntil} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const STATUSES = ['in_stock', 'issued', 'demo', 'sold', 'rma', 'out', 'scrapped'];

/** Register by hand: scan one after another or paste a list; the details apply to all of them. */
function Register({ onDone }: { onDone(): void }) {
  const [text, setText] = useState('');
  const [f, setF] = useState<Record<string, unknown>>({ status: 'in_stock' });
  const [res, setRes] = useState<{ created: string[]; existing: string[]; failed?: { serial: string; error: string }[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v || undefined }));
  // "SN | IMEI2 | MAC" = one unit with extra codes; otherwise one or more serials per line.
  const units = text.split('\n').flatMap((line) => line.includes('|')
    ? [line.split('|').map((x) => x.trim()).filter(Boolean)].filter((u) => u.length)
    : line.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).map((x) => [x]));
  const serials = units.map((u) => u[0]);
  const codes = Object.fromEntries(units.filter((u) => u.length > 1).map((u) => [u[0], u.slice(1)]));
  const save = async () => {
    setBusy(true); setError(null); setRes(null);
    try { const r = await api<NonNullable<typeof res>>('serials/register', 'POST', { ...f, serials, codes }); setRes(r); if (r.created.length) { setText(''); onDone(); } } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const txt = (k: string, label: string, ph?: string) => (
    <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">{label}</span><Input value={String(f[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} /></label>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <Textarea rows={12} aria-label="Serial numbers to register" placeholder={'Scan or paste serial numbers — one per line.\nA unit with more codes: SERIAL | IMEI 2 | MAC'} value={text} onChange={(e) => setText(e.target.value)} className="font-mono" />
        <p className="mt-1 text-xs text-muted-foreground">{serials.length} serial(s) · ones already registered are skipped</p>
      </div>
      <div className="space-y-3">
        <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Inventory product (optional — sets make, model and warranty)</span><RefPicker f={{ name: 'productId', type: 'string', ref: 'inventory.product' }} value={f.productId} onChange={(v) => set('productId', v)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          {txt('itemName', 'Item name', 'e.g. Handheld radio')}{txt('brand', 'Make')}{txt('model', 'Model')}
          <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Status</span>
            <Select value={String(f.status ?? '')} onChange={(e) => set('status', e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{nice(s)}</option>)}</Select></label>
          {txt('location', 'Location', 'Site, vehicle, rack…')}{txt('holder', 'Held by', 'Person or team')}
          <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Customer (optional)</span><RefPicker f={{ name: 'customerId', type: 'string', ref: 'sales.customer' }} value={f.customerId} onChange={(v) => set('customerId', v)} /></label>
          <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Warranty until</span><Input type="date" value={String(f.warrantyUntil ?? '')} onChange={(e) => set('warrantyUntil', e.target.value)} /></label>
        </div>
        <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">Notes</span><Textarea rows={2} value={String(f.notes ?? '')} onChange={(e) => set('notes', e.target.value)} /></label>
        <div className="flex justify-end"><Button disabled={busy || !serials.length} onClick={save}>{busy ? 'Registering…' : `Register ${serials.length || ''}`}</Button></div>
        <ErrorBox error={error} />
        {res && (
          <div className="space-y-1 text-sm">
            <p><span style={{ color: 'var(--tone-green)' }}>{res.created.length} registered.</span>
              {res.existing.length > 0 && <span className="ms-2 text-muted-foreground">Already registered (skipped): {res.existing.join(', ')}</span>}</p>
            {!!res.failed?.length && <p style={{ color: 'var(--tone-red)' }}>Not saved: {res.failed.map((x) => `${x.serial} (${x.error})`).join(', ')}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
