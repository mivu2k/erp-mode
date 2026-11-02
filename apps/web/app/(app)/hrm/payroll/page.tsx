'use client';
import { Button, Card, EmptyState, ErrorBox, FormGrid, PageHeader, StatusBadge } from '@erp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';
import { renderRef } from '@/lib/RefPicker';

interface Run { id: string; number: string; period: string; gross: string | number; net: string | number; status: string }
const fmt = (v: string | number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** Payroll in one place: generate a month's run, see recent runs, and the lists behind them. */
export default function Payroll() {
  const router = useRouter();
  const meta = useMeta();
  const [v, setV] = useState<Record<string, unknown>>({ period: new Date().toISOString().slice(0, 7) });
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api<{ rows: Run[] }>('r/hrm.payroll?pageSize=12&sort=createdAt:desc').then((d) => setRuns(d.rows)).catch(() => setRuns([])); }, []);
  return (
    <>
      <PageHeader title="Payroll" actions={<nav aria-label="Payroll lists" className="flex flex-wrap gap-2 text-sm">
        {meta.resources.filter((r) => ['hrm.payslip', 'hrm.salary', 'hrm.fine'].includes(r.key)).map((r) => <Link key={r.key} href={`/r/${r.key}`} className="rounded-full border border-border px-3 py-1 hover:bg-muted">All {r.label.toLowerCase()}</Link>)}
      </nav>} />
      <div className="grid items-start gap-4 lg:grid-cols-[22rem_1fr]">
        {can(meta, 'hrm.payroll.create') && (
          <Card title="Run a month">
            <p className="mb-3 text-sm text-muted-foreground">Every employee with a salary structure: salary, allowances and deductions, unpaid leave, fines dated in the month and salary-advance installments. Attendance changes pay only if switched on in Settings › Payroll rules. The run starts as a draft: submit it for approval, then post it.</p>
            <FormGrid fields={[{ name: 'period', type: 'string', required: true, label: 'Month (YYYY-MM)' }, { name: 'branchId', type: 'string', ref: 'core.branch', label: 'Branch (optional)' }]} values={v} renderRef={renderRef} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} />
            <div className="mt-3"><ErrorBox error={error} /></div>
            <Button className="mt-3" onClick={() => api<{ id: string }>('hrm/payroll/generate', 'POST', v).then((r) => router.push(`/r/hrm.payroll/${r.id}`)).catch(setError)}>Generate payslips</Button>
          </Card>
        )}
        <Card title="Recent runs">
          {!runs ? null : !runs.length ? <EmptyState title="No payroll runs yet" /> : (
            <ul className="divide-y divide-border text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link className="font-medium text-primary hover:underline" href={`/r/hrm.payroll/${r.id}`}>{r.number}</Link> <span className="text-muted-foreground">{r.period}</span></span>
                  <span className="flex items-center gap-3 tabular-nums"><span className="text-muted-foreground">Net</span> {fmt(r.net)} <StatusBadge status={r.status} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
