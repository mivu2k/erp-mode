'use client';
import { BarChart, Card, EmptyState, ErrorBox, humanize, KpiCard, Skeleton } from '@erp/ui';
import { ReactNode, useEffect, useState } from 'react';
import { api } from './api';

export interface Widget { reportId: string; type: 'bar' | 'table' | 'kpi'; title: string }
export interface DashboardRec { id: string; name: string; roleId?: string | null; userId?: string | null; createdById?: string | null; widgets: Widget[] }

interface Out { columns: string[]; rows: Record<string, unknown>[] }
const cellOf = (r: Record<string, unknown>, c: string) => String((r._refs as Record<string, unknown> | undefined)?.[c] ?? r[c] ?? '');

/** Renders one saved report as a dashboard tile; the report runs with the viewer's own data scope. */
export function WidgetView({ w, actions }: { w: Widget; actions?: ReactNode }) {
  const [out, setOut] = useState<Out | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api<Out>(`reports/${w.reportId}/run`).then(setOut).catch(setError); }, [w.reportId]);
  const label = out?.columns[0] ?? '';
  const value = out?.columns.find((c) => c !== label && out.rows.some((r) => typeof r[c] === 'number')) ?? 'count';
  const body = error ? <ErrorBox error={error} /> : !out ? <Skeleton className="h-24" /> : !out.rows.length ? <EmptyState title="No data" />
    : w.type === 'kpi' ? <KpiCard label={humanize(value)} value={out.rows.reduce((s, r) => s + Number(r[value] ?? 0), 0).toLocaleString()} />
    : w.type === 'bar' ? <BarChart label={w.title} data={out.rows.slice(0, 15).map((r) => ({ label: cellOf(r, label) || '—', value: Number(r[value] ?? 0) }))} />
    : (
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted"><tr>{out.columns.map((c) => <th key={c} className="px-2 py-1 text-start font-medium">{humanize(c)}</th>)}</tr></thead>
          <tbody>{out.rows.slice(0, 50).map((r, i) => <tr key={i} className="border-t border-border">{out.columns.map((c) => <td key={c} className="px-2 py-1">{cellOf(r, c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  return <Card title={w.title} actions={actions}>{body}</Card>;
}

/** Dashboards the user should see: their own, their roles', or unassigned company-wide ones. */
export function visibleDashboards(all: DashboardRec[], userId: string, roleIds: string[]) {
  return all.filter((d) => d.userId === userId || d.createdById === userId || (d.roleId && roleIds.includes(d.roleId)) || (!d.userId && !d.roleId));
}
