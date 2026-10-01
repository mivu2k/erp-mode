'use client';
import { Button, Card, ErrorBox, Input, Label, PageHeader } from '@erp/ui';
import { useState } from 'react';
import { api } from '@/lib/api';

export default function ProcessAttendance() {
  const [from, setFrom] = useState(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(from);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setLog([]); setError(null);
    try {
      for (let d = new Date(from); d <= new Date(to); d = new Date(+d + 86_400_000)) {
        const date = d.toISOString().slice(0, 10);
        const r = await api<{ processed: number }>('hrm/attendance/process', 'POST', { date });
        setLog((l) => [...l, `${date}: ${r.processed} employees`]);
      }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Process attendance" subtitle="Turns punches, shifts, holidays and approved leave into daily status. Safe to re-run." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label htmlFor="from">From</Label><Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label htmlFor="to">To</Label><Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <Button disabled={busy} onClick={run}>{busy ? 'Processing…' : 'Process'}</Button>
        </div>
        <div className="mt-3"><ErrorBox error={error} /></div>
        <ul className="mt-3 text-sm text-muted-foreground">{log.map((l) => <li key={l}>{l}</li>)}</ul>
      </Card>
    </>
  );
}
