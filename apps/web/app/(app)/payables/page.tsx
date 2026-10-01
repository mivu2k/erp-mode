'use client';
import { Button, Card, cx, Dialog, EmptyState, ErrorBox, Input, KpiCard, Label, PageHeader, Select, Tabs } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, qs } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

type Dir = 'payable' | 'receivable';
interface Row { source: string; id: string; number: string; direction: Dir; party: string; description: string; dueDate: string; amount: number; paid: number; balance: number; daysOverdue: number; bucket: string; aging: string }
interface Week { week: number; start: string; in: number; out: number; balance: number }
interface Party { party: string; direction: Dir; balance: number; count: number; oldest: string; maxOverdue: number }
interface Data {
  totals: { receivable: number; payable: number; overdueReceivable: number; overduePayable: number; net: number; cash: number; projected: number; beyondForecast: { in: number; out: number } };
  rows: Row[]; aging: Record<Dir, Record<string, number>>; forecast: Week[]; parties: Party[];
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const BUCKETS = [
  { key: 'overdue', label: 'Overdue', tone: 'red' },
  { key: 'this_week', label: 'Due in the next 7 days', tone: 'amber' },
  { key: 'this_month', label: 'Due within 30 days', tone: 'blue' },
  { key: 'later', label: 'Later', tone: 'gray' },
] as const;
const AGING = ['current', '1-30', '31-60', '61-90', '90+'];
const SOURCE: Record<string, string> = { 'payables.due': 'Manual', 'repair.invoice': 'Invoice', 'purchase.bill': 'Vendor bill' };
const PAY_PATH: Record<string, string> = { 'payables.due': 'finance/dues/:id/pay', 'repair.invoice': 'repair/invoices/:id/pay', 'purchase.bill': 'purchase/bills/:id/pay' };
const when = (d: number) => (d > 0 ? `${d} day${d > 1 ? 's' : ''} overdue` : d === 0 ? 'due today' : `due in ${-d} day${d < -1 ? 's' : ''}`);

/** Payables & receivables the way an accounts desk works them: cash position, forecast, aging, who owes what — and pay from the line. */
export default function Dues() {
  const meta = useMeta();
  const [dir, setDir] = useState('');
  const [view, setView] = useState('timeline');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState<Row | null>(null);
  const [n, setN] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { setData(null); api<Data>(`finance/dues/timeline?${qs({ direction: dir })}`).then(setData).catch(setError); }, [dir, n]);
  const canAdd = can(meta, 'payables.due.create');
  const canPay = can(meta, 'finance.payment.create');
  const t = data?.totals;

  return (
    <>
      <PageHeader title="P & R — Payables & Receivables" subtitle="What comes in, what goes out, and when — invoices, vendor bills and manual dues together"
        actions={canAdd && <>
          <Link href="/r/payables.due/new?direction=receivable"><Button>+ Receivable</Button></Link>
          <Link href="/r/payables.due/new?direction=payable"><Button variant="outline">+ Payable</Button></Link>
        </>} />
      <ErrorBox error={error} />
      {t && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Cash & bank now" value={fmt(t.cash)} tone="blue" />
          <KpiCard label="To receive" value={fmt(t.receivable)} hint={t.overdueReceivable ? `${fmt(t.overdueReceivable)} overdue` : 'nothing overdue'} tone="green" />
          <KpiCard label="To pay" value={fmt(t.payable)} hint={t.overduePayable ? `${fmt(t.overduePayable)} overdue` : 'nothing overdue'} tone="red" />
          <KpiCard label="Projected balance" value={fmt(t.projected)} hint="cash + to receive − to pay" tone={t.projected >= 0 ? 'green' : 'red'} />
        </div>
      )}
      {data && <Forecast weeks={data.forecast} beyond={data.totals.beyondForecast} />}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <Tabs value={view} onChange={setView} tabs={[{ key: 'timeline', label: 'Timeline' }, { key: 'parties', label: 'By party' }, { key: 'aging', label: 'Aging' }]} />
        <Select aria-label="Show" value={dir} onChange={(e) => setDir(e.target.value)} className="mb-2 w-44">
          <option value="">Both sides</option><option value="receivable">Receivables only</option><option value="payable">Payables only</option>
        </Select>
      </div>
      {data && !data.rows.length && <Card><EmptyState title="Nothing outstanding" hint="Add a receivable or payable to start tracking it." /></Card>}

      {data && view === 'timeline' && (
        <div className="space-y-6">
          {BUCKETS.map((b) => {
            const rows = data.rows.filter((r) => r.bucket === b.key);
            if (!rows.length) return null;
            const inn = rows.filter((r) => r.direction === 'receivable').reduce((s, r) => s + r.balance, 0);
            const out = rows.filter((r) => r.direction === 'payable').reduce((s, r) => s + r.balance, 0);
            return (
              <section key={b.key}>
                <h2 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--tone-${b.tone})` }} />
                  {b.label}
                  <span className="font-normal text-muted-foreground">· {rows.length} item{rows.length > 1 ? 's' : ''}{inn ? ` · in ${fmt(inn)}` : ''}{out ? ` · out ${fmt(out)}` : ''}</span>
                </h2>
                <ol className="relative ms-3 space-y-2.5 border-s border-border ps-6">
                  {(open[b.key] ? rows : rows.slice(0, 8)).map((r) => {
                    const inbound = r.direction === 'receivable';
                    const tone = inbound ? 'green' : 'red';
                    return (
                      <li key={`${r.source}:${r.id}`} className="relative">
                        <span className="absolute -start-[1.95rem] top-5 h-3 w-3 rounded-full border-2 border-background" style={{ background: `var(--tone-${b.tone})` }} />
                        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow)] sm:grid-cols-[8rem_1fr_auto_auto]">
                          <div>
                            <div className="font-semibold tabular-nums">{new Date(r.dueDate).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                            <div className="text-xs font-medium" style={{ color: r.daysOverdue > 0 ? 'var(--tone-red)' : r.daysOverdue > -7 ? 'var(--tone-amber)' : 'var(--muted-foreground)' }}>{when(r.daysOverdue)}</div>
                          </div>
                          <Link href={`/r/${r.source}/${r.id}`} className="min-w-0 hover:underline">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: `var(--tone-${tone})`, background: `var(--tone-${tone}-bg)` }}>{inbound ? '↓ IN' : '↑ OUT'}</span>
                              <span className="truncate font-medium">{r.party || '—'}</span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.number} · {SOURCE[r.source] ?? r.source}{r.description ? ` · ${r.description}` : ''}</div>
                          </Link>
                          <div className="text-end">
                            <div className="text-lg font-semibold tabular-nums" style={{ color: `var(--tone-${tone})` }}>{fmt(r.balance)}</div>
                            {r.paid > 0 && (
                              <div className="mt-1 w-28">
                                <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full" style={{ width: `${Math.min(100, (r.paid / r.amount) * 100)}%`, background: `var(--tone-${tone})` }} /></div>
                                <div className="mt-0.5 text-[11px] text-muted-foreground">{fmt(r.paid)} of {fmt(r.amount)} {inbound ? 'received' : 'paid'}</div>
                              </div>
                            )}
                          </div>
                          {canPay && PAY_PATH[r.source] && <Button size="sm" variant="outline" onClick={() => setPaying(r)}>{inbound ? 'Receive' : 'Pay'}</Button>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {rows.length > 8 && (
                  <button type="button" className="ms-9 mt-2 text-sm text-primary hover:underline" onClick={() => setOpen((o) => ({ ...o, [b.key]: !o[b.key] }))}>
                    {open[b.key] ? 'Show fewer' : `Show all ${rows.length}`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}

      {data && view === 'parties' && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(['receivable', 'payable'] as Dir[]).filter((d) => !dir || d === dir).map((d) => {
            const list = data.parties.filter((p) => p.direction === d);
            const total = list.reduce((s, p) => s + p.balance, 0);
            return (
              <Card key={d} title={d === 'receivable' ? 'Who owes us' : 'Whom we owe'} actions={<span className="text-sm font-semibold tabular-nums">{fmt(total)}</span>}>
                {!list.length ? <p className="text-sm text-muted-foreground">Nothing open.</p> : (
                  <ul className="space-y-3">
                    {list.map((p) => (
                      <li key={p.party}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate font-medium">{p.party}</span>
                          <span className="font-semibold tabular-nums">{fmt(p.balance)}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${(p.balance / (list[0].balance || 1)) * 100}%`, background: `var(--tone-${d === 'receivable' ? 'green' : 'red'})` }} /></div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{p.count} open · {p.maxOverdue > 0 ? <span style={{ color: 'var(--tone-red)' }}>oldest {p.maxOverdue} days overdue</span> : `next due ${p.oldest}`}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {data && view === 'aging' && (
        <Card title="Aging (by days past due)">
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-5 py-2 text-start font-medium" />{AGING.map((a) => <th key={a} className="px-3 py-2 text-end font-medium">{a === 'current' ? 'Not yet due' : `${a} days`}</th>)}<th className="px-5 py-2 text-end font-medium">Total</th></tr>
              </thead>
              <tbody>
                {(['receivable', 'payable'] as Dir[]).filter((d) => !dir || d === dir).map((d) => {
                  const row = data.aging[d];
                  const total = AGING.reduce((s, a) => s + (row[a] ?? 0), 0);
                  return (
                    <tr key={d} className="border-b border-border/60">
                      <th className="px-5 py-3 text-start font-medium">{d === 'receivable' ? 'Receivables' : 'Payables'}</th>
                      {AGING.map((a, i) => (
                        <td key={a} className="px-3 py-3 text-end tabular-nums">
                          {row[a] ? <span style={{ color: i >= 3 ? 'var(--tone-red)' : i >= 1 ? 'var(--tone-amber)' : undefined, fontWeight: i >= 3 ? 600 : undefined }}>{fmt(row[a])}</span> : <span className="text-muted-foreground">—</span>}
                          {row[a] && total ? <div className="text-[11px] text-muted-foreground">{Math.round((row[a] / total) * 100)}%</div> : null}
                        </td>
                      ))}
                      <td className="px-5 py-3 text-end font-semibold tabular-nums">{fmt(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Invoices fall due after the company&apos;s credit terms (setting <code>finance.terms.invoiceDays</code>); vendor bills and manual dues use their own due date.</p>
        </Card>
      )}

      {paying && <QuickPay row={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); setN((x) => x + 1); }} />}
    </>
  );
}

/** Next 8 weeks: money in (up) vs out (down) per week, with the running cash balance. */
function Forecast({ weeks, beyond }: { weeks: Week[]; beyond: { in: number; out: number } }) {
  const max = Math.max(1, ...weeks.flatMap((w) => [w.in, w.out]));
  const low = weeks.find((w) => w.balance < 0);
  return (
    <Card title="Cash-flow forecast — next 8 weeks" actions={low ? <span className="text-xs font-medium" style={{ color: 'var(--tone-red)' }}>⚠ Cash goes negative in the week of {new Date(low.start).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</span> : <span className="text-xs text-muted-foreground">Overdue items are expected in week 1</span>}>
      <div className="grid grid-cols-8 gap-2">
        {weeks.map((w) => (
          <div key={w.week} className="flex flex-col items-center text-center" title={`In ${fmt(w.in)} · Out ${fmt(w.out)} · Balance ${fmt(w.balance)}`}>
            <div className="flex h-16 w-full items-end justify-center">
              <div className="w-3/5 rounded-t" style={{ height: `${(w.in / max) * 100}%`, minHeight: w.in ? 3 : 0, background: 'var(--tone-green)' }} />
            </div>
            <div className="h-px w-full bg-border" />
            <div className="flex h-16 w-full items-start justify-center">
              <div className="w-3/5 rounded-b" style={{ height: `${(w.out / max) * 100}%`, minHeight: w.out ? 3 : 0, background: 'var(--tone-red)' }} />
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{w.week === 0 ? 'This week' : new Date(w.start).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</div>
            <div className={cx('text-xs font-semibold tabular-nums', w.balance < 0 && 'text-danger')}>{fmt(w.balance)}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span><span className="me-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--tone-green)' }} />Money in</span>
        <span><span className="me-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--tone-red)' }} />Money out</span>
        <span>Bottom figure = projected cash & bank at the end of that week</span>
        {(beyond.in > 0 || beyond.out > 0) && <span>After 8 weeks: in {fmt(beyond.in)} · out {fmt(beyond.out)}</span>}
      </div>
    </Card>
  );
}

/** Record a (part) payment straight from the timeline: defaults to the full balance, into/from a cash or bank account. */
function QuickPay({ row, onClose, onDone }: { row: Row; onClose(): void; onDone(): void }) {
  const [amount, setAmount] = useState(String(row.balance));
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<{ id: string; code: string; name: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inbound = row.direction === 'receivable';
  useEffect(() => {
    api<{ rows: { id: string; code: string; name: string }[] }>(`r/finance.account?${qs({ pageSize: 100, sort: 'code:asc', filters: { $or: [{ isCash: true }, { isBank: true }], isGroup: false } })}`)
      .then((d) => { setAccounts(d.rows); setAccountId(d.rows[0]?.id ?? ''); }).catch(setError);
  }, []);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await api(PAY_PATH[row.source].replace(':id', row.id), 'POST', { amount: Number(amount), accountId }); onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const n = Number(amount);
  return (
    <Dialog open onClose={onClose} title={inbound ? `Receive from ${row.party}` : `Pay ${row.party}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !accountId || !(n > 0) || n > row.balance} onClick={submit}>{busy ? 'Saving…' : inbound ? 'Record receipt' : 'Record payment'}</Button></>}>
      <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
        <div className="flex justify-between"><span>{row.number} · {SOURCE[row.source]}</span><b className="tabular-nums">{fmt(row.balance)}</b></div>
        <div className="text-xs text-muted-foreground">{when(row.daysOverdue)}{row.paid ? ` · ${fmt(row.paid)} of ${fmt(row.amount)} already ${inbound ? 'received' : 'paid'}` : ''}</div>
      </div>
      <ErrorBox error={error} />
      <div className="space-y-4">
        <div>
          <Label htmlFor="qp-amount" required>Amount</Label>
          <Input id="qp-amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="mt-1 flex gap-3 text-xs">
            <button type="button" className="text-primary hover:underline" onClick={() => setAmount(String(row.balance))}>Full balance</button>
            <button type="button" className="text-primary hover:underline" onClick={() => setAmount(String(Math.round(row.balance * 50) / 100))}>Half</button>
            {n > row.balance && <span style={{ color: 'var(--tone-red)' }}>More than the balance</span>}
            {n > 0 && n < row.balance && <span className="text-muted-foreground">Part payment — {fmt(row.balance - n)} stays open</span>}
          </div>
        </div>
        <div>
          <Label htmlFor="qp-acc" required>{inbound ? 'Received into' : 'Paid from'}</Label>
          <Select id="qp-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}
