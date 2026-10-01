'use client';
import { Button, Card, ErrorBox, PageHeader } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Job { job: string; at?: number; result?: unknown }
const JOBS = [
  { name: 'outbox', label: 'Email outbox', hint: 'Every minute. Emails notifications once SMTP is configured in Settings › smtp.' },
  { name: 'escalation', label: 'Approval escalation', hint: 'Every 15 minutes. Workflow steps with escalateAfterHours / escalateToRoleId.' },
  { name: 'nightly', label: 'Nightly run', hint: 'Once per day after Settings › jobs.nightlyHour: attendance, recurring & overdue tasks, expiry reminders, overdue gatepasses, aged advances, low stock, scheduled reports.' },
];

export default function Jobs() {
  const [rows, setRows] = useState<Job[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [last, setLast] = useState<unknown>(null);
  const load = () => api<Job[]>('admin/jobs').then(setRows).catch(setError);
  useEffect(() => { load(); }, []);
  const run = async (name: string) => {
    setBusy(name); setError(null);
    try { setLast(await api(`admin/jobs/${name}/run`, 'POST')); load(); } catch (e) { setError(e); } finally { setBusy(''); }
  };
  return (
    <>
      <PageHeader title="Background jobs" />
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        {JOBS.map((j) => {
          const s = rows.find((r) => r.job === j.name);
          return (
            <Card key={j.name} title={j.label} actions={<Button size="sm" disabled={!!busy} onClick={() => run(j.name)}>{busy === j.name ? 'Running…' : 'Run now'}</Button>}>
              <p className="text-xs text-muted-foreground">{j.hint}</p>
              <p className="mt-2 text-sm">Last run: {s?.at ? new Date(s.at).toLocaleString() : 'never'}</p>
              {s?.result !== undefined && <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(s.result, null, 2)}</pre>}
            </Card>
          );
        })}
      </div>
      {last !== null && <Card className="mt-4" title="Result of last manual run"><pre className="overflow-auto text-xs">{JSON.stringify(last, null, 2)}</pre></Card>}
    </>
  );
}
