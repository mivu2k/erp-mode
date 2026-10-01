'use client';
import { BarChart, Card, KpiCard, PageHeader, useT } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';
import { DashboardRec, visibleDashboards, WidgetView } from '@/lib/widgets';

interface AdminDash { users: number; activeSessions: number; pendingApprovals: number; logins24h: number; failed24h: number; employees: number; openJobs: number; uptimeSec: number }
interface RepairDash { byStatus: { status: string; count: number }[]; overdue: number; avgTurnaroundHours: number; revenue: { labor: number; parts: number }; comebackRate: number }

export default function Dashboard() {
  const meta = useMeta();
  const t = useT();
  const [admin, setAdmin] = useState<AdminDash | null>(null);
  const [repair, setRepair] = useState<RepairDash | null>(null);
  const [inbox, setInbox] = useState<number | null>(null);
  const [dash, setDash] = useState<DashboardRec | null>(null);
  useEffect(() => {
    api<unknown[]>('approvals/inbox').then((x) => setInbox(x.length)).catch(() => {});
    if (can(meta, 'core.audit.view')) api<AdminDash>('admin/dashboard').then(setAdmin).catch(() => {});
    if (can(meta, 'repair.dashboard.view')) api<RepairDash>('repair/dashboard').then(setRepair).catch(() => {});
    if (can(meta, 'reports.dashboard.view')) api<{ rows: DashboardRec[] }>('r/reports.dashboard?pageSize=100').then((d) => setDash(visibleDashboards(d.rows, meta.user.id, meta.user.roleIds)[0] ?? null)).catch(() => {});
  }, [meta]);
  return (
    <>
      <PageHeader title={`${t('Welcome')}, ${meta.user.name}`} subtitle={meta.company.name} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/approvals"><KpiCard label={t('Waiting for my approval')} value={inbox ?? '—'} tone={inbox ? 'amber' : undefined} /></Link>
        {admin && <>
          <KpiCard label="Active users" value={admin.users} hint={`${admin.activeSessions} sessions`} />
          <KpiCard label="Logins (24h)" value={admin.logins24h} hint={`${admin.failed24h} failed`} tone={admin.failed24h > 10 ? 'red' : undefined} />
          <KpiCard label="Employees" value={admin.employees} hint={`${admin.openJobs} open jobs · up ${Math.round(admin.uptimeSec / 3600)}h`} />
        </>}
      </div>
      {dash && dash.widgets.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{dash.widgets.map((w, i) => <WidgetView key={i} w={w} />)}</div>
      )}
      {repair && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Jobs by status"><BarChart label="Jobs by status" data={repair.byStatus.map((s) => ({ label: s.status.replace(/_/g, ' '), value: s.count }))} /></Card>
          <div className="grid grid-cols-2 gap-3">
            <KpiCard label="Overdue jobs" value={repair.overdue} tone={repair.overdue ? 'red' : undefined} />
            <KpiCard label="Avg turnaround" value={`${repair.avgTurnaroundHours} h`} />
            <KpiCard label="Labor revenue (30d)" value={repair.revenue.labor.toLocaleString()} />
            <KpiCard label="Parts revenue (30d)" value={repair.revenue.parts.toLocaleString()} />
          </div>
        </div>
      )}
    </>
  );
}
