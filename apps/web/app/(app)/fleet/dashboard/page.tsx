'use client';
import { BarChart, Card, EmptyState, KpiCard, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface D { vehicles: number; inMaintenance: number; dueService: { id: string; plate: string; odometer: number }[]; expiringDocuments: { id: string; type: string; plate?: string; expiryDate: string }[]; expiringLicenses: { id: string; name: string; licenseExpiry: string }[]; fuelEfficiency: { plate?: string; kmPerLitre: number | null; cost: number }[] }

export default function FleetDashboard() {
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { api<D>('fleet/dashboard').then(setD); }, []);
  if (!d) return null;
  return (
    <>
      <PageHeader title="Fleet dashboard" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Vehicles" value={d.vehicles} />
        <KpiCard label="In maintenance" value={d.inMaintenance} tone={d.inMaintenance ? 'amber' : undefined} />
        <KpiCard label="Due for service" value={d.dueService.length} tone={d.dueService.length ? 'amber' : undefined} />
        <KpiCard label="Expiring documents (30d)" value={d.expiringDocuments.length + d.expiringLicenses.length} tone={d.expiringDocuments.length ? 'red' : undefined} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Due for service">
          {!d.dueService.length ? <EmptyState title="All serviced" /> : <ul className="text-sm">{d.dueService.map((v) => <li key={v.id} className="py-1"><Link className="text-primary hover:underline" href={`/r/fleet.vehicle/${v.id}`}>{v.plate}</Link> · {v.odometer.toLocaleString()} km</li>)}</ul>}
        </Card>
        <Card title="Expiring">
          <ul className="text-sm">
            {d.expiringDocuments.map((x) => <li key={x.id} className="py-1">{x.plate} — {x.type} · {x.expiryDate.slice(0, 10)}</li>)}
            {d.expiringLicenses.map((x) => <li key={x.id} className="py-1">{x.name} — driving license · {x.licenseExpiry.slice(0, 10)}</li>)}
          </ul>
          {!d.expiringDocuments.length && !d.expiringLicenses.length && <EmptyState title="Nothing expiring" />}
        </Card>
        <Card title="Fuel efficiency (km/l, 90 days)"><BarChart label="Km per litre" data={d.fuelEfficiency.filter((f) => f.kmPerLitre !== null).map((f) => ({ label: f.plate ?? '—', value: f.kmPerLitre! }))} /></Card>
      </div>
    </>
  );
}
