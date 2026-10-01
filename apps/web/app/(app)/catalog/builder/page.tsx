'use client';
import { Button, Card, cx, EmptyState, ErrorBox, Input, Label, PageHeader, Select, Switch, Tabs, Textarea } from '@erp/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { AuthImage } from '@/lib/FilePanel';
import { can, useMeta } from '@/lib/meta';

interface Pick { ref: string; name: string; sub: string; image?: string }
type Row = Record<string, unknown> & { id: string };

/** Pick any mix of catalog items and inventory products, order them, and generate one brochure or deck. */
function Builder() {
  const meta = useMeta();
  const params = useSearchParams();
  const [source, setSource] = useState('catalog');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Pick[]>([]);
  const [picked, setPicked] = useState<Pick[]>([]);
  const [opts, setOpts] = useState({ title: '', subtitle: '', theme: 'editorial', perPage: '1', prices: 'item', about: '1', locations: '1', compare: '1', custom: '1', intro: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');

  // Items pre-selected from the catalog list (?items=c:id,c:id)
  useEffect(() => {
    const pre = params.get('items');
    if (!pre) return;
    Promise.all(pre.split(',').map(async (ref) => {
      const [t, id] = ref.split(':');
      const r = await api<Row>(`r/${t === 'p' ? 'inventory.product' : 'catalog.item'}/${id}`).catch(() => null);
      return r ? toPick(t === 'p' ? 'p' : 'c', r) : null;
    })).then((xs) => setPicked(xs.filter((x): x is Pick => !!x)));
  }, [params]);

  useEffect(() => {
    const key = source === 'catalog' ? 'catalog.item' : 'inventory.product';
    const t = setTimeout(() => {
      api<{ rows: Row[] }>(`r/${key}?${qs({ search: q, pageSize: 30, sort: 'name:asc' })}`)
        .then((d) => setResults(d.rows.map((r) => toPick(source === 'catalog' ? 'c' : 'p', r)))).catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [q, source]);

  const has = (ref: string) => picked.some((p) => p.ref === ref);
  const toggle = (p: Pick) => setPicked((xs) => (xs.some((x) => x.ref === p.ref) ? xs.filter((x) => x.ref !== p.ref) : [...xs, p]));
  const move = (i: number, d: number) => setPicked((xs) => { const n = [...xs]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const generate = async (kind: 'preview' | 'pdf' | 'pptx') => {
    setBusy(kind); setError(null);
    const query = qs({ items: picked.map((p) => p.ref).join(','), ...opts, format: kind === 'pdf' ? 'pdf' : undefined });
    try { await openDoc(`catalog/${kind === 'pptx' ? 'presentation' : 'brochure'}?${query}`); } catch (e) { setError(e); } finally { setBusy(''); }
  };

  return (
    <>
      <PageHeader title="Brochure & presentation builder" subtitle="Pick catalog items and products, order them, then generate a brochure or a PowerPoint" />
      <ErrorBox error={error} />
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_24rem]">
        <Card>
          <Tabs value={source} onChange={setSource} tabs={[{ key: 'catalog', label: 'Catalog items' }, ...(can(meta, 'inventory.product.view') ? [{ key: 'products', label: 'Inventory products' }] : [])]} />
          <Input aria-label="Search" placeholder="Search by name, code, category…" value={q} onChange={(e) => setQ(e.target.value)} />
          {!results.length ? <EmptyState title="Nothing found" /> : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {results.map((r) => (
                <li key={r.ref}>
                  <button onClick={() => toggle(r)} aria-pressed={has(r.ref)}
                    className={cx('flex w-full items-center gap-3 rounded-xl border p-2.5 text-start transition', has(r.ref) ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50')}>
                    <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-muted">{r.image && <AuthImage id={r.image} alt="" className="h-full w-full object-cover" />}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.name}</span><span className="block truncate text-xs text-muted-foreground">{r.sub}</span></span>
                    <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs', has(r.ref) ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>{has(r.ref) ? '✓' : '+'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-4 lg:sticky lg:top-20">
          <Card title={`Selected (${picked.length})`}>
            {!picked.length ? <EmptyState title="Nothing selected yet" hint="Pick items on the left. The order here is the order in the brochure and deck." /> : (
              <ol className="space-y-1.5">
                {picked.map((p, i) => (
                  <li key={p.ref} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-sm">
                    <span className="w-5 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{p.name}<span className="ms-1.5 text-[10px] uppercase text-muted-foreground">{p.ref.startsWith('p:') ? 'product' : 'catalog'}</span></span>
                    <button aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="px-1 disabled:opacity-30">↑</button>
                    <button aria-label={`Move ${p.name} down`} disabled={i === picked.length - 1} onClick={() => move(i, 1)} className="px-1 disabled:opacity-30">↓</button>
                    <button aria-label={`Remove ${p.name}`} onClick={() => toggle(p)} className="px-1">✕</button>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Options">
            <div className="space-y-3">
              <div><Label htmlFor="t">Cover title</Label><Input id="t" placeholder={picked.length > 1 ? 'Products & Solutions' : picked[0]?.name ?? ''} value={opts.title} onChange={(e) => setOpts({ ...opts, title: e.target.value })} /></div>
              <div><Label htmlFor="st">Subtitle</Label><Input id="st" placeholder="e.g. Prepared for Signals Directorate" value={opts.subtitle} onChange={(e) => setOpts({ ...opts, subtitle: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label htmlFor="th">Style</Label><Select id="th" value={opts.theme} onChange={(e) => setOpts({ ...opts, theme: e.target.value })}><option value="editorial">Editorial (minimal, landscape)</option><option value="modern">Modern (dark)</option><option value="light">Clean (light)</option></Select></div>
                <div><Label htmlFor="pp">Products per page</Label><Select id="pp" value={opts.perPage} onChange={(e) => setOpts({ ...opts, perPage: e.target.value })}><option value="1">1 — full page each</option><option value="2">2 — cards</option><option value="3">3 — compact cards</option></Select></div>
                <div><Label htmlFor="pr">Prices</Label><Select id="pr" value={opts.prices} onChange={(e) => setOpts({ ...opts, prices: e.target.value })}><option value="item">As set per item</option><option value="show">Show all</option><option value="hide">Hide all</option></Select></div>
              </div>
              <div className="space-y-2 rounded-lg bg-muted/50 p-3">
                <Switch checked={opts.about === '1'} onChange={(c) => setOpts({ ...opts, about: c ? '1' : '0' })} label="Include “About us”" />
                <Switch checked={opts.locations === '1'} onChange={(c) => setOpts({ ...opts, locations: c ? '1' : '0' })} label="Include “Our locations”" />
                <Switch checked={opts.compare === '1'} onChange={(c) => setOpts({ ...opts, compare: c ? '1' : '0' })} label="Include comparison at the end (2+ items)" />
                <Switch checked={opts.custom === '1'} onChange={(c) => setOpts({ ...opts, custom: c ? '1' : '0' })} label="Custom HTML page & styling (from Company profile)" />
                {opts.about === '1' && (
                  <div>
                    <Label htmlFor="intro">Introduction for this document (optional)</Label>
                    <Textarea id="intro" rows={3} placeholder="Leave empty to use the company profile introduction" value={opts.intro} onChange={(e) => setOpts({ ...opts, intro: e.target.value })} />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Edit the standard text in <Link className="text-primary hover:underline" href="/catalog/profile">Company profile</Link>.</p>
              </div>
              <div className="grid gap-2 pt-1">
                <Button disabled={!picked.length || !!busy} onClick={() => generate('pdf')}>{busy === 'pdf' ? 'Building PDF…' : 'Brochure (PDF)'}</Button>
                <Button variant="outline" disabled={!picked.length || !!busy} onClick={() => generate('pptx')}>{busy === 'pptx' ? 'Building deck…' : 'Presentation (PowerPoint)'}</Button>
                <Button variant="ghost" disabled={!picked.length || !!busy} onClick={() => generate('preview')}>Preview brochure</Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function toPick(t: 'c' | 'p', r: Row): Pick {
  const refs = (r._refs ?? {}) as Record<string, string | null>;
  const images = Array.isArray(r.images) ? (r.images as string[]) : [];
  return t === 'c'
    ? { ref: `c:${r.id}`, name: String(r.name), sub: [r.kind, r.category, r.tagline].filter(Boolean).join(' · '), image: images[0] }
    : { ref: `p:${r.id}`, name: String(r.name), sub: [r.sku, r.brand, r.model, refs.categoryId].filter(Boolean).join(' · '), image: images[0] };
}

export default function Page() {
  return <Suspense><Builder /></Suspense>;
}
