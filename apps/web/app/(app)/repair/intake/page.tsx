'use client';
import { Button, Card, cx, ErrorBox, FieldMeta, FormGrid, Input, Label, PageHeader, Switch, Textarea } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { prepareImage, uploadFile } from '@/lib/files';
import { intakeProblems, type Item } from '@/lib/intake';
import { renderRef } from '@/lib/RefPicker';

interface Md { id: string; code: string; name: string }
interface Result { intake: { id: string; number: string }; jobs: { id: string; number: string; trackUrl: string }[] }
/** What the serial register / past jobs know about a unit. */
interface Known { state: 'loading' | 'new' | 'known'; warranty?: string; repairs?: number; label?: string }

const idFields: FieldMeta[] = [
  { name: 'brand', type: 'string', label: 'Make' }, { name: 'model', type: 'string', label: 'Model' },
  { name: 'assetTag', type: 'string', label: 'Asset tag / unit no.' },
  { name: 'firmwareVersion', type: 'string', label: 'Firmware version' }, { name: 'frequencyBand', type: 'string', label: 'Frequency band' },
];
const DRAFT = 'repair.intake.draft';
const blank = (): Item => ({ accessories: [] });
const unitLabel = (it: Item) => [it.brand, it.model].filter(Boolean).join(' ') || String(it.productType ?? '');

/** Workshop intake for radios, cameras, gateways and other comms hardware: one job per unit. */
export default function IntakePage() {
  const [customerId, setCustomerId] = useState<unknown>(null);
  const [newCust, setNewCust] = useState<{ name: string; phone: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Item[]>([blank()]);
  const [known, setKnown] = useState<Record<number, Known>>({});
  const [md, setMd] = useState<Record<string, Md[]>>({});
  const [seen, setSeen] = useState<{ makes: string[]; models: { make: string; model: string }[] }>({ makes: [], models: [] });
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // One request, readable by technicians too (they can't browse master data).
    api<Record<string, Md[]> & { makes: string[]; models: { make: string; model: string }[] }>('repair/intake-options')
      .then(({ makes, models, ...lists }) => { setMd(lists); setSeen({ makes, models }); }).catch(setError);
    // Restore an unfinished intake (photos can't be kept across reloads).
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null');
      if (d?.items?.length) { setCustomerId(d.customerId); setNotes(d.notes ?? ''); setItems(d.items); }
    } catch { /* no draft */ }
    setLoaded(true); // save only after the restored draft is in state
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(DRAFT, JSON.stringify({ customerId, notes, items: items.map(({ photos: _p, password: _pw, ...i }) => i) })); } catch { /* storage off */ }
  }, [loaded, customerId, notes, items]);

  const set = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const reset = () => { setItems([blank()]); setCustomerId(null); setNotes(''); setKnown({}); setTried(false); try { localStorage.removeItem(DRAFT); } catch { /* ignore */ } };

  /** Serial entered: fill blanks from the serial register and show warranty / repair history. */
  /** Serial / asset tag entered: a unit seen before (earlier job, serial register, inventory product) fills every blank field. */
  const lookupSerial = async (i: number, serial: string) => {
    if (!serial.trim()) return setKnown((k) => ({ ...k, [i]: undefined as unknown as Known }));
    setKnown((k) => ({ ...k, [i]: { state: 'loading' } }));
    try {
      type Found = { found: boolean; kind?: 'product'; repairs?: number; label?: string | null; warrantyUntil?: string | null; customer?: { id: string; name: string } | null; unit?: Record<string, unknown> };
      const r = await api<Found>(`repair/intake-lookup?${qs({ serial: serial.trim() })}`);
      if (!r.found || !r.unit) return setKnown((k) => ({ ...k, [i]: { state: 'new' } }));
      const inWarranty = !!r.warrantyUntil && String(r.warrantyUntil).slice(0, 10) >= new Date().toISOString().slice(0, 10);
      // Only blanks are filled: what the counter already typed wins.
      setItems((xs) => xs.map((x, j) => (j !== i ? x : {
        ...x,
        ...Object.fromEntries(Object.entries(r.unit!).filter(([key, v]) => key !== 'accessories' && v && !String(x[key as keyof Item] ?? '').trim())),
        accessories: x.accessories?.length ? x.accessories : (r.unit!.accessories as string[]),
        warranty: x.warranty || inWarranty,
        // A product barcode names the model, not this unit: don't keep it as the unit's serial.
        ...(r.kind === 'product' && String(x.serial ?? '').trim() === serial.trim() ? { serial: '' } : {}),
      })));
      if (!customerId && r.customer) setCustomerId(r.customer.id);
      setKnown((k) => ({ ...k, [i]: { state: 'known', warranty: !r.warrantyUntil ? 'none' : inWarranty ? 'active' : 'expired', repairs: r.repairs, label: [r.kind === 'product' ? `product barcode: ${r.label} — now enter the unit's own serial` : r.label, r.customer && `owner: ${r.customer.name}`].filter(Boolean).join(' · ') } }));
    } catch { setKnown((k) => ({ ...k, [i]: { state: 'new' } })); }
  };

  const problems = intakeProblems(customerId, items);
  const show = (k: string) => (tried ? problems[k] : undefined);

  const submit = async () => {
    setTried(true);
    setError(null);
    if (Object.keys(problems).length) {
      document.getElementById(Object.keys(problems)[0])?.focus();
      return;
    }
    setBusy(true);
    try {
      const body = { customerId, notes, items: items.map(({ conditionNotes, photos: _p, ...i }) => ({ ...i, condition: conditionNotes ? { notes: conditionNotes } : undefined })) };
      const res = await api<Result>('repair/intakes', 'POST', body);
      // Condition photos go onto each unit's own job (jobs come back in the same order as the units).
      const failed: string[] = [];
      for (const [i, job] of res.jobs.entries()) {
        for (const { file: photo } of items[i].photos ?? []) {
          await uploadFile('repair.job', job.id, await prepareImage(photo)).catch(() => failed.push(`${job.number}: ${photo.name}`));
        }
      }
      setDone(res);
      try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
      if (failed.length) setError(`Jobs created, but some photos failed to upload: ${failed.join(', ')}. Add them from the job's Attachments tab.`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (done) return (
    <>
      <div className="mb-3"><ErrorBox error={error} /></div>
      <PageHeader title={`Intake ${done.intake.number}`} subtitle={`${done.jobs.length} unit(s) received`}
        actions={<>
          {/* One combined receipt listing every unit handed in (not one tab per unit). */}
          <Button variant="outline" onClick={() => openDoc(`print/repair.intake/${done.intake.id}`).catch(setError)}>Intake receipt (A4)</Button>
          <Button variant="outline" onClick={() => openDoc(`print/repair.intake/${done.intake.id}?size=a5`).catch(setError)}>A5</Button>
          <Button variant="outline" onClick={() => openDoc(`print/repair.intake/${done.intake.id}?size=80`).catch(setError)}>POS slip</Button>
          <Button onClick={() => { setDone(null); reset(); }}>New intake</Button>
        </>} />
      <Card title="Jobs created">
        <ul className="divide-y divide-border text-sm">
          {done.jobs.map((j, i) => (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span><Link className="font-medium text-primary hover:underline" href={`/r/repair.job/${j.id}`}>{j.number}</Link> <span className="text-muted-foreground">{unitLabel(items[i] ?? {})}</span></span>
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${j.id}`)}>Job card</Button>
                <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${j.id}?size=80`)}>Job slip (80mm)</Button>
                <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${j.id}?template=label`)}>Unit tag</Button>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Each receipt carries a QR code to the customer&apos;s tracking page.</p>
      </Card>
    </>
  );

  const Err = ({ k }: { k: string }) => (show(k) ? <p className="mt-1 text-xs text-danger" role="alert">{show(k)}</p> : null);

  return (
    <div className="pb-24">
      <PageHeader title="Equipment intake" subtitle="Radios, cameras, gateways and other comms hardware — one job per unit"
        actions={<Button variant="ghost" onClick={reset}>Clear form</Button>} />
      <div className="mb-4"><ErrorBox error={error} /></div>

      <Card className="mb-4" title={<span><Step n={1} />Customer</span>}>
        <div id="customer" tabIndex={-1}>
          <FormGrid fields={[{ name: 'customerId', type: 'string', ref: 'sales.customer', required: true, label: 'Customer / unit' }, { name: 'notes', type: 'text', label: 'Intake notes (work order, reference)' }]}
            values={{ customerId, notes }} renderRef={renderRef} onChange={(k, v) => (k === 'customerId' ? setCustomerId(v) : setNotes(String(v ?? '')))} />
        </div>
        <Err k="customer" />
        {!newCust ? (
          <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => setNewCust({ name: '', phone: '' })}>+ New customer (walk-in)</button>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border p-3">
            <div className="min-w-48 flex-1"><Label htmlFor="nc-name" required>Customer name</Label><Input id="nc-name" autoFocus value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} /></div>
            <div className="min-w-40"><Label htmlFor="nc-phone">Phone</Label><Input id="nc-phone" value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} /></div>
            <Button type="button" disabled={!newCust.name.trim()} onClick={() => api<{ id: string }>('r/sales.customer', 'POST', { name: newCust.name.trim(), phone: newCust.phone.trim() || undefined })
              .then((c) => { setCustomerId(c.id); setNewCust(null); }).catch(setError)}>Add & use</Button>
            <Button type="button" variant="ghost" onClick={() => setNewCust(null)}>Cancel</Button>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        {items.map((it, i) => {
          const k = known[i];
          return (
            <Card key={i} title={<span><Step n={i + 2} />Unit {i + 1}{unitLabel(it) ? <span className="font-normal text-muted-foreground"> — {unitLabel(it)}</span> : null}</span>}
              actions={<span className="flex gap-1">
                <Button variant="ghost" size="sm" title="Add another unit with the same type, make, model and accessories"
                  onClick={() => setItems([...items.slice(0, i + 1), { productType: it.productType, brand: it.brand, model: it.model, frequencyBand: it.frequencyBand, firmwareVersion: it.firmwareVersion, accessories: [...(it.accessories ?? [])], fault: it.fault }, ...items.slice(i + 1)])}>Duplicate</Button>
                {items.length > 1 && <Button variant="ghost" size="sm" onClick={() => { setItems(items.filter((_, j) => j !== i)); setKnown({}); }}>Remove</Button>}
              </span>}>
              <div className="space-y-5">
                <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Label htmlFor={`serial${i}`}>Serial number <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <Input id={`serial${i}`} value={String(it.serial ?? '')} placeholder="Scan or type, or leave blank — known units fill in automatically" className="font-mono"
                      onChange={(e) => set(i, { serial: e.target.value })} onBlur={(e) => lookupSerial(i, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); document.getElementById(`type${i}`)?.focus(); } }} />
                    <Err k={`serial${i}`} />
                    {k?.state === 'loading' && <p className="mt-1 text-xs text-muted-foreground">Checking serial…</p>}
                    {k?.state === 'new' && <p className="mt-1 text-xs text-muted-foreground">First time we see this serial.</p>}
                    {k?.state === 'known' && (
                      <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                        <Chip tone="blue">Known unit{k.label ? ` · ${k.label}` : ''}</Chip>
                        {k.warranty && k.warranty !== 'none' && <Chip tone={k.warranty === 'expired' ? 'red' : k.warranty === 'expiring' ? 'amber' : 'green'}>Warranty {k.warranty}</Chip>}
                        {!!k.repairs && <Chip tone="amber">{k.repairs} previous repair{k.repairs > 1 ? 's' : ''} — possible repeat fault</Chip>}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor={`type${i}`}>Equipment type</Label>
                    <Input id={`type${i}`} list={`types${i}`} value={String(it.productType ?? '')} placeholder="Pick or type a new one" onChange={(e) => set(i, { productType: e.target.value })} />
                    <datalist id={`types${i}`}>{(md.equipment_type ?? []).map((t) => <option key={t.id} value={t.name} />)}</datalist>
                  </div>
                  {idFields.map((f) => (
                    <div key={f.name}>
                      <Label htmlFor={`${f.name}${i}`}>{f.label}</Label>
                      <Input id={`${f.name}${i}`} list={f.name === 'brand' || f.name === 'model' ? `${f.name}s${i}` : undefined} value={String(it[f.name] ?? '')} placeholder={f.name === 'frequencyBand' ? 'e.g. VHF 136–174 MHz' : undefined} onChange={(e) => set(i, { [f.name]: e.target.value })} />
                    </div>
                  ))}
                  {/* Makes and models already seen on jobs; models narrow to the make typed (any make if none). */}
                  <datalist id={`brands${i}`}>{seen.makes.map((m) => <option key={m} value={m} />)}</datalist>
                  <datalist id={`models${i}`}>{[...new Set(seen.models.filter((x) => !it.brand || x.make.toLowerCase() === String(it.brand).trim().toLowerCase()).map((x) => x.model))].map((m) => <option key={m} value={m} />)}</datalist>
                </div>

                <div>
                  <Label htmlFor={`fault${i}`} required>Reported fault</Label>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(md.fault ?? []).map((f) => {
                      const on = String(it.fault ?? '').split('; ').includes(f.name);
                      return (
                        <button key={f.id} type="button" aria-pressed={on}
                          onClick={() => set(i, { fault: (on ? String(it.fault).split('; ').filter((x) => x !== f.name) : [String(it.fault ?? '').trim(), f.name].filter(Boolean)).join('; ') })}
                          className={cx('rounded-md border px-2 py-0.5 text-xs transition', on ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-primary hover:text-foreground')}>{on ? '✓' : '+'} {f.name}</button>
                      );
                    })}
                  </div>
                  <Textarea id={`fault${i}`} value={String(it.fault ?? '')} onChange={(e) => set(i, { fault: e.target.value })} placeholder="What does the customer report? When does it happen?"
                    className={cx(show(`fault${i}`) && 'border-danger')} />
                  <Err k={`fault${i}`} />
                </div>

                <div>
                  <Label>Accessories received <span className="font-normal text-muted-foreground">({it.accessories?.length ?? 0})</span></Label>
                  <div className="flex flex-wrap gap-2">
                    {(md.accessory ?? []).map((a) => {
                      const on = it.accessories?.includes(a.name);
                      return (
                        <button key={a.id} type="button" aria-pressed={on} onClick={() => set(i, { accessories: on ? it.accessories!.filter((x) => x !== a.name) : [...(it.accessories ?? []), a.name] })}
                          className={cx('rounded-full border px-3 py-1 text-sm transition', on ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-muted-foreground')}>
                          {on ? '✓ ' : ''}{a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <details className="group rounded-lg border border-border" open={!!(it.photos?.length || it.conditionNotes || it.password || it.expectedAt)}>
                  <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-foreground/80">Condition, photos &amp; more <span className="font-normal text-muted-foreground">(optional)</span></summary>
                  <div className="space-y-5 border-t border-border p-4">
                    <div>
                      <Label>Condition photos</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        {(it.photos ?? []).map((ph, n) => (
                          <div key={n} className="relative h-20 w-20 overflow-hidden rounded-lg border border-border">
                            <img src={ph.url} alt={`Unit ${i + 1} photo ${n + 1}`} className="h-full w-full object-cover" />
                            <button type="button" aria-label={`Remove photo ${n + 1}`} onClick={() => { URL.revokeObjectURL(ph.url); set(i, { photos: it.photos!.filter((_, j) => j !== n) }); }}
                              className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-[10px] text-white">✕</button>
                          </div>
                        ))}
                        <label className="grid h-20 w-20 cursor-pointer place-items-center rounded-lg border-2 border-dashed border-border text-center text-xs text-muted-foreground transition hover:border-primary hover:text-primary">
                          + Add photos
                          <input type="file" accept="image/*" capture="environment" multiple className="sr-only" aria-label={`Condition photos for unit ${i + 1}`}
                            onChange={(e) => { set(i, { photos: [...(it.photos ?? []), ...Array.from(e.target.files ?? []).map((file) => ({ file, url: URL.createObjectURL(file) }))] }); e.target.value = ''; }} />
                        </label>
                      </div>
                    </div>
                    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="sm:col-span-2 lg:col-span-3">
                        <Label htmlFor={`cond${i}`}>Physical condition</Label>
                        <Input id={`cond${i}`} value={String(it.conditionNotes ?? '')} onChange={(e) => set(i, { conditionNotes: e.target.value })} placeholder="Scratches, missing knobs, cracked housing, seal damage…" />
                      </div>
                      <div>
                        <Label htmlFor={`pw${i}`}>Device PIN / admin password</Label>
                        <Input id={`pw${i}`} type="password" autoComplete="off" value={String(it.password ?? '')} onChange={(e) => set(i, { password: e.target.value })} />
                        <p className="mt-1 text-xs text-muted-foreground">Stored encrypted; only managers can reveal it. Not kept in the draft.</p>
                      </div>
                      <div>
                        <Label htmlFor={`exp${i}`}>Expected ready</Label>
                        <Input id={`exp${i}`} type="date" value={String(it.expectedAt ?? '').slice(0, 10)} onChange={(e) => set(i, { expectedAt: e.target.value || undefined })} />
                        <span className="mt-1 flex gap-2 text-xs">
                          {[1, 3, 7].map((d) => <button key={d} type="button" className="text-primary hover:underline" onClick={() => set(i, { expectedAt: new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10) })}>+{d}d</button>)}
                        </span>
                      </div>
                    </div>
                  </div>
                </details>

                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  <Switch checked={!!it.warranty} onChange={(v) => set(i, { warranty: v })} label="Under warranty" />
                  <Switch checked={!!it.zeroized} onChange={(v) => set(i, { zeroized: v })} label="Crypto / COMSEC keys zeroized" />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      <button type="button" onClick={() => setItems([...items, blank()])}
        className="mt-4 w-full rounded-xl border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary hover:text-primary">+ Add another unit</button>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur lg:start-60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {items.length} unit{items.length > 1 ? 's' : ''} · {items.reduce((n, x) => n + (x.accessories?.length ?? 0), 0)} accessories · {items.reduce((n, x) => n + (x.photos?.length ?? 0), 0)} photos
            {tried && Object.keys(problems).length > 0 && <span className="ms-2 text-danger">· {Object.keys(problems).length} thing(s) to fix</span>}
          </span>
          <Button disabled={busy} onClick={submit}>{busy ? 'Receiving…' : `Receive ${items.length} unit${items.length > 1 ? 's' : ''}`}</Button>
        </div>
      </div>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return <span className="me-2 inline-grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{n}</span>;
}
function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className="rounded-full px-2 py-0.5 font-medium" style={{ color: `var(--tone-${tone})`, background: `var(--tone-${tone}-bg)` }}>{children}</span>;
}
