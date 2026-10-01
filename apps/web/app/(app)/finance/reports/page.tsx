'use client';
import { Button, Card, Input, Label, PageHeader } from '@erp/ui';
import { useState } from 'react';
import { openDoc, qs } from '@/lib/api';

const REPORTS = [
  { path: 'finance/trial-balance', label: 'Trial balance', to: true },
  { path: 'finance/advances/aging', label: 'Outstanding advances (aging)' },
  { path: 'inventory/valuation', label: 'Inventory valuation' },
  { path: 'inventory/low-stock', label: 'Low stock' },
  { path: 'purchase/vendors/performance', label: 'Vendor performance' },
  { path: 'gatepass/overdue', label: 'Overdue returnables & demos' },
];

export default function FinanceReports() {
  const [to, setTo] = useState('');
  return (
    <>
      <PageHeader title="Financial & operational reports" subtitle="Account ledgers, cash book and statements open from each account, employee, customer or vendor record." />
      <Card>
        <div className="mb-4 w-48"><Label htmlFor="to">As of (optional)</Label><Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <ul className="divide-y divide-border">
          {REPORTS.map((r) => (
            <li key={r.path} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              {r.label}
              <span className="flex gap-2">
                {(['html', 'pdf', 'xlsx', 'csv'] as const).map((f) => <Button key={f} size="sm" variant="outline" onClick={() => openDoc(`${r.path}?${qs({ format: f, to: r.to ? to : undefined })}`)}>{f === 'html' ? 'View' : f.toUpperCase()}</Button>)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
