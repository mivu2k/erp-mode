'use client';
import { Button, Card, ErrorBox, Label, PageHeader, RichText, Textarea } from '@erp/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { prepareImage } from '@/lib/files';

interface About { intro: string; mission: string; highlights: string; certifications: string; locations: string; photo: string; customCss: string; customHtml: string }
const FIELDS: { key: keyof About; label: string; hint: string; rows: number }[] = [
  { key: 'intro', label: 'Introduction', hint: 'Who you are and what you do — the opening paragraph of every brochure and deck.', rows: 5 },
  { key: 'mission', label: 'Mission statement', hint: 'Shown as a quote.', rows: 2 },
  { key: 'highlights', label: 'Headline numbers', hint: 'One per line, "Label: value" — e.g. Founded: 2005 · Clients: 300+ · Engineers: 45 (first four shown).', rows: 4 },
  { key: 'certifications', label: 'Certifications & accreditations', hint: 'One per line — e.g. ISO 9001:2015.', rows: 3 },
  { key: 'locations', label: 'Locations', hint: 'One office per line: Name | address | phone | email. The first line is shown as headquarters.', rows: 5 },
];

/** Company introduction reused by every brochure and presentation. */
export default function CompanyProfile() {
  const [v, setV] = useState<About | null>(null);
  const [msg, setMsg] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  useEffect(() => { api<About>('catalog/about').then(setV).catch(setMsg); }, []);
  if (!v) return <ErrorBox error={msg} />;

  const pickPhoto = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setMsg('Use a PNG, JPEG or WebP photo');
    const small = await prepareImage(file, 1400);
    const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(small); });
    if (url.length > 1_200_000) return setMsg('Photo is too large even after resizing — try another one');
    setMsg(null);
    setV({ ...v, photo: url });
  };
  const save = async () => {
    try { await api('catalog/about', 'PUT', v); setSaved(true); setMsg(null); setTimeout(() => setSaved(false), 2500); } catch (e) { setMsg(e); }
  };

  return (
    <>
      <PageHeader title="Company profile" subtitle="Introduction, headline numbers and locations used in every brochure and presentation"
        actions={<Button onClick={save}>{saved ? 'Saved ✓' : 'Save'}</Button>} />
      <ErrorBox error={msg} />
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <div className="space-y-5">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <Label htmlFor={f.key}>{f.label}</Label>
                <Textarea id={f.key} rows={f.rows} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
                <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Company / office photo">
          <div className="aspect-[4/3] overflow-hidden rounded-lg bg-muted">
            {v.photo ? <img src={v.photo} alt="Company" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-xs text-muted-foreground">No photo</div>}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => photo.current?.click()}>{v.photo ? 'Replace' : 'Upload'}</Button>
            {v.photo && <Button size="sm" variant="ghost" onClick={() => setV({ ...v, photo: '' })}>Remove</Button>}
          </div>
          <input ref={photo} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload company photo" onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <p className="mt-2 text-xs text-muted-foreground">Used on the About page and slide. Resized automatically.</p>
        </Card>
      </div>
      <Card className="mt-4" title="Custom HTML & styling (brochure)">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div>
              <Label htmlFor="customHtml">Custom page (HTML)</Label>
              <RichText id="customHtml" value={v.customHtml ?? ''} onChange={(html) => setV({ ...v, customHtml: html })} minHeight={220} />
              <p className="mt-1 text-xs text-muted-foreground">Added as its own page before the back cover. Plain markup only — scripts, forms and frames are removed; images must be embedded (data: URLs).</p>
            </div>
            <div>
              <Label htmlFor="customCss">Custom CSS</Label>
              <Textarea id="customCss" rows={8} className="font-mono text-xs" value={v.customCss ?? ''} placeholder={'h2 { color: #0f766e; }\n.cover h1 { letter-spacing: -.02em; }\n.custom-body { columns: 2; }'} onChange={(e) => setV({ ...v, customCss: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">Applied to the whole brochure. Useful selectors: <code>.page .cover .about .locations .item .compare .back .custom-body h1 h2 h3</code>. Remote fonts/images are blocked.</p>
            </div>
          </div>
          <div>
            <Label>Preview</Label>
            {/* sandbox without allow-scripts: nothing in the preview can run */}
            <iframe title="Custom page preview" sandbox="" className="h-[28rem] w-full rounded-lg border border-border bg-white"
              srcDoc={`<style>body{font-family:system-ui,sans-serif;color:#0f172a;margin:0}.custom-body{padding:24px}${v.customCss ?? ''}</style><div class="page custom"><div class="custom-body">${v.customHtml ?? ''}</div></div>`} />
          </div>
        </div>
      </Card>
    </>
  );
}
