'use client';
import { Button, cx, EmptyState, ErrorBox, Input, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, openDoc } from '@/lib/api';

interface Acc { id: string; code: string; name: string; type: string; parentId: string | null; isCash: boolean; isBank: boolean; isGroup: boolean; employeeId: string | null; balance: string | number; lastActivity: string | null }
interface LedgerRow { date: string; voucher: string; memo: string; debit: number | ''; credit: number | ''; balance: number }

const TYPES: [string, string][] = [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equity'], ['income', 'Income'], ['expense', 'Expenses']];
/** Assets and expenses grow with debits; the rest with credits — show every balance the way an accountant reads it. */
const natural = (type: string, v: number) => (type === 'asset' || type === 'expense' ? v : -v);
const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const Amt = ({ v, strong }: { v: number; strong?: boolean }) => (
  <span className={cx('tabular-nums', strong && 'font-semibold', v < 0 && 'text-red-600 dark:text-red-400', !v && 'text-muted-foreground')}>{v ? money(v) : '—'}</span>
);

export default function ChartOfAccountsPage() {
  const [all, setAll] = useState<Acc[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'cash' | 'active'>('all');
  const [staff, setStaff] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Acc | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);

  useEffect(() => { api<Acc[]>('finance/accounts/chart').then(setAll).catch(setError); }, []);
  useEffect(() => {
    setLedger(null);
    if (sel) api<{ rows: LedgerRow[] }>(`finance/ledger/${sel.id}`).then((d) => setLedger(d.rows.slice(1).slice(-15).reverse())).catch(setError);
  }, [sel]);

  // Balances roll up the parent chain, so a group shows the total of everything under it (employee sub-ledgers included).
  const { kids, total } = useMemo(() => {
    const byId = new Map(all.map((a) => [a.id, a]));
    const kids = new Map<string | null, Acc[]>();
    const total = new Map<string, number>();
    for (const a of all) {
      const p = a.parentId && byId.has(a.parentId) ? a.parentId : null;
      kids.set(p, [...(kids.get(p) ?? []), a]);
      for (let c: Acc | undefined = a, guard = 0; c && guard < 20; c = c.parentId ? byId.get(c.parentId) : undefined, guard++) total.set(c.id, (total.get(c.id) ?? 0) + Number(a.balance));
    }
    return { kids, total };
  }, [all]);
  const bal = (a: Acc) => natural(a.type, total.get(a.id) ?? 0);

  const match = (a: Acc) => (!q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase()))
    && (filter !== 'cash' || a.isCash || a.isBank) && (filter !== 'active' || Math.abs(total.get(a.id) ?? 0) > 0.004)
    && (staff || !a.employeeId || !!q);
  // A row shows if it matches or anything below it does, so search keeps the tree readable.
  const visible = useMemo(() => {
    const v = new Set<string>();
    const walk = (a: Acc): boolean => { const sub = (kids.get(a.id) ?? []).map(walk).some(Boolean); if (sub || match(a)) v.add(a.id); return v.has(a.id); };
    (kids.get(null) ?? []).forEach(walk);
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, q, filter, staff, total]);
  const searching = !!q || filter !== 'all';
  const hiddenStaff = (a: Acc) => (staff || q ? 0 : (kids.get(a.id) ?? []).filter((c) => c.employeeId).length);

  const rows = (list: Acc[], depth: number): ReactNode => list.filter((a) => visible.has(a.id)).map((a) => {
    const sub = (kids.get(a.id) ?? []).filter((c) => visible.has(c.id));
    const open = searching || !closed.has(a.id);
    const n = hiddenStaff(a);
    return (
      <Fragment key={a.id}>
        <tr onClick={() => setSel(a)} className={cx('cursor-pointer border-b border-border/50 hover:bg-muted/40', sel?.id === a.id && 'bg-primary/10')}>
          <td className="py-1.5 pe-3 ps-4 font-mono text-xs text-muted-foreground">{a.code}</td>
          <td className="py-1.5 pe-3" style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
            <span className="inline-flex items-center gap-1">
              {sub.length ? (
                <button type="button" aria-label={open ? `Collapse ${a.name}` : `Expand ${a.name}`} aria-expanded={open} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted"
                  onClick={(e) => { e.stopPropagation(); setClosed((c) => { const x = new Set(c); if (x.has(a.id)) x.delete(a.id); else x.add(a.id); return x; }); }}>{open ? '▾' : '▸'}</button>
              ) : <span className="size-5" />}
              <span className={cx(sub.length || a.isGroup ? 'font-semibold' : '')}>{a.name}</span>
              {a.isCash && <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">Cash</span>}
              {a.isBank && <span className="rounded bg-sky-500/15 px-1.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">Bank</span>}
              {n > 0 && <span className="whitespace-nowrap text-[11px] text-muted-foreground">+{n} employee account{n === 1 ? '' : 's'}</span>}
            </span>
          </td>
          <td className="py-1.5 pe-3 text-end text-xs text-muted-foreground">{a.lastActivity ? String(a.lastActivity).slice(0, 10) : ''}</td>
          <td className="py-1.5 pe-4 text-end"><Amt v={bal(a)} strong={!!sub.length} /></td>
        </tr>
        {open && rows(sub, depth + 1)}
      </Fragment>
    );
  });

  const typeTotal = (t: string) => (kids.get(null) ?? []).filter((a) => a.type === t).reduce((s, a) => s + bal(a), 0);
  const chip = (k: typeof filter, l: string) => (
    <button type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
      className={cx('rounded-full border px-3 py-1 text-xs', filter === k ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>{l}</button>
  );

  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle={`${all.length} accounts · balances from all posted journals`}
        actions={<div className="flex gap-2"><Link href="/finance/reports"><Button variant="outline">Trial balance</Button></Link><Link href="/r/finance.account/new"><Button>New account</Button></Link></div>} />
      <ErrorBox error={error} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {TYPES.map(([t, l]) => (
          <div key={t} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{l}</div>
            <div className="text-lg"><Amt v={typeTotal(t)} strong /></div>
          </div>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Find account" placeholder="Find by code or name…" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-full text-sm sm:w-64" />
        {chip('all', 'All')}{chip('cash', 'Cash & bank')}{chip('active', 'With balance')}
        <label className="ms-1 flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={staff} onChange={(e) => setStaff(e.target.checked)} /> Employee accounts</label>
        <div className="ms-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setClosed(new Set())}>Expand all</Button>
          <Button size="sm" variant="ghost" onClick={() => setClosed(new Set(all.filter((a) => kids.get(a.id)?.length).map((a) => a.id)))}>Collapse all</Button>
        </div>
      </div>

      <div className={cx('grid items-start gap-4', sel && 'xl:grid-cols-[1fr_24rem]')}>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          {!visible.size && all.length > 0 ? <EmptyState title="No account matches" /> : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-border bg-card text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="w-24 py-2 pe-3 ps-4 text-start font-medium">Code</th><th className="py-2 pe-3 text-start font-medium">Account</th><th className="w-28 py-2 pe-3 text-end font-medium">Last entry</th><th className="w-40 py-2 pe-4 text-end font-medium">Balance</th></tr>
              </thead>
              {TYPES.map(([t, l]) => {
                const top = (kids.get(null) ?? []).filter((a) => a.type === t);
                if (!top.some((a) => visible.has(a.id))) return null;
                return (
                  <tbody key={t}>
                    <tr className="bg-muted/50"><td colSpan={3} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider">{l}</td><td className="py-1.5 pe-4 text-end text-xs"><Amt v={typeTotal(t)} strong /></td></tr>
                    {rows(top, 0)}
                  </tbody>
                );
              })}
            </table>
          )}
        </div>

        {sel && (
          <aside className="rounded-lg border border-border bg-card p-4 xl:sticky xl:top-20" aria-label="Account details">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-mono text-xs text-muted-foreground">{sel.code} · {TYPES.find(([t]) => t === sel.type)?.[1] ?? sel.type}</div>
                <h2 className="text-base font-semibold">{sel.name}</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSel(null)} className="rounded px-1.5 text-muted-foreground hover:bg-muted">✕</button>
            </div>
            <div className="mt-2 text-2xl"><Amt v={bal(sel)} strong /></div>
            {(kids.get(sel.id)?.length ?? 0) > 0 && <p className="text-xs text-muted-foreground">Includes {kids.get(sel.id)!.length} sub-account(s)</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/r/finance.account/${sel.id}`}><Button size="sm" variant="outline">Edit</Button></Link>
              <Button size="sm" variant="outline" onClick={() => openDoc(`finance/ledger/${sel.id}?format=xlsx`).catch(setError)}>Ledger (Excel)</Button>
              <Button size="sm" variant="outline" onClick={() => openDoc(`finance/ledger/${sel.id}?format=pdf`).catch(setError)}>PDF</Button>
            </div>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent entries</h3>
            {!ledger ? <p className="mt-2 text-sm text-muted-foreground">Loading…</p> : !ledger.length ? <p className="mt-2 text-sm text-muted-foreground">No entries on this account itself.</p> : (
              <ul className="mt-1 divide-y divide-border/60 text-sm">
                {ledger.map((l, i) => (
                  <li key={i} className="flex items-baseline gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{l.memo || l.voucher}</div>
                      <div className="text-[11px] text-muted-foreground">{l.date} · {l.voucher}</div>
                    </div>
                    <span className={cx('tabular-nums', l.debit ? '' : 'text-red-600 dark:text-red-400')}>{l.debit ? `+${money(Number(l.debit))}` : `−${money(Number(l.credit))}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
