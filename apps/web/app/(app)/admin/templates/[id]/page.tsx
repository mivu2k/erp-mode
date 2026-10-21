'use client';
import { Button, Card, ErrorBox, humanize, Label, PageHeader, Select, Textarea } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, openDoc } from '@/lib/api';
import { useMeta } from '@/lib/meta';

interface Tpl { kind: string; key: string; subject?: string | null; body: string }
const STARTER = `<h2>{{company}}</h2>\n<!-- click a field on the right to insert it here -->\n<div>{{{qr}}}</div>`;

/**
 * A custom print layout for one kind of document. Pick the document, write HTML, click a field to insert it;
 * Preview prints the latest record with it. Without a template the standard layout is used.
 */
export default function Template() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const meta = useMeta();
  const docs = meta.resources.filter((r) => r.printable);
  const [t, setT] = useState<Tpl | null>(isNew ? { kind: 'print', key: docs[0]?.key ?? '', body: STARTER } : null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!isNew) api<Tpl>(`r/core.template/${id}`).then(setT).catch(setError); }, [id, isNew]);
  if (!t) return <ErrorBox error={error} />;
  const res = meta.resources.find((r) => r.key === t.key);
  const insert = (v: string) => {
    const el = box.current; const at = el?.selectionStart ?? t.body.length;
    setT({ ...t, body: t.body.slice(0, at) + v + t.body.slice(el?.selectionEnd ?? at) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + v.length, at + v.length); });
  };
  const save = async () => {
    setError(null); setSaved(false);
    try {
      if (isNew) { const r = await api<{ id: string }>('r/core.template', 'POST', { ...t, kind: 'print' }); router.replace(`/admin/templates/${r.id}`); } else { await api(`r/core.template/${id}`, 'PATCH', t); setSaved(true); }
    } catch (e) { setError(e); }
  };
  const preview = async () => {
    try {
      const d = await api<{ rows: { id: string }[] }>(`r/${t.key}?pageSize=1&sort=createdAt:desc`);
      if (!d.rows[0]) throw new Error(`No ${res?.label ?? 'record'} yet to preview with`);
      await openDoc(`print/${t.key}/${d.rows[0].id}`);
    } catch (e) { setError(e); }
  };

  return (
    <>
      <nav className="mb-2 text-xs text-muted-foreground"><Link className="hover:underline" href="/r/core.template">Templates</Link></nav>
      <PageHeader title={isNew ? 'New print layout' : `Print layout — ${res?.label ?? t.key}`}
        actions={<><Button onClick={save}>{isNew ? 'Create' : 'Save'}</Button>{!isNew && <Button variant="outline" onClick={preview}>Preview with latest</Button>}{saved && <span role="status" className="self-center text-xs" style={{ color: 'var(--tone-green)' }}>Saved</span>}</>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <div className="space-y-3 text-sm">
            <div><Label htmlFor="d">Document</Label>
              <Select id="d" value={t.key} onChange={(e) => setT({ ...t, key: e.target.value })}>{docs.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select>
              <p className="mt-1 text-xs text-muted-foreground">This layout replaces the standard print of every {res?.label.toLowerCase() ?? 'record'}. Delete it to go back to the standard one.</p></div>
            <div><Label htmlFor="b">Layout (HTML)</Label><Textarea id="b" ref={box} rows={18} className="font-mono text-xs" value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} /></div>
          </div>
        </Card>
        <Card title="Insert a field">
          <p className="mb-2 text-xs text-muted-foreground">Click to insert at the cursor.</p>
          <div className="flex flex-wrap gap-1.5">
            {[['company', 'Company name'], ['qr', 'QR code']].map(([k, l]) => <button key={k} type="button" className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => insert(k === 'qr' ? '{{{qr}}}' : `{{${k}}}`)}>{l}</button>)}
            {res?.fields.filter((f) => f.type !== 'json').map((f) => <button key={f.name} type="button" className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => insert(`{{${f.name}}}`)}>{f.label ?? humanize(f.name.replace(/Id$/, ''))}</button>)}
          </div>
        </Card>
      </div>
    </>
  );
}
