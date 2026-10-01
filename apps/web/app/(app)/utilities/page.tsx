'use client';
import { Button, Card, cx, EmptyState, ErrorBox, KpiCard, PageHeader, Select } from '@erp/ui';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { api, qs } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

type Status = 'paid' | 'partially_paid' | 'unpaid' | 'overdue' | 'disputed' | 'missing' | 'expected' | 'na';
interface Cell { month: string; status: Status; billId?: string; total?: number; expected: string }
interface Row {
  id: string; name: string; type: string; provider: string | null; accountNo: string | null; meterNo: string | null; unit: string | null; status: string;
  siteId: string; site: string; billingDay: number; lastReading: { date: string; reading: number } | null; avgUnits: number | null; avgAmount: number | null;
  lastBill: { id: string; number: string; billDate: string; total: number; status: string } | null; open: number; nextExpected: string | null; overdue: number; missing: number; cells: Cell[];
}
interface Data { months: string[]; rows: Row[]; totals: { connections: number; open: number; overdue: number; dueSoon: number; missing: number; thisMonth: number } }

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const TYPE: Record<string, string> = { electricity: '⚡', gas: '🔥', water: '💧', internet: '🌐', phone: '☎', sewerage: '🚰', other: '•' };
const CELL: Record<Status, { tone: string; label: string }> = {
  paid: { tone: 'green', label: 'Paid' }, partially_paid: { tone: 'blue', label: 'Part paid' }, unpaid: { tone: 'amber', label: 'Unpaid' },
  overdue: { tone: 'red', label: 'Overdue' }, disputed: { tone: 'violet', label: 'Disputed' }, missing: { tone: 'red', label: 'Bill not received' },
  expected: { tone: 'gray', label: 'Expected' }, na: { tone: 'gray', label: '—' },
};
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });

/** Utilities tracker: every connection by site, with a month-by-month bill strip and what needs attention. */
export default function UtilitiesTracker() {
  const meta = useMeta();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [months, setMonths] = useState('12');
  const [siteId, setSiteId] = useState('');
  const [type, setType] = useState('');
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api<{ rows: { id: string; name: string }[] }>('r/utilities.site?pageSize=200&sort=name:asc').then((d) => setSites(d.rows)).catch(() => {}); }, []);
  useEffect(() => { setData(null); api<Data>(`utilities/tracker?${qs({ months, siteId, type })}`).then(setData).catch(setError); }, [months, siteId, type]);
  const t = data?.totals;
  const bySite = data ? [...new Set(data.rows.map((r) => r.siteId))].map((id) => ({ id, name: data.rows.find((r) => r.siteId === id)!.site, rows: data.rows.filter((r) => r.siteId === id) })) : [];

  return (
    <>
      <PageHeader title="Utilities" subtitle="Sites, connections, meter readings and bills — what's due, what's paid, and which bills haven't arrived"
        actions={<>
          {can(meta, 'utilities.site.create') && <Link href="/r/utilities.site/new"><Button variant="outline">+ Site</Button></Link>}
          {can(meta, 'utilities.connection.create') && <Link href="/r/utilities.connection/new"><Button>+ Connection</Button></Link>}
        </>} />
      <ErrorBox error={error} />
      {t && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Connections" value={t.connections} />
          <KpiCard label="Billed this month" value={fmt(t.thisMonth)} />
          <KpiCard label="Unpaid" value={fmt(t.open)} tone={t.open ? 'amber' : 'green'} />
          <KpiCard label="Overdue" value={fmt(t.overdue)} tone={t.overdue ? 'red' : 'green'} hint={t.overdue ? 'late fees may apply' : 'nothing late'} />
          <KpiCard label="Due in 7 days" value={fmt(t.dueSoon)} tone="amber" />
          <KpiCard label="Bills not received" value={t.missing} tone={t.missing ? 'red' : 'green'} hint="past the usual billing day" />
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="w-52"><option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-44"><option value="">All utilities</option>{Object.keys(TYPE).map((k) => <option key={k} value={k}>{TYPE[k]} {k[0].toUpperCase() + k.slice(1)}</option>)}</Select>
        <Select aria-label="Months" value={months} onChange={(e) => setMonths(e.target.value)} className="w-40"><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="24">Last 24 months</option></Select>
        <span className="ms-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {(['paid', 'partially_paid', 'unpaid', 'overdue', 'disputed', 'missing', 'expected'] as Status[]).map((s) => (
            <span key={s} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(--tone-${CELL[s].tone}${s === 'expected' ? '-bg' : ''})`, outline: s === 'missing' ? '1px dashed var(--tone-red)' : undefined }} />{CELL[s].label}</span>
          ))}
        </span>
      </div>

      {data && !data.rows.length && <Card><EmptyState title="No utility connections yet" hint="Add a site, then its electricity, gas, water or internet connections." /></Card>}
      {data && data.rows.length > 0 && (
        <Card>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[64rem] text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-2 text-start font-medium">Connection</th>
                  <th className="px-3 py-2 text-end font-medium">Last reading</th>
                  <th className="px-3 py-2 text-end font-medium">Avg / bill</th>
                  <th className="px-3 py-2 text-end font-medium">Unpaid</th>
                  <th className="px-3 py-2 text-start font-medium">Next bill</th>
                  {data.months.map((m) => <th key={m} className="w-9 px-0.5 py-2 text-center font-medium normal-case">{mon(m)}</th>)}
                </tr>
              </thead>
              <tbody>
                {bySite.map((s) => (
                  <Fragment key={s.id}>
                    <tr className="bg-muted/40"><td colSpan={5 + data.months.length} className="px-5 py-1.5 text-xs font-semibold uppercase tracking-wide"><Link className="hover:underline" href={`/r/utilities.site/${s.id}`}>{s.name}</Link> <span className="font-normal normal-case text-muted-foreground">· {s.rows.length} connection{s.rows.length > 1 ? 's' : ''}</span></td></tr>
                    {s.rows.map((r) => (
                      <tr key={r.id} className={cx('border-b border-border/60', r.status !== 'active' && 'opacity-60')}>
                        <td className="px-5 py-2.5">
                          <Link href={`/r/utilities.connection/${r.id}`} className="font-medium hover:underline"><span className="me-1.5" aria-hidden="true">{TYPE[r.type] ?? '•'}</span>{r.name}</Link>
                          <div className="text-xs text-muted-foreground">{[r.provider, r.accountNo && `A/c ${r.accountNo}`, r.meterNo && `Meter ${r.meterNo}`].filter(Boolean).join(' · ')}{r.status !== 'active' ? ` · ${r.status}` : ''}</div>
                        </td>
                        <td className="px-3 py-2.5 text-end tabular-nums">{r.lastReading ? <>{fmt(r.lastReading.reading)}<div className="text-xs text-muted-foreground">{r.lastReading.date}</div></> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2.5 text-end tabular-nums">{r.avgAmount != null ? <>{fmt(r.avgAmount)}{r.avgUnits != null && <div className="text-xs text-muted-foreground">{fmt(r.avgUnits)} {r.unit ?? 'units'}</div>}</> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2.5 text-end font-semibold tabular-nums" style={{ color: r.overdue ? 'var(--tone-red)' : r.open ? 'var(--tone-amber)' : undefined }}>{r.open ? fmt(r.open) : <span className="font-normal text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2.5">{r.nextExpected ? <><div>{new Date(r.nextExpected).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</div><div className="text-xs text-muted-foreground">every month, day {r.billingDay}</div></> : <span className="text-muted-foreground">—</span>}</td>
                        {r.cells.map((c) => {
                          const cfg = CELL[c.status];
                          const tip = `${mon(c.month)} ${c.month.slice(0, 4)}: ${cfg.label}${c.total != null ? ` · ${fmt(c.total)}` : ''}${!c.billId && c.status !== 'na' ? ` (usual bill date ${c.expected})` : ''}`;
                          const box = (
                            <span className={cx('mx-auto block h-6 w-7 rounded', c.status === 'na' && 'opacity-30')} title={tip} aria-label={tip}
                              style={{ background: c.status === 'expected' || c.status === 'na' || c.status === 'missing' ? `var(--tone-${cfg.tone}-bg)` : `var(--tone-${cfg.tone})`, outline: c.status === 'missing' ? '1.5px dashed var(--tone-red)' : undefined }} />
                          );
                          return <td key={c.month} className="px-0.5 py-2.5">{c.billId ? <Link href={`/r/utilities.bill/${c.billId}`}>{box}</Link> : <Link href={`/r/utilities.connection/${r.id}`}>{box}</Link>}</td>;
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Click a month to open its bill, or the connection to add a meter reading or record the bill. Bills are booked as payables, so they also appear on P &amp; R and can be paid from either place.</p>
        </Card>
      )}
    </>
  );
}
