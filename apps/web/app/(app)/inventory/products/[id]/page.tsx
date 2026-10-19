'use client';
import { Button, Card, cx, Dialog, ErrorBox, FieldMeta, FormGrid, humanize, Input, PageHeader, RefRenderer, Skeleton, StatusBadge } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta, useResource } from '@/lib/meta';
import { renderRef as refPicker } from '@/lib/RefPicker';
import { FileField, FilesField } from '@/lib/FilePanel';

type Rec = Record<string, unknown> & { id?: string; _refs?: Record<string, string | null> };
const KEY = 'inventory.product';
/** The product form in the order a storekeeper fills it; anything not listed (custom fields) goes under "More". */
const SECTIONS: [string, string, string[]][] = [
  ['Item', 'What it is and how it is grouped', ['name', 'brand', 'model', 'kind', 'categoryId', 'unitId', 'isActive', 'isService']],
  ['Pricing', 'Selling price and tax; cost is the running average from receipts', ['price', 'taxId', 'cost']],
  ['Stock control', 'When to reorder, and how units are tracked', ['reorderLevel', 'serialized', 'warrantyMonths']],
  ['Compatibility', 'Models or equipment this part fits', ['compatible']],
  ['Images', '', ['images']],
];
const LABELS: Record<string, string> = { kind: 'Kind', sku: 'SKU (automatic)', categoryId: 'Category', brand: 'Brand', unitId: 'Unit', taxId: 'Tax', cost: 'Average cost', reorderLevel: 'Reorder when stock falls to', serialized: 'Track serial numbers', warrantyMonths: 'Warranty (months, 0 = company default)', isService: 'Service (no stock)', isActive: 'Active', compatible: 'Compatible with' };
// SKU is system-made and shown in the header; barcodes have their own card.
const SKIP = new Set(['sku', 'barcode', 'barcodes', 'custom']);
const n = (v: unknown) => Number(v ?? 0) || 0;
const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const splitCodes = (s: unknown) => String(s ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/** Product screen: one structured form (with a real barcode editor) plus live stock and movements for saved products. */
export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const search = useSearchParams();
  const router = useRouter();
  const meta = useMeta();
  const r = useResource(KEY);
  const [rec, setRec] = useState<Rec>({});
  const [values, setValues] = useState<Rec>(() => (isNew ? { isActive: true, kind: 'product', ...Object.fromEntries(search.entries()) } : {}));
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [labels, setLabels] = useState(false);

  const load = useCallback(() => {
    if (isNew) return;
    api<Rec>(`r/${KEY}/${id}`).then((d) => { setRec(d); setValues(d); setLoaded(true); }).catch((e) => { setError(e); setLoaded(true); });
  }, [id, isNew]);
  useEffect(load, [load]);

  const canEdit = !!r && (isNew ? r.can.create : r.can.update);
  // Brand and model render as typeable dropdowns (pseudo-refs handled in renderRef below).
  const fields = useMemo(() => (r?.fields ?? []).map((f) => ({ ...f, label: LABELS[f.name] ?? f.label, ...(f.name === 'brand' || f.name === 'model' ? { ref: `@${f.name}` } : {}) })) as FieldMeta[], [r]);
  const [opts, setOpts] = useState<{ brands: string[]; models: { brand: string; model: string }[] }>({ brands: [], models: [] });
  useEffect(() => { api<typeof opts>('inventory/products/options').then(setOpts).catch(() => {}); }, []);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const listed = new Set(SECTIONS.flatMap(([, , names]) => names));
  const extra = fields.filter((f) => !listed.has(f.name) && !SKIP.has(f.name) && !f.restricted);
  const pick = (names: string[]) => names.map((x) => byName.get(x)).filter((f): f is FieldMeta => !!f);
  const renderRef: RefRenderer = (f, v, onChange, refs) =>
    f.ref === '@brand' || f.ref === '@model' ? (
      <>
        <Input id={f.name} aria-label={f.label} list={`${f.name}-options`} value={String(v ?? '')} disabled={!canEdit} autoComplete="off"
          placeholder={f.name === 'brand' ? 'Pick or type a new brand' : 'Pick or type'} onChange={(e) => onChange(e.target.value || null)} />
        <datalist id={`${f.name}-options`}>
          {(f.name === 'brand' ? opts.brands : [...new Set(opts.models.filter((m) => !values.brand || m.brand.toLowerCase() === String(values.brand).toLowerCase()).map((m) => m.model))]).map((o) => <option key={o} value={o} />)}
        </datalist>
      </>
    ) :
    f.type === 'file' ? <FileField f={f} value={v} onChange={onChange} entityType={KEY} entityId={isNew ? null : id} />
    : f.type === 'files' ? <FilesField f={f} value={v} onChange={onChange} entityType={KEY} entityId={isNew ? null : id} />
    : refPicker(f, v, onChange, refs ?? rec._refs);
  const change = (k: string, v: unknown) => {
    setSaved(false);
    if (k === 'brand') setAuto((a) => ({ ...a, make: false }));
    if (k === 'model') setAuto((a) => ({ ...a, model: false }));
    setValues((s) => ({ ...s, [k]: v }));
  };

  // New product: SKU and make follow the name/make/model until the user types their own (server keeps the SKU unique).
  const [auto, setAuto] = useState(() => ({ make: isNew && !search.get('brand'), model: isNew && !search.get('model') }));
  const suggested = useRef({ make: '' });
  const { name, brand, model } = values as { name?: string; brand?: string; model?: string };
  useEffect(() => {
    if (!isNew || !auto.make || !String(name ?? '').trim()) return;
    const t = setTimeout(() => {
      // A late answer only replaces a blank field or our own last suggestion, never what was typed meanwhile.
      const mine = (cur: unknown, last: string) => !String(cur ?? '').trim() || cur === last;
      api<{ sku: string; make: string | null }>(`inventory/products/suggest?${qs({ name, model })}`).then((sg) => setValues((v) => {
        const next = { ...v };
        if (auto.make && sg.make && mine(v.brand, suggested.current.make)) next.brand = suggested.current.make = sg.make;
        return next;
      })).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [isNew, auto, name, model]);
  // Model follows the name (minus the brand) until typed, so "Hytera PD785" needs typing once, not twice.
  useEffect(() => {
    if (!isNew || !auto.model) return;
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    const rest = brand && words[0]?.toLowerCase() === String(brand).toLowerCase() ? words.slice(1) : words;
    setValues((v) => (v.model === (rest.join(' ') || null) ? v : { ...v, model: rest.join(' ') || null }));
  }, [isNew, auto.model, name, brand]);

  const save = async () => {
    if (!r) return;
    setBusy(true); setError(null);
    try {
      const body: Rec = {};
      for (const f of fields) if (!f.readonly && values[f.name] !== undefined) body[f.name] = values[f.name];
      const out = await api<Rec>(isNew ? `r/${KEY}` : `r/${KEY}/${id}`, isNew ? 'POST' : 'PATCH', body);
      if (isNew) router.replace(`/inventory/products/${out.id}`);
      else { setRec(out); setValues(out); setSaved(true); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!r) return <p className="text-sm text-muted-foreground">You don&apos;t have access to products.</p>;
  if (!loaded) return <Skeleton className="h-96" />;
  const title = isNew ? (values.kind === 'part' ? 'New spare part' : 'New product') : String(rec.name ?? 'Product');
  const missing = !String(values.name ?? '').trim();

  return (
    <>
      <div className="mb-1 text-xs text-muted-foreground">{values.kind === 'part'
        ? <Link className="hover:underline" href="/r/inventory.product?kind=part">Repair › Spare parts</Link>
        : <Link className="hover:underline" href="/r/inventory.product?kind=product">Inventory › Products</Link>}</div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{title}
          {!isNew && <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">{rec.kind === 'part' ? 'Spare part' : 'Product'}</span>}
          {!isNew && <StatusBadge status={rec.isActive === false ? 'inactive' : 'active'} />}</span>}
        subtitle={isNew ? 'Only the name is required — the SKU is made when you save'
          : <span>SKU <span className="font-mono text-foreground">{String(rec.sku)}</span>{[rec._refs?.categoryId, [rec.brand, rec.model].filter(Boolean).join(' ')].filter((x) => x && x !== '—').map((x) => ` · ${x}`).join('')}</span>}
        actions={<div className="flex flex-wrap gap-2">
          {!isNew && can(meta, 'inventory.product.print') && <Button variant="outline" onClick={() => setLabels(true)}>Print labels</Button>}
          {!isNew && r.can.delete && <Button variant="ghost" onClick={async () => {
            // Soft delete: the product leaves lists and pickers; its stock history stays.
            if (!confirm(`Delete ${rec.name}? It disappears from lists and pickers; its stock history is kept.`)) return;
            try { await api(`r/${KEY}/${id}`, 'DELETE'); router.replace(`/r/inventory.product?kind=${rec.kind === 'part' ? 'part' : 'product'}`); } catch (e) { setError(e); }
          }}>Delete</Button>}
          {canEdit && <Button disabled={busy || missing} onClick={save}>{busy ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}</Button>}
        </div>} />
      <ErrorBox error={error} />
      {saved && <p className="mb-3 text-sm" role="status" style={{ color: 'var(--tone-green)' }}>Saved.</p>}

      <div className={cx('grid items-start gap-4', !isNew && 'xl:grid-cols-[1fr_22rem]')}>
        <div className="min-w-0 space-y-4">
          {SECTIONS.map(([t, hint, names], i) => {
            const fs = pick(names);
            // Compatibility matters for spare parts only.
            if (!fs.length || (t === 'Compatibility' && values.kind !== 'part')) return null;
            return (
              <div key={t} className="space-y-4">
                <Card title={<span>{t}{hint && <span className="ms-2 text-xs font-normal text-muted-foreground">{hint}</span>}</span>}>
                  <FormGrid fields={fs} values={values} onChange={change} renderRef={renderRef} disabled={!canEdit} />
                  {i === 0 && isNew && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      The SKU is created automatically when you save (from the brand, model and name).{auto.make && ' Brand is picked up from the name; model follows it.'}
                    </p>
                  )}
                </Card>
                {/* Barcodes sit right after the item's identity. */}
                {i === 0 && <Barcodes main={values.barcode} extra={values.barcodes} sku={isNew ? null : String(rec.sku ?? '')} disabled={!canEdit} onChange={(k, v) => change(k, v)} />}
              </div>
            );
          })}
          {extra.length > 0 && <Card title="More"><FormGrid fields={extra} values={values} onChange={change} renderRef={renderRef} disabled={!canEdit} /></Card>}
        </div>
        {!isNew && <StockPanel id={id} rec={rec} />}
      </div>
      {!isNew && <LabelsDialog open={labels} onClose={() => setLabels(false)} id={id} rec={rec} onError={setError} />}
    </>
  );
}

/**
 * Every code that finds this item, as one list: the SKU first (built in, always there), then any barcodes it carries
 * (maker's EAN, other suppliers, packs). Scan or type + Enter to add; all of them scan and print as labels.
 */
function Barcodes({ main, extra, sku, disabled, onChange }: { main: unknown; extra: unknown; sku: string | null; disabled: boolean; onChange(k: 'barcode' | 'barcodes', v: unknown): void }) {
  const [draft, setDraft] = useState('');
  const own = String(main ?? '').trim();
  const codes = splitCodes(extra);
  const add = () => {
    const fresh = splitCodes(draft).filter((c) => c !== own && c !== sku && !codes.includes(c));
    if (fresh.length) onChange('barcodes', [...codes, ...fresh].join('\n'));
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  const chip = (c: string, note?: string, remove?: () => void) => (
    <span key={c} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs">
      {c}{note && <span className="font-sans text-[10px] text-muted-foreground">{note}</span>}
      {remove && !disabled && <button type="button" aria-label={`Remove ${c}`} className="text-muted-foreground hover:text-foreground" onClick={remove}>✕</button>}
    </span>
  );
  return (
    <Card title={<span>Barcodes<span className="ms-2 text-xs font-normal text-muted-foreground">scanning any of these finds this item</span></span>}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5 text-sm">
        {sku ? chip(sku, 'SKU · built in') : <span className="px-1 text-xs text-muted-foreground">SKU — made when you save</span>}
        {own && own !== sku && chip(own, undefined, () => onChange('barcode', null))}
        {codes.map((c) => chip(c, undefined, () => onChange('barcodes', codes.filter((x) => x !== c).join('\n') || null)))}
        {!disabled && <input aria-label="Add barcode" className="min-w-48 flex-1 bg-transparent px-1 py-1 font-mono text-xs outline-none" placeholder="Add a barcode — scan or type, then Enter" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Add the maker&apos;s barcode or codes from other suppliers and packs. Each code can belong to one item only. All of them print with <b>Print labels</b>.</p>
    </Card>
  );
}

/** Labels for this product: pick which of its barcodes (main + extras; SKU if none) and how many of each. */
function LabelsDialog({ open, onClose, id, rec, onError }: { open: boolean; onClose(): void; id: string; rec: Rec; onError(e: unknown): void }) {
  const codes = [...new Set([String(rec.barcode ?? '').trim(), ...splitCodes(rec.barcodes)].filter(Boolean))];
  const [pick, setPick] = useState<string[]>(codes);
  const [copies, setCopies] = useState(1);
  const [style, setStyle] = useState<'barcode' | 'qr'>('barcode');
  useEffect(() => { if (open) setPick(codes); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const print = () => openDoc(`print/${KEY}/${id}?${qs({ template: 'labels', codes: codes.length ? pick.join(',') : undefined, copies, code: style === 'qr' ? 'qr' : undefined })}`).then(onClose).catch(onError);
  return (
    <Dialog open={open} onClose={onClose} title="Print labels" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={codes.length > 0 && !pick.length} onClick={print}>Print {(codes.length ? pick.length : 1) * copies} label{(codes.length ? pick.length : 1) * copies === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-3 text-sm">
        {codes.length ? (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs text-muted-foreground">Barcodes to print (50 × 30 mm, one per label)</legend>
            {codes.map((c, i) => (
              <label key={c} className="flex items-center gap-2">
                <input type="checkbox" checked={pick.includes(c)} onChange={(e) => setPick((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))} />
                <span className="font-mono">{c}</span>{i === 0 && !!rec.barcode && <span className="text-xs text-muted-foreground">main</span>}
              </label>
            ))}
          </fieldset>
        ) : <p className="text-muted-foreground">This product has no barcode yet — the label will carry its SKU ({String(rec.sku)}).</p>}
        <fieldset className="flex gap-4"><legend className="mb-1 text-xs text-muted-foreground">Print as</legend>
          {(['barcode', 'qr'] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5"><input type="radio" name="label-style" checked={style === v} onChange={() => setStyle(v)} />{v === 'qr' ? 'QR code' : 'Barcode'}</label>
          ))}
        </fieldset>
        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">Copies of each</span>
          <Input type="number" min={1} max={200} value={copies} onChange={(e) => setCopies(Math.min(Math.max(Number(e.target.value) || 1, 1), 200))} className="w-28" /></label>
      </div>
    </Dialog>
  );
}

/** Saved product: on-hand per warehouse, reorder warning, margin, and the latest stock movements. */
function StockPanel({ id, rec }: { id: string; rec: Rec }) {
  const meta = useMeta();
  const [stock, setStock] = useState<Rec[] | null>(null);
  const [moves, setMoves] = useState<Rec[] | null>(null);
  const [jobs, setJobs] = useState<Rec[] | null>(null);
  useEffect(() => {
    const f = (x: object) => encodeURIComponent(JSON.stringify(x));
    if (can(meta, 'inventory.stock.view')) api<{ rows: Rec[] }>(`r/inventory.stock?pageSize=100&filters=${f({ productId: id })}`).then((d) => setStock(d.rows)).catch(() => setStock([]));
    if (can(meta, 'inventory.movement.view')) api<{ rows: Rec[] }>(`r/inventory.movement?${qs({ pageSize: 10, sort: 'at:desc' })}&filters=${f({ productId: id })}`).then((d) => setMoves(d.rows)).catch(() => setMoves([]));
    // Repairs of this item: jobs linked to it at intake, plus older jobs with the same make and model.
    if (can(meta, 'repair.job.view')) {
      const same = rec.brand && rec.model ? [{ brand: rec.brand, model: rec.model }] : [];
      api<{ rows: Rec[]; total: number }>(`r/repair.job?${qs({ pageSize: 8, sort: 'createdAt:desc' })}&filters=${f({ $or: [{ productId: id }, ...same] })}`).then((d) => setJobs(d.rows)).catch(() => setJobs([]));
    }
  }, [id, meta, rec.brand, rec.model]);
  const onHand = (stock ?? []).reduce((s, x) => s + n(x.qty), 0);
  const low = !rec.isService && n(rec.reorderLevel) > 0 && onHand <= n(rec.reorderLevel);
  const margin = n(rec.price) > 0 && rec.cost !== undefined ? ((n(rec.price) - n(rec.cost)) / n(rec.price)) * 100 : null;

  return (
    <aside className="space-y-4 xl:sticky xl:top-20" aria-label="Stock">
      <Card title="Stock">
        {rec.isService ? <p className="text-sm text-muted-foreground">Service item — not stocked.</p> : stock === null ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-semibold tabular-nums">{fmt(onHand)}</span>
              <span className="text-xs text-muted-foreground">on hand{n(rec.reorderLevel) > 0 && ` · reorder at ${fmt(n(rec.reorderLevel))}`}</span>
            </div>
            {low && <p className="mt-2 rounded-md px-2 py-1 text-xs" style={{ color: 'var(--tone-amber)', background: 'var(--tone-amber-bg)' }}>At or below the reorder level — time to reorder.</p>}
            <ul className="mt-3 divide-y divide-border text-sm">
              {stock.length ? stock.map((s) => (
                <li key={String(s.id)} className="flex justify-between py-1.5"><span>{s._refs?.warehouseId ?? '—'}</span><span className="tabular-nums">{fmt(n(s.qty))}</span></li>
              )) : <li className="py-1.5 text-muted-foreground">No stock in any warehouse yet.</li>}
            </ul>
          </>
        )}
      </Card>
      <Card title="Price">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">Selling price</dt><dd className="tabular-nums">{fmt(n(rec.price))}</dd></div>
          {rec.cost !== undefined && <div className="flex justify-between"><dt className="text-muted-foreground">Average cost</dt><dd className="tabular-nums">{fmt(n(rec.cost))}</dd></div>}
          {margin !== null && <div className="flex justify-between"><dt className="text-muted-foreground">Margin</dt><dd className={cx('tabular-nums', margin < 0 && 'text-red-600')}>{margin.toFixed(1)}%</dd></div>}
        </dl>
      </Card>
      {jobs !== null && (
        <Card title="Repair history" actions={jobs.length ? <span className="text-xs text-muted-foreground">latest {jobs.length}</span> : undefined}>
          {!jobs.length ? <p className="text-sm text-muted-foreground">No repairs of this item yet.</p> : (
            <ul className="divide-y divide-border text-sm">
              {jobs.map((j) => (
                <li key={String(j.id)} className="flex items-baseline justify-between gap-2 py-1.5">
                  <span className="min-w-0"><Link className="text-primary hover:underline" href={`/r/repair.job/${j.id}`}>{String(j.number)}</Link>
                    <span className="block truncate text-xs text-muted-foreground">{[j._refs?.customerId, j.serial && `S/N ${j.serial}`, j.fault].filter((x) => x && x !== '—').join(' · ')}</span></span>
                  <StatusBadge status={String(j.status)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {moves !== null && (
        <Card title="Recent movements" actions={<Link className="text-xs text-primary hover:underline" href={`/r/inventory.movement?${qs({ filters: JSON.stringify({ productId: id }) })}`}>All</Link>}>
          {!moves.length ? <p className="text-sm text-muted-foreground">No movements yet.</p> : (
            <ul className="divide-y divide-border text-sm">
              {moves.map((m) => (
                <li key={String(m.id)} className="flex items-baseline justify-between gap-2 py-1.5">
                  <span className="min-w-0"><span className="block truncate">{humanize(String(m.type ?? ''))}{m.serial ? ` · ${m.serial}` : ''}</span>
                    <span className="text-xs text-muted-foreground">{String(m.at ?? '').slice(0, 10)} · {m._refs?.warehouseId ?? ''}</span></span>
                  <span className={cx('tabular-nums', n(m.qty) < 0 && 'text-red-600')}>{n(m.qty) > 0 ? '+' : ''}{fmt(n(m.qty))}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </aside>
  );
}
