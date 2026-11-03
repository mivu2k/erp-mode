'use client';
import { Button, Card, ErrorBox, FormGrid, PageHeader, StatusBadge } from '@erp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LogoField } from '@/lib/FilePanel';
import { InlineList } from '@/lib/InlineList';

type Company = Record<string, unknown> & { id: string; branding: Record<string, unknown> | null };
const DETAILS = ['name', 'legalName', 'taxId', 'phone', 'email', 'website', 'address', 'currency', 'timezone'] as const;

/** The company in one place: who it is (details), how it looks (branding), and where it works (branches). */
export default function CompanyPage() {
  const qc = useQueryClient();
  const [company, setCompany] = useState<Company | null>(null);
  const [d, setD] = useState<Record<string, unknown>>({});
  const [b, setB] = useState<Record<string, unknown>>({});
  const [msg, setMsg] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<{ rows: Company[] }>('r/core.company').then((r) => {
      const c = r.rows[0];
      setCompany(c); setB(c?.branding ?? {});
      setD(Object.fromEntries(DETAILS.map((k) => [k, c?.[k] ?? ''])));
    }).catch(setMsg);
  }, []);
  const save = () => {
    setSaved(false);
    api(`r/core.company/${company!.id}`, 'PATCH', { ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '' ? null : v])), name: d.name, branding: b })
      .then(() => { setMsg(null); setSaved(true); qc.invalidateQueries({ queryKey: ['meta'] }); }).catch(setMsg);
  };

  return (
    <>
      <PageHeader title="Company" subtitle="Details, look and branches — printed on every document"
        actions={<>{saved && <span role="status" className="self-center text-xs" style={{ color: 'var(--tone-green)' }}>Saved</span>}<Button disabled={!company} onClick={save}>Save</Button></>} />
      <div className="mb-3"><ErrorBox error={msg} /></div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card title="Details">
          <FormGrid columns={2} values={d} onChange={(k, v) => setD((s) => ({ ...s, [k]: v }))} fields={[
            { name: 'name', type: 'string', label: 'Company name', required: true }, { name: 'legalName', type: 'string', label: 'Registered (legal) name' },
            { name: 'taxId', type: 'string', label: 'NTN / tax no.' }, { name: 'phone', type: 'string', label: 'Phone' },
            { name: 'email', type: 'string', label: 'Email' }, { name: 'website', type: 'string', label: 'Website' },
            { name: 'address', type: 'text', label: 'Address' },
            { name: 'currency', type: 'string', label: 'Currency (e.g. PKR)' }, { name: 'timezone', type: 'string', label: 'Time zone (e.g. Asia/Karachi)' },
          ]} />
        </Card>

        <Card title="Branding">
          <div className="grid gap-5 sm:grid-cols-2">
            <LogoField label="Logo (light background)" value={b.logo as string | undefined} onChange={(v) => setB((s) => ({ ...s, logo: v }))} />
            <LogoField label="Logo (dark background)" value={b.logoDark as string | undefined} onChange={(v) => setB((s) => ({ ...s, logoDark: v }))} />
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <label className="text-sm"><span className="mb-1 block text-xs text-muted-foreground">Brand colour</span>
              <span className="flex items-center gap-2"><input type="color" aria-label="Brand colour" className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent" value={String(b.primary || '#3b82f6')} onChange={(e) => setB({ ...b, primary: e.target.value })} /><code className="text-xs text-muted-foreground">{String(b.primary || '#3b82f6')}</code></span></label>
            <div className="flex-1" style={{ ['--primary' as string]: String(b.primary ?? '') || undefined }}>
              <span className="mb-1 block text-xs text-muted-foreground">Preview</span>
              <div className="flex flex-wrap items-center gap-2"><Button size="sm">Primary</Button><Button size="sm" variant="outline">Secondary</Button><StatusBadge status="approved" /><StatusBadge status="pending" /></div>
            </div>
          </div>
          <div className="mt-4">
            <FormGrid columns={2} values={b} onChange={(k, v) => setB((s) => ({ ...s, [k]: v }))} fields={[
              { name: 'mode', type: 'enum', options: ['light', 'dark'], label: 'Default look' }, { name: 'density', type: 'enum', options: ['comfortable', 'compact'], label: 'Density' },
              { name: 'footer', type: 'text', label: 'Footer on documents' }, { name: 'terms', type: 'text', label: 'Terms & conditions (printed)' },
            ]} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Logos appear in the sidebar and on every print and PDF. A PNG with a transparent background works best.</p>
        </Card>

        <div className="xl:col-span-2">
          <InlineList resource="core.branch" title="Branches" hint="Each branch numbers its own documents and keeps its own staff, stores and records."
            cols={[{ name: 'code', label: 'Code', width: '7rem', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone', width: '11rem' }, { name: 'address', label: 'Address', width: '2fr' }]} />
        </div>
      </div>
    </>
  );
}
