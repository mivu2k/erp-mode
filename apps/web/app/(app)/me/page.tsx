'use client';
import { Button, Card, EmptyState, ErrorBox, KpiCard, PageHeader, StatusBadge } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

type Rec = Record<string, unknown> & { id: string; _refs?: Record<string, string | null> };
interface Balance { type: string; leaveTypeId: string; entitled: number; taken: number; remaining: number }

const fmt = (v: unknown) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Everything that is mine, on one page: profile, leave, attendance, pay, tasks, claims & advances. Every list is own-scoped by the API. */
export default function MyHr() {
  const meta = useMeta();
  const empId = meta.user.employeeId;
  const [me, setMe] = useState<Rec | null>(null);
  const [data, setData] = useState<Record<string, Rec[]>>({});
  const [balance, setBalance] = useState<Balance[]>([]);
  const [error, setError] = useState<unknown>(null);
  const month = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    if (!empId) return;
    api<Rec>(`r/hrm.employee/${empId}`).then(setMe).catch(setError);
    api<Balance[]>(`hrm/leave/balance/${empId}`).then(setBalance).catch(() => {});
    const lists: [string, string, object][] = [
      ['hrm.attendance', 'date:desc', { date: { gte: `${month}-01` } }], ['hrm.leave', 'createdAt:desc', {}], ['hrm.payslip', 'createdAt:desc', {}],
      ['hrm.task', 'dueDate:asc', { status: { in: ['todo', 'in_progress', 'review', 'blocked'] } }],
      ['finance.claim', 'createdAt:desc', {}], ['finance.advance', 'createdAt:desc', {}], ['finance.loan', 'createdAt:desc', {}],
    ];
    for (const [key, sort, filters] of lists) {
      if (!can(meta, `${key}.view`)) continue;
      api<{ rows: Rec[] }>(`r/${key}?${qs({ pageSize: key === 'hrm.attendance' ? 31 : 5, sort, filters })}`).then((d) => setData((s) => ({ ...s, [key]: d.rows }))).catch(() => {});
    }
  }, [empId, meta, month]);

  if (!empId) return <><PageHeader title="My HR" /><Card><EmptyState title="Your login isn't linked to an employee record" hint="Ask HR to set your user on your employee profile." /></Card></>;
  // One tile per day (latest processing wins), oldest first.
  const att = [...new Map((data['hrm.attendance'] ?? []).map((a) => [String(a.date).slice(0, 10), a])).values()];
  const paidLeave = balance.filter((b) => !/unpaid/i.test(b.type));
  const count = (s: string) => att.filter((a) => a.status === s).length;
  const openAdvances = [...(data['finance.advance'] ?? []), ...(data['finance.loan'] ?? [])].filter((a) => a.status === 'disbursed');
  const owed = openAdvances.reduce((s, a) => s + Number(a.amount) - Number(a.recovered), 0);
  const newLink = (key: string, label: string) => can(meta, `${key}.create`) && <Link href={`/r/${key}/new`}><Button size="sm" variant="outline">{label}</Button></Link>;
  const list = (key: string, cols: (r: Rec) => React.ReactNode, empty: string) => (
    (data[key] ?? []).length ? (
      <ul className="divide-y divide-border text-sm">
        {data[key].map((r) => <li key={r.id}><Link href={`/r/${key}/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:text-primary">{cols(r)}</Link></li>)}
      </ul>
    ) : <p className="text-sm text-muted-foreground">{empty}</p>
  );

  return (
    <>
      <PageHeader title={`My HR${me ? ` — ${me.name}` : ''}`} subtitle="Your profile, leave, attendance, pay, tasks, claims and advances"
        actions={<>
          {can(meta, 'hrm.employee.print') && <Button variant="outline" onClick={() => openDoc(`print/hrm.employee/${empId}?template=idcard`)}>My ID card</Button>}
          <Link href={`/r/hrm.employee/${empId}`}><Button variant="outline">My profile</Button></Link>
        </>} />
      <ErrorBox error={error} />
      {me && (
        <Card className="mb-4">
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {([['Employee ID', me.code], ['Designation', me._refs?.designationId], ['Department', me._refs?.departmentId], ['Branch', me._refs?.branchId], ['Manager', me._refs?.managerId], ['Joined', day(me.joinDate)], ['Phone', me.phone], ['Email', me.email]] as [string, unknown][])
              .map(([k, v]) => <div key={k}><div className="text-xs text-muted-foreground">{k}</div><div className="font-medium">{String(v ?? '—') || '—'}</div></div>)}
          </div>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={`Present this month`} value={count('present') + count('late')} hint={`${count('late')} late · ${count('absent')} absent`} tone="green" />
        <KpiCard label="Paid leave remaining" value={fmt(paidLeave.reduce((s, b) => s + b.remaining, 0))} hint={`${fmt(paidLeave.reduce((s, b) => s + b.taken, 0))} taken this year`} tone="blue" />
        <KpiCard label="Last net pay" value={data['hrm.payslip']?.[0] ? fmt(data['hrm.payslip'][0].net) : '—'} hint={data['hrm.payslip']?.[0] ? String(data['hrm.payslip'][0].period) : 'no payslip yet'} />
        <KpiCard label="Advance to settle" value={fmt(owed)} hint={`${openAdvances.length} open`} tone={owed ? 'amber' : 'green'} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="Leave" actions={newLink('hrm.leave', 'Apply for leave')}>
          {balance.length > 0 && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {balance.map((b) => (
                <div key={b.leaveTypeId} className="rounded-lg border border-border p-2.5">
                  <div className="text-xs text-muted-foreground">{b.type}</div>
                  <div className="text-lg font-semibold tabular-nums">{fmt(b.remaining)} <span className="text-xs font-normal text-muted-foreground">of {fmt(b.entitled)}</span></div>
                </div>
              ))}
            </div>
          )}
          {list('hrm.leave', (r) => <><span>{r._refs?.leaveTypeId ?? 'Leave'} · {day(r.from)} → {day(r.to)}</span><StatusBadge status={String(r.status)} /></>, 'No leave requests yet.')}
        </Card>

        <Card title={`Attendance — ${new Date().toLocaleDateString(undefined, { month: 'long' })}`} actions={newLink('hrm.correction', 'Request correction')}>
          {att.length ? (
            <div className="flex flex-wrap gap-1">
              {att.sort((x, y) => String(x.date).localeCompare(String(y.date))).map((a) => (
                <Link key={a.id} href={`/r/hrm.attendance/${a.id}`} title={`${String(a.date).slice(0, 10)}: ${a.status}`}
                  className="grid h-9 w-9 place-items-center rounded text-xs font-medium"
                  style={{ background: `var(--tone-${a.status === 'present' ? 'green' : a.status === 'late' ? 'amber' : a.status === 'absent' ? 'red' : a.status === 'leave' ? 'blue' : 'gray'}-bg)` }}>
                  {String(a.date).slice(8, 10)}
                </Link>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">No attendance processed for this month yet.</p>}
        </Card>

        <Card title="Payslips">
          {list('hrm.payslip', (r) => <><span>{String(r.period)}</span><span className="flex items-center gap-3"><b className="tabular-nums">{fmt(r.net)}</b><StatusBadge status={String(r.status)} /></span></>, 'No payslips yet.')}
        </Card>

        <Card title="My tasks">
          {list('hrm.task', (r) => <><span className="truncate">{String(r.title)}</span><span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">{r.dueDate ? `due ${day(r.dueDate)}` : ''}<StatusBadge status={String(r.status)} /></span></>, 'No open tasks.')}
        </Card>

        <Card title="Expense claims" actions={newLink('finance.claim', 'New claim')}>
          {list('finance.claim', (r) => <><span>{String(r.number ?? '')} · {day(r.date)}</span><span className="flex items-center gap-3"><b className="tabular-nums">{fmt(r.approvedTotal ?? r.total)}</b><StatusBadge status={String(r.status)} /></span></>, 'No claims yet.')}
        </Card>

        <Card title="Advances & loans" actions={<span className="flex gap-2">{newLink('finance.advance', 'Expense advance')}{newLink('finance.loan', 'Salary advance')}</span>}>
          {[...(data['finance.advance'] ?? []).map((r) => ({ ...r, _k: 'finance.advance' })), ...(data['finance.loan'] ?? []).map((r) => ({ ...r, _k: 'finance.loan' }))].length ? (
            <ul className="divide-y divide-border text-sm">
              {[...(data['finance.advance'] ?? []).map((r) => ({ r, k: 'finance.advance' })), ...(data['finance.loan'] ?? []).map((r) => ({ r, k: 'finance.loan' }))].map(({ r, k }) => (
                <li key={r.id}><Link href={`/r/${k}/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:text-primary">
                  <span>{String(r.number ?? '')} · {k === 'finance.loan' ? 'Salary advance' : 'Expense advance'}</span>
                  <span className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{fmt(r.recovered)} of {fmt(r.amount)} repaid</span><StatusBadge status={String(r.status)} /></span>
                </Link></li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No advances.</p>}
        </Card>
      </div>
    </>
  );
}
