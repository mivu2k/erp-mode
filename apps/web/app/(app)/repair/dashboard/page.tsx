'use client';
import { BarChart, Card, KpiCard, PageHeader, Select } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface D { byStatus: { status: string; count: number }[]; workload: { technician: string; open: number }[]; overdue: number; avgTurnaroundHours: number; revenue: { labor: number; parts: number }; topFaults: { fault: string; count: number }[]; comebackRate: number }

export default function RepairDashboard() {
  const [days, setDays] = useState('30');
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { api<D>(`repair/dashboard?days=${days}`).then(setD); }, [days]);
  return (
    <>
      <PageHeader title="Repair dashboard" actions={<Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="w-36"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></Select>} />
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiCard label="Overdue" value={d.overdue} tone={d.overdue ? 'red' : undefined} />
            <KpiCard label="Avg turnaround" value={`${d.avgTurnaroundHours} h`} />
            <KpiCard label="Labor revenue" value={d.revenue.labor.toLocaleString()} />
            <KpiCard label="Parts revenue" value={d.revenue.parts.toLocaleString()} />
            <KpiCard label="Comeback rate" value={`${d.comebackRate}%`} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card title="Open jobs by status"><BarChart label="Jobs by status" data={d.byStatus.map((s) => ({ label: s.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), value: s.count }))} /></Card>
            <Card title="Technician workload"><BarChart label="Open jobs per technician" data={d.workload.map((w) => ({ label: w.technician ?? '—', value: w.open }))} /></Card>
            <Card title="Top faults"><BarChart label="Top faults" data={d.topFaults.map((f) => ({ label: f.fault ?? '—', value: f.count }))} /></Card>
          </div>
        </>
      )}
    </>
  );
}
