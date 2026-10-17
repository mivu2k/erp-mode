'use client';
import { Button, Card, cx, ErrorBox, FieldMeta, FormGrid, humanize, Input, PageHeader, RefRenderer, Skeleton, StatusBadge } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta, useResource } from '@/lib/meta';
import { renderRef as refPicker } from '@/lib/RefPicker';
import { FileField, FilesField } from '@/lib/FilePanel';

type Rec = Record<string, unknown> & { id?: string; _refs?: Record<string, string | null> };
const KEY = 'inventory.product';
/** The product form in the order a storekeeper fills it; anything not listed (custom fields) goes under "More". */
const SECTIONS: [string, string, string[]][] = [
  ['Item', 'What it is and how it is grouped', ['name', 'sku', 'categoryId', 'brand', 'model', 'unitId', 'isService', 'isActive']],
  ['Pricing', 'Selling price and tax; cost is the running average from receipts', ['price', 'taxId', 'cost']],
  ['Stock control', 'When to reorder, and how units are tracked', ['reorderLevel', 'serialized', 'warrantyMonths']],
  ['Compatibility', 'Models or equipment this part fits', ['compatible']],
  ['Images', '', ['images']],
];
const LABELS: Record<string, string> = { sku: 'SKU / item code', categoryId: 'Category', brand: 'Make', unitId: 'Unit', taxId: 'Tax', cost: 'Average cost', reorderLevel: 'Reorder when stock falls to', serialized: 'Track serial numbers', warrantyMonths: 'Warranty (months, 0 = company default)', isService: 'Service (no stock)', isActive: 'Active', compatible: 'Compatible with' };
const SKIP = new Set(['barcode', 'barcodes', 'custom']);
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
  const [values, setValues] = useState<Rec>(() => (isNew ? { isActive: true, ...Object.fromEntries(search.entries()) } : {}));
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    if (isNew) return;
    api<Rec>(`r/${KEY}/${id}`).then((d) => { setRec(d); setValues(d); setLoaded(true); }).catch((e) => { setError(e); setLoaded(true); });
  }, [id, isNew]);
  useEffect(load, [load]);

  const canEdit = !!r && (isNew ? r.can.create : r.can.update);
  const fields = useMemo(() => (r?.fields ?? []).map((f) => ({ ...f, label: LABELS[f.name] ?? f.label })) as FieldMeta[], [r]);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const listed = new Set(SECTIONS.flatMap(([, , names]) => names));
  const extra = fields.filter((f) => !listed.has(f.name) && !SKIP.has(f.name) && !f.restricted);
  const pick = (names: string[]) => names.map((x) => byName.get(x)).filter((f): f is FieldMeta => !!f);
  const renderRef: RefRenderer = (f, v, onChange, refs) =>
    f.type === 'file' ? <FileField f={f} value={v} onChange={onChange} entityType={KEY} entityId={isNew ? null : id} />
    : f.type === 'files' ? <FilesField f={f} value={v} onChange={onChange} entityType={KEY} entityId={isNew ? null : id} />
    : refPicker(f, v, onChange, refs ?? rec._refs);
  const change = (k: string, v: unknown) => {
    setSaved(false);
    if (k === 'sku') setAuto((a) => ({ ...a, sku: false }));
    if (k === 'brand') setAuto((a) => ({ ...a, make: false }));
    setValues((s) => ({ ...s, [k]: v }));
  };

  // New product: SKU and make follow the name/make/model until the user types their own (server keeps the SKU unique).
  const [auto, setAuto] = useState(() => ({ sku: isNew && !search.get('sku'), make: isNew && !search.get('brand') }));
  const [roll, setRoll] = useState(0);
  const { name, brand, model } = values as { name?: string; brand?: string; model?: string };
  useEffect(() => {
    if (!isNew || (!auto.sku && !auto.make) || !String(name ?? '').trim()) return;
    const t = setTimeout(() => {
      api<{ sku: string; make: string | null }>(`inventory/products/suggest?${qs({ name, make: auto.make ? undefined : brand, model })}`).then((sg) => setValues((v) => ({
        ...v,
        ...(auto.sku ? { sku: sg.sku } : {}),
        ...(auto.make && sg.make ? { brand: sg.make } : {}),
      }))).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [isNew, auto, name, brand, model, roll]);

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
  const title = isNew ? 'New product' : String(rec.name ?? 'Product');
  const missing = !String(values.name ?? '').trim() || !String(values.sku ?? '').trim();

  return (
    <>
      <div className="mb-1 text-xs text-muted-foreground"><Link className="hover:underline" href="/r/inventory.product">Inventory › Products</Link></div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{title}{!isNew && <StatusBadge status={rec.isActive === false ? 'inactive' : 'active'} />}</span>}
        subtitle={isNew ? 'Name and SKU are required; everything else can be added later' : [rec.sku, rec._refs?.categoryId, [rec.brand, rec.model].filter(Boolean).join(' ')].filter((x) => x && x !== '—').join(' · ')}
        actions={<div className="flex flex-wrap gap-2">
          {!isNew && can(meta, 'inventory.product.print') && <Button variant="outline" onClick={() => openDoc(`print/${KEY}/${id}?template=label`).catch(setError)}>Print label</Button>}
          {canEdit && <Button disabled={busy || missing} onClick={save}>{busy ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}</Button>}
        </div>} />
      <ErrorBox error={error} />
      {saved && <p className="mb-3 text-sm" role="status" style={{ color: 'var(--tone-green)' }}>Saved.</p>}

      <div className={cx('grid items-start gap-4', !isNew && 'xl:grid-cols-[1fr_22rem]')}>
        <div className="min-w-0 space-y-4">
          {SECTIONS.map(([t, hint, names], i) => {
            const fs = pick(names);
            if (!fs.length) return null;
            return (
              <div key={t} className="space-y-4">
                <Card title={<span>{t}{hint && <span className="ms-2 text-xs font-normal text-muted-foreground">{hint}</span>}</span>}>
                  <FormGrid fields={fs} values={values} onChange={change} renderRef={renderRef} disabled={!canEdit} />
                  {i === 0 && isNew && (
                    <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {auto.sku ? 'SKU is made from the make, model or name.' : 'Using your own SKU.'}
                      {auto.make && ' Make is picked up from the name.'}
                      <button type="button" className="text-primary hover:underline" onClick={() => { setAuto((a) => ({ ...a, sku: true })); setRoll((x) => x + 1); }}>{auto.sku ? 'New SKU' : 'Generate SKU'}</button>
                    </p>
                  )}
                </Card>
                {/* Barcodes sit right after the item's identity. */}
                {i === 0 && <Barcodes main={values.barcode} extra={values.barcodes} disabled={!canEdit} onChange={(k, v) => change(k, v)} />}
              </div>
            );
          })}
          {extra.length > 0 && <Card title="More"><FormGrid fields={extra} values={values} onChange={change} renderRef={renderRef} disabled={!canEdit} /></Card>}
        </div>
        {!isNew && <StockPanel id={id} rec={rec} />}
      </div>
    </>
  );
}

/** Main barcode (printed on the label) plus any number of extra codes, as chips; all optional. Scanners type + Enter. */
function Barcodes({ main, extra, disabled, onChange }: { main: unknown; extra: unknown; disabled: boolean; onChange(k: 'barcode' | 'barcodes', v: unknown): void }) {
  const [draft, setDraft] = useState('');
  const codes = splitCodes(extra);
  const add = () => {
    const fresh = splitCodes(draft).filter((c) => c !== String(main ?? '') && !codes.includes(c));
    if (fresh.length) onChange('barcodes', [...codes, ...fresh].join('\n'));
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  return (
    <Card title={<span>Barcodes<span className="ms-2 text-xs font-normal text-muted-foreground">optional · any number · each code belongs to one product only</span></span>}>
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Main barcode (printed on the label)</span>
          <Input aria-label="Barcode" className="font-mono" value={String(main ?? '')} disabled={disabled} placeholder="Scan or type" onChange={(e) => onChange('barcode', e.target.value || null)} />
        </label>
        <div className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Other barcodes (other suppliers, packs, old labels)</span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5">
            {codes.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {c}
                {!disabled && <button type="button" aria-label={`Remove ${c}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange('barcodes', codes.filter((x) => x !== c).join('\n') || null)}>✕</button>}
              </span>
            ))}
            {!disabled && <input aria-label="Add barcode" className="min-w-40 flex-1 bg-transparent px-1 py-1 font-mono text-xs outline-none" placeholder={codes.length ? 'Add another…' : 'Scan or type, then Enter'} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />}
            {disabled && !codes.length && <span className="px-1 text-xs text-muted-foreground">None</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Saved product: on-hand per warehouse, reorder warning, margin, and the latest stock movements. */
function StockPanel({ id, rec }: { id: string; rec: Rec }) {
  const meta = useMeta();
  const [stock, setStock] = useState<Rec[] | null>(null);
  const [moves, setMoves] = useState<Rec[] | null>(null);
  useEffect(() => {
    const f = (x: object) => encodeURIComponent(JSON.stringify(x));
    if (can(meta, 'inventory.stock.view')) api<{ rows: Rec[] }>(`r/inventory.stock?pageSize=100&filters=${f({ productId: id })}`).then((d) => setStock(d.rows)).catch(() => setStock([]));
    if (can(meta, 'inventory.movement.view')) api<{ rows: Rec[] }>(`r/inventory.movement?${qs({ pageSize: 10, sort: 'at:desc' })}&filters=${f({ productId: id })}`).then((d) => setMoves(d.rows)).catch(() => setMoves([]));
  }, [id, meta]);
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
