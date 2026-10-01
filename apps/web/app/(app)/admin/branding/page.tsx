'use client';
import { Button, Card, ErrorBox, FormGrid, PageHeader, StatusBadge } from '@erp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LogoField } from '@/lib/FilePanel';

interface Company { id: string; branding: Record<string, unknown> | null }

/** Branding drives the whole UI and every printed document. */
export default function Branding() {
  const qc = useQueryClient();
  const [company, setCompany] = useState<Company | null>(null);
  const [b, setB] = useState<Record<string, unknown>>({});
  const [msg, setMsg] = useState<unknown>(null);
  useEffect(() => { api<{ rows: Company[] }>('r/core.company').then((d) => { setCompany(d.rows[0]); setB(d.rows[0]?.branding ?? {}); }); }, []);
  const save = () => api(`r/core.company/${company!.id}`, 'PATCH', { branding: b }).then(() => { setMsg(null); qc.invalidateQueries({ queryKey: ['meta'] }); }).catch(setMsg);
  return (
    <>
      <PageHeader title="Branding & theme" actions={<Button onClick={save}>Save & apply</Button>} />
      <ErrorBox error={msg} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <FormGrid values={b} onChange={(k, v) => setB((s) => ({ ...s, [k]: v }))} fields={[
            { name: 'primary', type: 'string', label: 'Primary colour (hex)' }, { name: 'secondary', type: 'string', label: 'Secondary colour (hex)' },
            { name: 'font', type: 'string', label: 'Font family' }, { name: 'mode', type: 'enum', options: ['light', 'dark'], label: 'Default mode' },
            { name: 'density', type: 'enum', options: ['comfortable', 'compact'] },
            { name: 'footer', type: 'text', label: 'Document footer' }, { name: 'terms', type: 'text', label: 'Terms & conditions (printed)' },
          ]} />
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <LogoField label="Logo (light background)" value={b.logo as string | undefined} onChange={(v) => setB((s) => ({ ...s, logo: v }))} />
            <LogoField label="Logo (dark background)" value={b.logoDark as string | undefined} onChange={(v) => setB((s) => ({ ...s, logoDark: v }))} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Used in the sidebar and on every printed document and PDF. PNG with a transparent background works best.</p>
          {typeof b.primary === 'string' && <input type="color" aria-label="Pick primary colour" className="mt-3 h-9 w-16" value={String(b.primary)} onChange={(e) => setB({ ...b, primary: e.target.value })} />}
        </Card>
        <Card title="Preview">
          <div className="space-y-3" style={{ ['--primary' as string]: String(b.primary ?? '') || undefined }}>
            {!!b.logo && <div className="rounded-lg bg-white p-3"><img src={String(b.logo)} alt="Logo preview on light background" className="max-h-12" /></div>}
            {!!(b.logoDark || b.logo) && <div className="rounded-lg bg-[#050810] p-3"><img src={String(b.logoDark ?? b.logo)} alt="Logo preview on dark background" className="max-h-12" /></div>}
            <Button>Primary action</Button> <Button variant="outline">Secondary</Button>
            <div className="flex flex-wrap gap-2">{['draft', 'pending', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled', 'overdue'].map((s) => <StatusBadge key={s} status={s} />)}</div>
          </div>
        </Card>
      </div>
    </>
  );
}
