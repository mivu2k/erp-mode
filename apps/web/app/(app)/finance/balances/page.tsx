'use client';
import { Button, Card, Dialog, EmptyState, ErrorBox, Input, Label, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, openDoc } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

interface Row { id: string; code: string; name: string; kind: string; confirmedAmount: number | null; confirmedOn: string | null; moneyIn: number; moneyOut: number; balance: number }
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Cash & bank balances: each account starts from a balance you confirm (counted cash, bank statement) and adds
 * what the app recorded after it — accurate even though not every rupee goes through the app.
 */
export default function Balances() {
  const meta = useMeta();
  const [d, setD] = useState<{ rows: Row[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const load = useCallback(() => api<{ rows: Row[]; total: number }>('finance/cash-balances').then(setD).catch(setError), []);
  useEffect(() => { load(); }, [load]);
  const canSet = can(meta, 'finance.account.update');

  return (
    <>
      <PageHeader title="Cash & bank balances" subtitle="Each balance starts from the figure you last confirmed — counted cash or the bank statement — plus what was recorded here since"
        actions={<><Button variant="outline" onClick={() => openDoc('finance/cash-balances?format=html').catch(setError)}>Print / PDF</Button><Button variant="outline" onClick={() => openDoc('finance/cash-balances?format=xlsx').catch(setError)}>Excel</Button></>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <Card>
        {d && !d.rows.length ? <EmptyState title="No cash or bank accounts" hint="Mark an account as Cash or Bank in the Chart of Accounts." /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>{['Account', 'Confirmed balance', 'Recorded since: in', 'out', 'Balance now', ''].map((h, i) => <th key={i} className={`px-3 py-2 font-medium ${i === 0 ? 'ps-5 text-start' : 'text-end'} ${i === 5 ? 'pe-5' : ''}`}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {d?.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="px-3 py-2.5 ps-5"><Link className="font-medium hover:underline" href={`/r/finance.account/${r.id}`}>{r.name}</Link><div className="text-xs text-muted-foreground">{r.code} · {r.kind}</div></td>
                    <td className="px-3 py-2.5 text-end tabular-nums">{r.confirmedAmount != null ? <>{fmt(r.confirmedAmount)}<div className="text-xs text-muted-foreground">on {r.confirmedOn}</div></> : <span className="text-xs" style={{ color: 'var(--tone-amber)' }}>not confirmed yet</span>}</td>
                    <td className="px-3 py-2.5 text-end tabular-nums" style={{ color: 'var(--tone-green)' }}>{r.moneyIn ? `+${fmt(r.moneyIn)}` : '—'}</td>
                    <td className="px-3 py-2.5 text-end tabular-nums" style={{ color: 'var(--tone-red)' }}>{r.moneyOut ? `−${fmt(r.moneyOut)}` : '—'}</td>
                    <td className="px-3 py-2.5 text-end text-base font-semibold tabular-nums">{fmt(r.balance)}</td>
                    <td className="px-3 py-2.5 pe-5 text-end">{canSet && <Button size="sm" variant="outline" onClick={() => setEdit(r)}>Set balance</Button>}</td>
                  </tr>
                ))}
              </tbody>
              {d && d.rows.length > 1 && <tfoot><tr className="border-t border-border font-semibold"><td className="px-3 py-2.5 ps-5" colSpan={4}>Total cash & bank</td><td className="px-3 py-2.5 text-end text-base tabular-nums">{fmt(d.total)}</td><td /></tr></tfoot>}
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Count the cash or check the bank statement now and then, and set the balance: from that date on, the figure here stays right.</p>
      </Card>
      {edit && <SetBalance row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </>
  );
}

function SetBalance({ row, onClose, onDone }: { row: Row; onClose(): void; onDone(): void }) {
  const [amount, setAmount] = useState(String(row.balance));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<unknown>(null);
  const save = () => api(`finance/accounts/${row.id}/confirm-balance`, 'POST', { amount: Number(amount), date }).then(onDone).catch(setError);
  return (
    <Dialog open onClose={onClose} title={`Set balance — ${row.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={amount === '' || isNaN(Number(amount))} onClick={save}>Save balance</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{row.kind === 'Bank' ? 'The balance on your bank statement' : 'The cash you counted'}, at the end of the day you pick. Movements recorded here after that day are added on top.</p>
        <ErrorBox error={error} />
        <div><Label htmlFor="sb-amt">Actual balance</Label><Input id="sb-amt" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><Label htmlFor="sb-date">As of (end of day)</Label><Input id="sb-date" type="date" max={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
    </Dialog>
  );
}
