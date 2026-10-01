'use client';
import { Button, Card, cx, Dialog, EmptyState, ErrorBox, FieldMeta } from '@erp/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, openDoc, qs, raw } from './api';
import { Attachment, fileUrl, fmtSize, isImage, prepareImage, uploadFile } from './files';
import { useMeta } from './meta';

/** <img> for a protected attachment. */
export function AuthImage({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { fileUrl(id).then(setSrc).catch(() => setSrc(null)); }, [id]);
  return src ? <img src={src} alt={alt} className={className} loading="lazy" /> : <div className={cx('animate-pulse bg-muted', className)} />;
}

const ext = (name: string) => (name.split('.').pop() ?? '').slice(0, 4).toUpperCase();

/** Client-side check against Settings › files, so users hear about limits before waiting for an upload. */
function useLimits() {
  const { files } = useMeta();
  return (f: File) => {
    if (f.size > files.maxMb * 1024 * 1024) return `${f.name}: larger than ${files.maxMb} MB`;
    if (f.type && !files.types.some((t) => f.type.startsWith(t))) return `${f.name}: file type not allowed`;
    return null;
  };
}

interface Upload { key: number; name: string; pct: number; error?: string }
let seq = 0;

/** Upload + progress for a batch; images are shrunk first. */
function useUploader(entityType: string, entityId: string | null, onDone: (a: Attachment) => void) {
  const [queue, setQueue] = useState<Upload[]>([]);
  const check = useLimits();
  const add = useCallback(async (files: File[]) => {
    if (!entityId) return;
    for (const original of files) {
      const key = ++seq;
      const problem = check(original);
      setQueue((q) => [...q, { key, name: original.name || 'pasted image', pct: 0, error: problem ?? undefined }]);
      if (problem) continue;
      const set = (patch: Partial<Upload>) => setQueue((q) => q.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      try {
        const att = await uploadFile(entityType, entityId, await prepareImage(original), (pct) => set({ pct }));
        setQueue((q) => q.filter((x) => x.key !== key));
        onDone(att);
      } catch (e) {
        set({ error: `${original.name || 'file'}: ${(e as Error).message}` });
      }
    }
  }, [entityType, entityId, onDone, check]);
  return { queue, add, clearErrors: () => setQueue((q) => q.filter((x) => !x.error)) };
}

/** Attachments tab: drag & drop, paste, camera, progress, gallery with preview. */
export function Attachments({ entityType, entityId, canUpload }: { entityType: string; entityId: string; canUpload: boolean }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const load = useCallback(() => { api<Attachment[]>(`attachments?${qs({ entityType, entityId })}`).then(setItems).catch(setError); }, [entityType, entityId]);
  useEffect(load, [load]);
  const { queue, add, clearErrors } = useUploader(entityType, entityId, useCallback((a: Attachment) => setItems((xs) => [a, ...xs]), []));

  // Paste screenshots / photos straight from the clipboard.
  useEffect(() => {
    if (!canUpload) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) { e.preventDefault(); add(files); }
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  }, [add, canUpload]);

  const remove = async (a: Attachment) => {
    if (!confirm(`Delete ${a.fileName}?`)) return;
    try { await raw(`attachments/${a.id}`, { method: 'DELETE' }); setItems((xs) => xs.filter((x) => x.id !== a.id)); } catch (e) { setError(e); }
  };

  const current = preview !== null ? items[preview] : null;
  return (
    <Card title={`Attachments${items.length ? ` (${items.length})` : ''}`}>
      <ErrorBox error={error} />
      {canUpload && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(Array.from(e.dataTransfer.files)); }}
          className={cx('mb-4 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition', drag ? 'border-primary bg-primary/10' : 'border-border')}>
          <p className="text-sm">Drop files here, paste a screenshot, or</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => input.current?.click()}>Browse files</Button>
            <Button size="sm" variant="outline" onClick={() => camera.current?.click()}>Take photo</Button>
          </div>
          <p className="text-xs text-muted-foreground">Photos are resized automatically · images, PDF, Office, CSV</p>
          <input ref={input} type="file" multiple className="sr-only" aria-label="Choose files" onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take photo" onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>
      )}
      {queue.length > 0 && (
        <ul className="mb-4 space-y-2">
          {queue.map((u) => (
            <li key={u.key} className="text-sm">
              {u.error ? (
                <div className="flex items-center justify-between gap-2" style={{ color: 'var(--tone-red)' }}><span>{u.error}</span><Button size="sm" variant="ghost" onClick={clearErrors}>Dismiss</Button></div>
              ) : (
                <>
                  <div className="flex justify-between"><span className="truncate">{u.name}</span><span className="tabular-nums text-muted-foreground">{u.pct}%</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={u.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.name}`}>
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${u.pct}%` }} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!items.length && !queue.length ? <EmptyState title="No files yet" /> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((a, i) => (
            <li key={a.id} className="group overflow-hidden rounded-xl border border-border bg-card">
              <button className="block aspect-[4/3] w-full bg-muted" onClick={() => setPreview(i)} aria-label={`Preview ${a.fileName}`}>
                {isImage(a.mimeType)
                  ? <AuthImage id={a.id} alt={a.fileName} className="h-full w-full object-cover" />
                  : <span className="grid h-full place-items-center"><span className="rounded-md bg-card px-2 py-1 text-xs font-semibold text-muted-foreground">{a.mimeType === 'application/pdf' ? 'PDF' : ext(a.fileName)}</span></span>}
              </button>
              <div className="flex items-center justify-between gap-1 px-2.5 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium" title={a.fileName}>{a.fileName}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtSize(a.size)} · {new Date(a.createdAt).toLocaleDateString()}</div>
                </div>
                <div className="flex shrink-0">
                  <Button size="sm" variant="ghost" aria-label={`Download ${a.fileName}`} onClick={() => openDoc(`attachments/${a.id}/file?download=1`)}>↓</Button>
                  {canUpload && <Button size="sm" variant="ghost" aria-label={`Delete ${a.fileName}`} onClick={() => remove(a)}>✕</Button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {current && (
        <Dialog open wide onClose={() => setPreview(null)} title={current.fileName}
          footer={<>
            <Button variant="ghost" disabled={preview === 0} onClick={() => setPreview((p) => (p ?? 1) - 1)}>‹ Prev</Button>
            <Button variant="ghost" disabled={preview === items.length - 1} onClick={() => setPreview((p) => (p ?? 0) + 1)}>Next ›</Button>
            <Button onClick={() => openDoc(`attachments/${current.id}/file?download=1`)}>Download</Button>
          </>}>
          <Preview a={current} />
        </Dialog>
      )}
    </Card>
  );
}

function Preview({ a }: { a: Attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { setSrc(null); if (isImage(a.mimeType) || a.mimeType === 'application/pdf') fileUrl(a.id).then(setSrc); }, [a]);
  if (isImage(a.mimeType)) return src ? <img src={src} alt={a.fileName} className="mx-auto max-h-[70vh] rounded-lg" /> : <div className="h-64 animate-pulse rounded bg-muted" />;
  if (a.mimeType === 'application/pdf') return src ? <iframe src={src} title={a.fileName} className="h-[70vh] w-full rounded-lg bg-white" /> : <div className="h-64 animate-pulse rounded bg-muted" />;
  return <EmptyState title="No preview for this file type" hint={`${fmtSize(a.size)} · use Download`} />;
}

/** Single-file field (employee photo, receipt, gate photo): stores the attachment id on the record. */
export function FileField({ f, value, onChange, entityType, entityId }: { f: FieldMeta; value: unknown; onChange(v: unknown): void; entityType: string; entityId: string | null }) {
  const [meta, setMeta] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const check = useLimits();
  const imageOnly = f.name === 'photo' || f.name === 'photoId' || f.name === 'signature';
  useEffect(() => {
    if (!value) return setMeta(null);
    api<Attachment[]>(`attachments?${qs({ entityType, entityId })}`).then((xs) => setMeta(xs.find((x) => x.id === value) ?? null)).catch(() => {});
  }, [value, entityType, entityId]);

  const pick = async (file?: File) => {
    if (!file || !entityId) return;
    const problem = check(file) ?? (imageOnly && !file.type.startsWith('image/') ? 'Please choose an image' : null);
    if (problem) return setError(problem);
    setError(null);
    setPct(0);
    try {
      const att = await uploadFile(entityType, entityId, await prepareImage(file), setPct);
      setMeta(att);
      onChange(att.id);
    } catch (e) { setError((e as Error).message); } finally { setPct(null); }
  };

  if (!entityId) return <p className="flex h-10 items-center rounded-[var(--radius)] border border-dashed border-border px-3 text-xs text-muted-foreground">Save the record first, then attach.</p>;
  return (
    <div>
      <div className="flex items-center gap-3">
        {!!value && meta && isImage(meta.mimeType)
          ? <AuthImage id={String(value)} alt={f.label ?? f.name} className="h-14 w-14 rounded-lg object-cover" />
          : !!value ? <span className="grid h-14 w-14 place-items-center rounded-lg bg-muted text-xs font-semibold">{meta ? ext(meta.fileName) : '…'}</span> : null}
        <div className="flex flex-wrap gap-2">
          {!f.readonly && <Button size="sm" variant="outline" type="button" onClick={() => input.current?.click()} disabled={pct !== null}>{pct !== null ? `Uploading ${pct}%` : value ? 'Replace' : 'Upload'}</Button>}
          {!!value && meta && <Button size="sm" variant="ghost" type="button" onClick={() => openDoc(`attachments/${value}/file`)}>View</Button>}
          {!!value && !f.readonly && <Button size="sm" variant="ghost" type="button" onClick={() => onChange(null)}>Remove</Button>}
        </div>
      </div>
      <input ref={input} type="file" className="sr-only" aria-label={f.label ?? f.name} accept={imageOnly ? 'image/*' : undefined} capture={imageOnly ? 'environment' : undefined}
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {error && <p className="mt-1 text-xs" style={{ color: 'var(--tone-red)' }}>{error}</p>}
    </div>
  );
}

/** Image gallery field (e.g. product images): stores a list of attachment ids; the first one is the main image. */
export function FilesField({ f, value, onChange, entityType, entityId }: { f: FieldMeta; value: unknown; onChange(v: unknown): void; entityType: string; entityId: string | null }) {
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const input = useRef<HTMLInputElement>(null);
  const { queue, add, clearErrors } = useUploader(entityType, entityId, useCallback((a: Attachment) => onChange([...(idsRef.current ?? []), a.id]), [onChange]));
  const idsRef = useRef(ids);
  idsRef.current = ids;
  if (!entityId) return <p className="flex h-10 items-center rounded-[var(--radius)] border border-dashed border-border px-3 text-xs text-muted-foreground">Save the record first, then add images.</p>;
  const move = (i: number, to: number) => { const next = [...ids]; const [x] = next.splice(i, 1); next.splice(to, 0, x); onChange(next); };
  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {ids.map((id, i) => (
          <li key={id} className="group relative h-24 w-24 overflow-hidden rounded-lg border border-border">
            <AuthImage id={id} alt={`${f.label ?? f.name} ${i + 1}`} className="h-full w-full object-cover" />
            {i === 0 && <span className="absolute start-1 top-1 rounded bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">Main</span>}
            {!f.readonly && (
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/60 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                <button type="button" className="px-2 py-1 text-xs text-white disabled:opacity-30" disabled={i === 0} onClick={() => move(i, 0)} aria-label={`Make image ${i + 1} the main image`}>★</button>
                <button type="button" className="px-2 py-1 text-xs text-white" onClick={() => onChange(ids.filter((x) => x !== id))} aria-label={`Remove image ${i + 1}`}>✕</button>
              </div>
            )}
          </li>
        ))}
        {!f.readonly && ids.length < 20 && (
          <li>
            <button type="button" onClick={() => input.current?.click()} className="grid h-24 w-24 place-items-center rounded-lg border-2 border-dashed border-border text-2xl text-muted-foreground transition hover:border-primary hover:text-primary" aria-label={`Add ${f.label ?? f.name}`}>+</button>
          </li>
        )}
      </ul>
      <input ref={input} type="file" multiple accept="image/*" className="sr-only" aria-label={`Upload ${f.label ?? f.name}`} onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      {queue.map((u) => (
        <p key={u.key} className="mt-1 text-xs" style={u.error ? { color: 'var(--tone-red)' } : undefined}>
          {u.error ?? `Uploading ${u.name} ${u.pct}%`}{u.error && <button type="button" className="ms-2 underline" onClick={clearErrors}>dismiss</button>}
        </p>
      ))}
    </div>
  );
}

/**
 * Logo picker for branding: the image is shrunk (max 512px) and stored inline as a data URL,
 * so it shows in the sidebar, on the login page, on every print and in server-made PDFs.
 */
export function LogoField({ label, value, onChange }: { label: string; value?: string; onChange(v: string | null): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Use a PNG, JPEG or WebP image (PNG keeps transparency)');
    setError(null);
    const small = await prepareImage(file, 512);
    const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(small); });
    if (url.length > 550_000) return setError('Image is still too large after resizing — try a simpler logo');
    onChange(url);
  };
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-foreground/80">{label}</div>
      <div className="flex items-center gap-3">
        <div className="grid h-16 w-40 place-items-center overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
          {value ? <img src={value} alt={label} className="max-h-14 max-w-36 object-contain" /> : <span className="text-xs text-muted-foreground">No logo</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" variant="outline" type="button" onClick={() => input.current?.click()}>{value ? 'Replace' : 'Upload'}</Button>
          {value && <Button size="sm" variant="ghost" type="button" onClick={() => onChange(null)}>Remove</Button>}
        </div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label={`Upload ${label}`} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {error && <p className="mt-1 text-xs" style={{ color: 'var(--tone-red)' }}>{error}</p>}
    </div>
  );
}
