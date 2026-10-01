'use client';
import { Button, Card, EmptyState, ErrorBox, Input, Label, PageHeader, Select, useT } from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';
import { DashboardRec, visibleDashboards, Widget, WidgetView } from '@/lib/widgets';

/** Drag-and-drop dashboard builder over saved reports. */
export default function Dashboards() {
  const meta = useMeta();
  const t = useT();
  const [all, setAll] = useState<DashboardRec[]>([]);
  const [cur, setCur] = useState<DashboardRec | null>(null);
  const [reports, setReports] = useState<{ id: string; name: string }[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [add, setAdd] = useState<Partial<Widget>>({ type: 'bar' });
  const [drag, setDrag] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const editable = can(meta, 'reports.dashboard.update');

  const load = useCallback(async () => {
    const d = await api<{ rows: DashboardRec[] }>('r/reports.dashboard?pageSize=100');
    const mine = visibleDashboards(d.rows, meta.user.id, meta.user.roleIds);
    setAll(mine);
    setCur((c) => mine.find((x) => x.id === c?.id) ?? mine[0] ?? null);
  }, [meta.user.id, meta.user.roleIds]);
  useEffect(() => {
    load().catch(setError);
    api<{ id: string; name: string }[]>('reports/available').then(setReports).catch(() => {});
    if (can(meta, 'core.role.view')) api<{ rows: { id: string; name: string }[] }>('r/core.role?pageSize=100').then((d) => setRoles(d.rows)).catch(() => {});
  }, [load, meta]);

  const save = async (next: DashboardRec) => {
    setCur(next);
    try { await api(`r/reports.dashboard/${next.id}`, 'PATCH', { name: next.name, roleId: next.roleId ?? null, widgets: next.widgets }); } catch (e) { setError(e); }
  };
  const create = async () => {
    const name = prompt('Dashboard name');
    if (!name) return;
    try { const d = await api<DashboardRec>('r/reports.dashboard', 'POST', { name, userId: meta.user.id, widgets: [] }); await load(); setCur(d); } catch (e) { setError(e); }
  };
  const move = (from: number, to: number) => {
    if (!cur || from === to) return;
    const w = [...cur.widgets];
    const [x] = w.splice(from, 1);
    w.splice(to, 0, x);
    save({ ...cur, widgets: w });
  };

  return (
    <>
      <PageHeader title={t('Dashboards')} actions={<>
        {all.length > 0 && <Select aria-label="Dashboard" className="w-56" value={cur?.id ?? ''} onChange={(e) => setCur(all.find((d) => d.id === e.target.value) ?? null)}>{all.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
        {can(meta, 'reports.dashboard.create') && <Button onClick={create}>{t('New')}</Button>}
      </>} />
      <ErrorBox error={error} />
      {!cur ? <Card><EmptyState title="No dashboards yet" hint="Create one, then add widgets from saved reports." /></Card> : (
        <>
          {editable && (
            <Card className="mb-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56"><Label htmlFor="rep">Report</Label>
                  <Select id="rep" value={add.reportId ?? ''} onChange={(e) => setAdd({ ...add, reportId: e.target.value, title: reports.find((r) => r.id === e.target.value)?.name })}>
                    <option value="">—</option>{reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                </div>
                <div><Label htmlFor="wt">Type</Label><Select id="wt" value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as Widget['type'] })}><option value="bar">Bar chart</option><option value="table">Table</option><option value="kpi">KPI</option></Select></div>
                <div><Label htmlFor="wtitle">Title</Label><Input id="wtitle" value={add.title ?? ''} onChange={(e) => setAdd({ ...add, title: e.target.value })} /></div>
                <Button disabled={!add.reportId} onClick={() => { save({ ...cur, widgets: [...cur.widgets, { reportId: add.reportId!, type: add.type ?? 'bar', title: add.title || 'Widget' }] }); setAdd({ type: 'bar' }); }}>{t('Add widget')}</Button>
                {roles.length > 0 && (
                  <div className="ms-auto"><Label htmlFor="share">Share with role</Label>
                    <Select id="share" value={cur.roleId ?? ''} onChange={(e) => save({ ...cur, roleId: e.target.value || null })}><option value="">Only me</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
                  </div>
                )}
              </div>
            </Card>
          )}
          {!cur.widgets.length ? <Card><EmptyState title="Empty dashboard" hint="Add a widget above. Drag widgets to reorder." /></Card> : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {cur.widgets.map((w, i) => (
                <div key={`${w.reportId}-${i}`} draggable={editable} onDragStart={() => setDrag(i)} onDragOver={(e) => editable && e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
                  className={editable ? 'cursor-move' : ''}>
                  <WidgetView w={w} actions={editable && <Button size="sm" variant="ghost" aria-label={`Remove ${w.title}`} onClick={() => save({ ...cur, widgets: cur.widgets.filter((_, j) => j !== i) })}>✕</Button>} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
