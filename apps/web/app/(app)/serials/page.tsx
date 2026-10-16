'use client';
import { Button, Card, cx, EmptyState, ErrorBox, Input, PageHeader, Select, StatusBadge, Tabs, Textarea, Timeline } from '@erp/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { RefPicker } from '@/lib/RefPicker';
import { FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

type Rec = Record<string, unknown> & { id: string; _refs?: Record<string, string | null> };
interface Warranty { state: 'none' | 'active' | 'expiring' | 'expired'; daysLeft: number | null }
interface Lookup { serial: string; item: Rec | null; product: { id: string; sku: string; name: string } | null; warranty: Warranty; history: { at: string; title: string; detail?: string; link?: string }[] }

const TONE: Record<Warranty['state'], string> = { active: 'green', expiring: 'amber', expired: 'red', none: 'gray' };
function WarrantyBadge({ w, until }: { w: Warranty; until?: unknown }) {
  const text = w.state === 'none' ? 'No warranty on record' : w.state === 'expired' ? `Warranty expired ${String(until).slice(0, 10)}` : `Warranty until ${String(until).slice(0, 10)} (${w.daysLeft} days left)`;
  return <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={{ color: `var(--tone-${TONE[w.state]})`, background: `var(--tone-${TONE[w.state]}-bg)` }}>{text}</span>;
}
const d = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString() : '—');

/** Serial tracking: where a unit is, who has it, warranty and full history — by scan, bulk paste or expiry. */
export default function Page() {
  return <Suspense><Serials /></Suspense>;
}

function Serials() {
  const router = useRouter();
  // Registering adds stock-register units: only for roles with Create on Serial Tracking (the API enforces it too).
  const canRegister = can(useMeta(), 'serials.item.create');
  const asked = useSearchParams().get('tab') ?? 'lookup';
  const tab = asked === 'register' && !canRegister ? 'lookup' : asked;
  const setTab = (t: string) => router.replace(`/serials?tab=${t}`);
  return (
    <>
      <PageHeader title="Serial Tracking" subtitle="Scan or type a serial number to see where the unit is, who has it, its warranty and everything that happened to it" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'lookup', label: 'Look up' }, ...(canRegister ? [{ key: 'register', label: 'Register' }] : []), { key: 'bulk', label: 'Bulk check' }, { key: 'expiring', label: 'Warranty expiring' }]} />
      {tab === 'lookup' && <LookupTab />}
      {tab === 'register' && <RegisterTab />}
      {tab === 'bulk' && <BulkTab />}
      {tab === 'expiring' && <ExpiringTab />}
    </>
  );
}

function LookupTab() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Lookup | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setError(null); setRes(null);
    try { setRes(await api<Lookup>(`serials/lookup?${qs({ serial: q.trim() })}`)); } catch (err) { setError(err); } finally { setBusy(false); input.current?.select(); }
  };
  const it = res?.item;
  return (
    <div className="space-y-4">
      <form onSubmit={go} className="flex gap-2">
        <Input ref={input} aria-label="Serial number" placeholder="Scan or type a serial number, IMEI or asset tag…" value={q} onChange={(e) => setQ(e.target.value)} className="h-12 text-base" />
        <Button className="h-12 whitespace-nowrap px-6" disabled={busy}>{busy ? 'Searching…' : 'Look up'}</Button>
      </form>
      <ErrorBox error={error} />
      {res && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
          <Card title="History">
            {res.history.length ? (
              <Timeline items={res.history.map((h) => ({ at: h.at, title: h.link ? <Link className="text-primary hover:underline" href={h.link}>{h.title}</Link> : h.title, body: h.detail }))} />
            ) : <EmptyState title="No movements recorded yet" />}
          </Card>
          <Card title={res.serial}>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">{it ? <StatusBadge status={String(it.status)} /> : <span className="text-xs text-muted-foreground">Not in stock register (seen on repair jobs only)</span>}</div>
              <WarrantyBadge w={res.warranty} until={it?.warrantyUntil} />
              <dl className="space-y-2">
                {[
                  ['Product', res.product ? `${res.product.name} (${res.product.sku})` : '—'],
                  ['Location', it?._refs?.warehouseId ?? (it ? '—' : '')],
                  ['Customer', it?._refs?.customerId ?? '—'],
                  ['Sold', d(it?.soldAt)],
                  ['Supplier', it?._refs?.vendorId ?? '—'],
                  ['Received', d(it?.receivedAt)],
                ].filter(([, v]) => v !== '').map(([k, v]) => (
                  <div key={String(k)} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="text-end">{String(v)}</dd></div>
                ))}
              </dl>
              {typeof it?.notes === 'string' && it.notes && <p className="rounded-md bg-muted p-2 text-xs">{it.notes}</p>}
              {it && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href={`/r/serials.item/${it.id}`}><Button size="sm" variant="outline">Open / edit</Button></Link>
                  <Button size="sm" variant="ghost" onClick={() => openDoc(`serials/${it.id}/history-page?format=html`)}>Print history</Button>
                  <Button size="sm" variant="ghost" onClick={() => openDoc(`print/serials.item/${it.id}?template=label`)}>Label</Button>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function BulkTab() {
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ rows: (Rec & { warranty: Warranty })[]; unknown: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const check = async () => {
    setError(null);
    const serials = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!serials.length) return;
    try { setRes(await api('serials/bulk', 'POST', { serials })); } catch (e) { setError(e); }
  };
  return (
    <div className="space-y-4">
      <Card>
        <Textarea rows={6} aria-label="Serial numbers" placeholder="Paste or scan serial numbers — one per line, or separated by spaces/commas" value={text} onChange={(e) => setText(e.target.value)} className="font-mono" />
        <div className="mt-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">Up to 1000 at a time</span><Button onClick={check}>Check</Button></div>
      </Card>
      <ErrorBox error={error} />
      {res && (
        <Card title={`${res.rows.length} found${res.unknown.length ? ` · ${res.unknown.length} unknown` : ''}`}>
          {res.unknown.length > 0 && <p className="mb-3 text-sm" style={{ color: 'var(--tone-red)' }}>Unknown: {res.unknown.join(', ')}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>{['Serial', 'Product', 'Status', 'Location', 'Customer', 'Warranty'].map((h) => <th key={h} className="px-2 py-1.5 text-start font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-2 py-2 font-mono"><Link className="text-primary hover:underline" href={`/r/serials.item/${r.id}`}>{String(r.serial)}</Link></td>
                    <td className="px-2 py-2">{r._refs?.productId ?? '—'}</td>
                    <td className="px-2 py-2"><StatusBadge status={String(r.status)} /></td>
                    <td className="px-2 py-2">{r._refs?.warehouseId ?? '—'}</td>
                    <td className="px-2 py-2">{r._refs?.customerId ?? '—'}</td>
                    <td className={cx('px-2 py-2')}>{r.warranty.state === 'none' ? '—' : <WarrantyBadge w={r.warranty} until={r.warrantyUntil} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ExpiringTab() {
  const [days, setDays] = useState('30');
  const [rows, setRows] = useState<Rec[] | null>(null);
  useEffect(() => { setRows(null); api<Rec[]>(`serials/warranty/expiring?days=${days}`).then(setRows).catch(() => setRows([])); }, [days]);
  return (
    <Card title="Warranties ending soon" actions={<Select aria-label="Within" value={days} onChange={(e) => setDays(e.target.value)} className="w-40"><option value="30">Next 30 days</option><option value="60">Next 60 days</option><option value="90">Next 90 days</option></Select>}>
      {!rows ? null : !rows.length ? <EmptyState title="No warranties ending in this period" /> : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link className="font-mono text-primary hover:underline" href={`/r/serials.item/${r.id}`}>{String(r.serial)}</Link>
              <span className="text-muted-foreground">{r._refs?.productId} · {r._refs?.customerId ?? 'no customer'}</span>
              <span className="tabular-nums">{String(r.warrantyUntil).slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const STATUSES = ['in_stock', 'issued', 'demo', 'rma', 'sold', 'out', 'scrapped'];

/** Register serials by hand — scan one after another or paste a list; details below apply to all of them. */
function RegisterTab() {
  const [text, setText] = useState('');
  const [f, setF] = useState<Record<string, unknown>>({ status: 'in_stock' });
  const [res, setRes] = useState<{ created: string[]; existing: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v || undefined }));
  const serials = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true); setError(null); setRes(null);
    try { const r = await api<{ created: string[]; existing: string[] }>('serials/register', 'POST', { ...f, serials }); setRes(r); if (r.created.length) setText(''); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const txt = (k: string, label: string, ph?: string) => (
    <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span><Input value={String(f[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} /></label>
  );
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card title="Serial numbers">
        <Textarea rows={10} aria-label="Serial numbers to register" placeholder="Scan or paste serial numbers — one per line, or separated by spaces/commas" value={text} onChange={(e) => setText(e.target.value)} className="font-mono" />
        <p className="mt-2 text-xs text-muted-foreground">{serials.length} serial(s) · already-registered ones are skipped</p>
      </Card>
      <Card title="Details (applied to all)">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2"><span className="mb-1 block text-muted-foreground">Inventory product (optional)</span><RefPicker f={{ name: "productId", type: "string", ref: "inventory.product" }} value={f.productId} onChange={(v) => set('productId', v)} /></label>
          {txt('itemName', 'Item name', 'e.g. Handheld radio')}
          {txt('brand', 'Make')}
          {txt('model', 'Model')}
          <label className="block text-sm"><span className="mb-1 block text-muted-foreground">Status</span>
            <Select value={String(f.status ?? '')} onChange={(e) => set('status', e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</Select></label>
          {txt('location', 'Location', 'Site, vehicle, rack…')}
          {txt('holder', 'Held by', 'Person or team')}
          <label className="block text-sm"><span className="mb-1 block text-muted-foreground">Customer (optional)</span><RefPicker f={{ name: "customerId", type: "string", ref: "sales.customer" }} value={f.customerId} onChange={(v) => set('customerId', v)} /></label>
          <label className="block text-sm"><span className="mb-1 block text-muted-foreground">Warranty until</span><Input type="date" value={String(f.warrantyUntil ?? '')} onChange={(e) => set('warrantyUntil', e.target.value)} /></label>
          <label className="block text-sm sm:col-span-2"><span className="mb-1 block text-muted-foreground">Notes</span><Textarea rows={2} value={String(f.notes ?? '')} onChange={(e) => set('notes', e.target.value)} /></label>
        </div>
        <div className="mt-4 flex justify-end"><Button disabled={busy || !serials.length} onClick={save}>{busy ? 'Registering…' : `Register ${serials.length || ''}`}</Button></div>
        <div className="mt-3"><ErrorBox error={error} /></div>
        {res && (
          <p className="mt-3 text-sm">
            <span style={{ color: 'var(--tone-green)' }}>{res.created.length} registered.</span>
            {res.existing.length > 0 && <span className="ms-2 text-muted-foreground">Already registered (skipped): {res.existing.join(', ')}</span>}
          </p>
        )}
      </Card>
    </div>
  );
}
