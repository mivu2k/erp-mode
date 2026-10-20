'use client';
import { BarChart, Button, Card, EmptyState, ErrorBox, humanize, Input, Label, PageHeader, Select, Textarea } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, openDoc, qs, raw } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

interface Rep { id: string; name: string; description?: string | null; definition: { resource: string; groupBy?: string[] }; sharedRoles?: string[] | null; schedule?: string | null; recipients?: string[] | null; lastSentAt?: string | null }
interface Out { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
const cellOf = (r: Record<string, unknown>, c: string) => String((r._refs as Record<string, unknown> | undefined)?.[c] ?? r[c] ?? '');

/** A saved report as a report: its results first (period, print, Excel), then plain settings — who sees it, emailing — with no JSON or ids. */
export default function SavedReport() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const meta = useMeta();
  const [rep, setRep] = useState<Rep | null>(null);
  const [form, setForm] = useState({ name: '', description: '', schedule: '', recipients: '', roles: [] as string[] });
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [p, setP] = useState({ from: '', to: '', period: '' });
  const [out, setOut] = useState<Out | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const editable = can(meta, 'reports.report.update');

  useEffect(() => {
    api<Rep>(`r/reports.report/${id}`).then((r) => {
      setRep(r);
      setForm({ name: r.name, description: r.description ?? '', schedule: r.schedule ?? '', recipients: (r.recipients ?? []).join(', '), roles: r.sharedRoles ?? [] });
    }).catch(setError);
    api<{ rows: { id: string; name: string }[] }>('r/core.role?pageSize=200').then((d) => setRoles(d.rows)).catch(() => {});
  }, [id]);
  const run = useCallback(() => { setError(null); api<Out>(`reports/${id}/run?${qs(p)}`).then(setOut).catch(setError); }, [id, p]);
  useEffect(() => { if (rep) run(); }, [rep]); // eslint-disable-line react-hooks/exhaustive-deps

  const excel = async () => {
    try { const r = await raw(`reports/${id}/run?${qs({ ...p, format: 'xlsx' })}`); Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `${rep?.name ?? 'report'}.xlsx` }).click(); } catch (e) { setError(e); }
  };
  const save = async () => {
    setError(null); setSaved(false);
    try {
      await api(`r/reports.report/${id}`, 'PATCH', { name: form.name, description: form.description || null, schedule: form.schedule || null, sharedRoles: form.roles, recipients: form.recipients.split(/[\s,;]+/).filter(Boolean) });
      setSaved(true);
    } catch (e) { setError(e); }
  };
  if (!rep) return <ErrorBox error={error} />;
  const src = meta.resources.find((r) => r.key === rep.definition.resource);
  const g = rep.definition.groupBy?.[0];
  const y = out && g ? out.columns.find((c) => c !== g && !rep.definition.groupBy?.includes(c)) ?? 'count' : null;

  return (
    <>
      <nav className="mb-2 text-xs text-muted-foreground"><Link className="hover:underline" href="/reports">Reports</Link> / Saved</nav>
      <PageHeader title={rep.name} subtitle={[rep.description, src && `from ${src.label}`].filter(Boolean).join(' · ')}
        actions={<><Button onClick={run}>Run</Button><Button variant="outline" onClick={() => openDoc(`reports/${id}/run?${qs({ ...p, format: 'html' })}`).catch(setError)}>Print / PDF</Button><Button variant="outline" onClick={excel}>Excel</Button>
          {can(meta, 'reports.report.delete') && <Button variant="ghost" onClick={() => confirm('Delete this saved report?') && api(`r/reports.report/${id}`, 'DELETE').then(() => router.replace('/reports')).catch(setError)}>Delete</Button>}</>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Period">
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <div><Label htmlFor="f">From</Label><Input id="f" type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></div>
              <div><Label htmlFor="t">To</Label><Input id="t" type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></div>
              <Button variant="outline" onClick={run}>Apply</Button>
            </div>
          </Card>
          {y && out && <Card title={`${humanize(y)} by ${humanize(g!)}`}><BarChart label="Report chart" data={out.rows.map((r) => ({ label: cellOf(r, g!) || '—', value: Number(r[y] ?? 0) }))} /></Card>}
          <Card title={out ? `${out.rows.length} rows${out.truncated ? ' (limit reached — use Excel for all)' : ''}` : 'Results'}>
            {!out ? <EmptyState title="Running…" /> : !out.rows.length ? <EmptyState title="No rows for this period" /> : (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr>{out.columns.map((c) => <th key={c} className="px-3 py-2 text-start font-medium first:ps-5">{humanize(c)}</th>)}</tr></thead>
                  <tbody>{out.rows.map((r, i) => <tr key={i} className="border-t border-border/60">{out.columns.map((c) => <td key={c} className="px-3 py-2 first:ps-5">{cellOf(r, c) || '—'}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        <Card title="Settings">
          <fieldset disabled={!editable} className="space-y-3 text-sm">
            <div><Label htmlFor="n">Name</Label><Input id="n" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label htmlFor="d">Description</Label><Input id="d" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><Label>Who can see it</Label>
              <p className="mb-1 text-xs text-muted-foreground">Nothing ticked = only you and admins.</p>
              <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2">
                {roles.map((r) => <label key={r.id} className="flex items-center gap-2"><input type="checkbox" checked={form.roles.includes(r.id)} onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r.id] : form.roles.filter((x) => x !== r.id) })} />{r.name}</label>)}
              </div>
            </div>
            <div><Label htmlFor="s">Email it</Label>
              <Select id="s" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}><option value="">Never</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Select></div>
            {form.schedule && <div><Label htmlFor="e">To (emails)</Label><Textarea id="e" rows={2} placeholder="owner@company.com, manager@company.com" value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} /></div>}
            {rep.lastSentAt && <p className="text-xs text-muted-foreground">Last emailed {new Date(rep.lastSentAt).toLocaleString()}</p>}
            {editable && <div className="flex items-center gap-2"><Button onClick={save}>Save settings</Button>{saved && <span role="status" className="text-xs" style={{ color: 'var(--tone-green)' }}>Saved</span>}</div>}
            <p className="text-xs text-muted-foreground">To change what the report shows, open it in the <Link className="text-primary hover:underline" href="/reports">Report builder</Link> and save it again.</p>
          </fieldset>
        </Card>
      </div>
    </>
  );
}
