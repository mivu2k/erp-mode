'use client';
import { Button, Card, cx, ErrorBox, Input, Label, PageHeader, Select, Textarea } from '@erp/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '@/lib/api';
import { prepareImage, uploadFile } from '@/lib/files';
import { can, useMeta } from '@/lib/meta';
import { renderRef } from '@/lib/RefPicker';

interface Line { date: string; headId: string; description: string; amount: string; tax: string; receipt?: File }
interface Advance { id: string; number: string; amount: string; recovered: string; purpose: string | null }
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): Line => ({ date: today(), headId: '', description: '', amount: '', tax: '' });
const n = (v: string) => Number(v) || 0;
const fmt = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Guided expense claim: who, reimburse or settle an advance, expense lines with receipts, live totals — then save or submit. */
export default function NewClaim() {
  const meta = useMeta();
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState<unknown>(meta.user.employeeId);
  const [mode, setMode] = useState<'direct' | 'against_advance'>('direct');
  const [advanceId, setAdvanceId] = useState('');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [heads, setHeads] = useState<{ id: string; name: string }[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [unpaid, setUnpaid] = useState<Advance[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    api<{ receiptThreshold: number; heads: { id: string; name: string }[] }>('finance/claims/policy').then((p) => { setThreshold(p.receiptThreshold); setHeads(p.heads); }).catch(setError);
  }, []);
  // Only this employee's advances that still have money to account for.
  useEffect(() => {
    setAdvances([]); setUnpaid([]); setAdvanceId('');
    if (!employeeId) return;
    const load = (status: string) => api<{ rows: Advance[] }>(`r/finance.advance?${qs({ pageSize: 50, sort: 'createdAt:desc', filters: { employeeId, status } })}`).then((d) => d.rows).catch(() => []);
    load('disbursed').then(setAdvances);
    load('approved').then(setUnpaid); // approved but not paid out yet: shown so the employee knows why it can't be settled
  }, [employeeId]);

  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((s, l) => s + n(l.amount) + n(l.tax), 0);
  const adv = advances.find((a) => a.id === advanceId);
  const outstanding = adv ? n(adv.amount) - n(adv.recovered) : 0;
  const fromAdvance = mode === 'against_advance' ? Math.min(total, outstanding) : 0;
  const needsReceipt = (l: Line) => threshold > 0 && n(l.amount) + n(l.tax) > threshold;
  const problems = useMemo(() => {
    const p: string[] = [];
    if (!employeeId) p.push('Pick the employee');
    if (mode === 'against_advance' && !advanceId) p.push('Pick the advance this claim settles');
    lines.forEach((l, i) => {
      if (!l.headId) p.push(`Line ${i + 1}: choose the expense type`);
      if (!(n(l.amount) > 0)) p.push(`Line ${i + 1}: enter the amount`);
    });
    return p;
  }, [employeeId, mode, advanceId, lines]);
  const missingReceipts = lines.filter((l) => needsReceipt(l) && !l.receipt).length;

  async function save(submit: boolean) {
    setTried(true); setError(null);
    if (problems.length) return;
    if (submit && missingReceipts) return setError(`Attach a receipt to ${missingReceipts} line(s) above ${fmt(threshold)} — or save as draft and add them later.`);
    try {
      setBusy('Saving claim…');
      const body = { employeeId, mode, advanceId: mode === 'against_advance' ? advanceId : null, date, notes, lines: lines.map(({ receipt: _r, ...l }) => ({ ...l, tax: l.tax || '0', description: l.description || null })) };
      const claim = await api<{ id: string; lines: { id: string }[] }>('r/finance.claim', 'POST', body);
      // Receipts go onto the saved claim, then each line points at its receipt.
      if (lines.some((l) => l.receipt)) {
        setBusy('Uploading receipts…');
        const ids = await Promise.all(lines.map(async (l) => (l.receipt ? (await uploadFile('finance.claim', claim.id, await prepareImage(l.receipt))).id : null)));
        await api(`r/finance.claim/${claim.id}`, 'PATCH', { lines: body.lines.map((l, i) => ({ ...l, attachmentId: ids[i] })) });
      }
      if (submit) { setBusy('Submitting for approval…'); await api(`r/finance.claim/${claim.id}/submit`, 'POST'); }
      router.replace(`/r/finance.claim/${claim.id}`);
    } catch (e) { setError(e); setBusy(''); }
  }

  return (
    <div className="pb-24">
      <PageHeader title="New expense claim" subtitle="Claim back what you spent — or account for an advance you were given" />
      <div className="mb-4"><ErrorBox error={error} /></div>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card title="1 · Claim">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label required>What is this claim for?</Label>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
                  {([['direct', 'Reimburse me', 'I paid from my own pocket'], ['against_advance', 'Settle my advance', 'I spent an expense advance I was given']] as const).map(([k, t, d]) => (
                    <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
                      className={cx('rounded-lg border p-3 text-start transition', mode === k ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground')}>
                      <div className="text-sm font-semibold">{t}</div><div className="text-xs text-muted-foreground">{d}</div>
                    </button>
                  ))}
                </div>
              </div>
              {can(meta, 'hrm.employee.view') && meta.user.permissions['finance.claim.create'] !== 'own' ? (
                <div><Label required>Employee</Label>{renderRef({ name: 'employeeId', type: 'string', ref: 'hrm.employee', required: true, label: 'Employee' }, employeeId, setEmployeeId)}</div>
              ) : null}
              <div><Label htmlFor="cdate" required>Claim date</Label><Input id="cdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              {mode === 'against_advance' && (
                <div className="sm:col-span-2">
                  <Label required>Advance</Label>
                  {advances.length ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {advances.map((a) => (
                        <button key={a.id} type="button" onClick={() => setAdvanceId(a.id)} aria-pressed={advanceId === a.id}
                          className={cx('rounded-lg border p-3 text-start text-sm transition', advanceId === a.id ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground')}>
                          <div className="flex justify-between"><b>{a.number}</b><span className="tabular-nums">{fmt(n(a.amount) - n(a.recovered))} left</span></div>
                          <div className="truncate text-xs text-muted-foreground">{a.purpose ?? '—'} · {fmt(n(a.amount))} given</div>
                        </button>
                      ))}
                    </div>
                  ) : !unpaid.length && <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">No open expense advance for this employee — choose “Reimburse me”.</p>}
                  {unpaid.length > 0 && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {unpaid.map((a) => (
                        <div key={a.id} aria-disabled="true" className="rounded-lg border border-dashed border-border p-3 text-sm opacity-80">
                          <div className="flex justify-between"><b>{a.number}</b><span className="tabular-nums">{fmt(n(a.amount))}</span></div>
                          <div className="text-xs text-amber-600 dark:text-amber-400">Approved — not paid out yet. Finance must disburse it before you can settle it.</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="sm:col-span-2"><Label htmlFor="cnotes">Purpose</Label><Textarea id="cnotes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Site visit to Lahore, 12–14 Sep" /></div>
            </div>
          </Card>

          <Card title={`2 · Expenses (${lines.length})`}>
            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-[8.5rem_1fr_1.4fr]">
                    <div><Label htmlFor={`d${i}`}>Date</Label><Input id={`d${i}`} type="date" value={l.date} onChange={(e) => set(i, { date: e.target.value })} /></div>
                    <div><Label htmlFor={`h${i}`} required>Type</Label>
                      <Select id={`h${i}`} value={l.headId} onChange={(e) => set(i, { headId: e.target.value })} className={cx(tried && !l.headId && 'border-danger')}>
                        <option value="">Choose…</option>{heads.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                      </Select>
                    </div>
                    <div><Label htmlFor={`ds${i}`}>Description</Label><Input id={`ds${i}`} value={l.description} placeholder="Where / what for" onChange={(e) => set(i, { description: e.target.value })} /></div>
                  </div>
                  <div className="mt-3 grid items-end gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
                    <div><Label htmlFor={`a${i}`} required>Amount</Label><Input id={`a${i}`} type="number" min={0} step="0.01" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} className={cx(tried && !(n(l.amount) > 0) && 'border-danger')} /></div>
                    <div><Label htmlFor={`t${i}`}>Tax</Label><Input id={`t${i}`} type="number" min={0} step="0.01" inputMode="decimal" value={l.tax} placeholder="0" onChange={(e) => set(i, { tax: e.target.value })} /></div>
                    <div>
                      <Label>Receipt{needsReceipt(l) && <span className="ms-1 text-xs font-normal" style={{ color: 'var(--tone-amber)' }}>required above {fmt(threshold)}</span>}</Label>
                      <label className={cx('flex h-10 cursor-pointer items-center gap-2 truncate rounded-lg border border-dashed px-3 text-sm transition hover:border-primary', l.receipt ? 'border-primary text-foreground' : needsReceipt(l) ? 'border-[var(--tone-amber)] text-muted-foreground' : 'border-border text-muted-foreground')}>
                        {l.receipt ? `📎 ${l.receipt.name}` : '+ Photo or PDF'}
                        <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" aria-label={`Receipt for line ${i + 1}`} onChange={(e) => { set(i, { receipt: e.target.files?.[0] }); e.target.value = ''; }} />
                      </label>
                    </div>
                    <div className="flex gap-1 pb-1">
                      <Button size="sm" variant="ghost" title="Duplicate line" onClick={() => setLines((ls) => [...ls.slice(0, i + 1), { ...l, receipt: undefined, amount: '', description: '' }, ...ls.slice(i + 1)])}>⧉</Button>
                      {lines.length > 1 && <Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</Button>}
                    </div>
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => setLines((ls) => [...ls, { ...blank(), date: ls.at(-1)?.date ?? today() }])} className="w-full rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground transition hover:border-primary hover:text-primary">+ Add expense</button>
            </div>
          </Card>
        </div>

        <Card title="Summary" className="lg:sticky lg:top-20">
          <dl className="space-y-2 text-sm">
            {lines.filter((l) => n(l.amount)).map((l, i) => (
              <div key={i} className="flex justify-between gap-3 text-muted-foreground"><dt className="truncate">{heads.find((h) => h.id === l.headId)?.name ?? 'Expense'}{l.description ? ` · ${l.description}` : ''}</dt><dd className="tabular-nums">{fmt(n(l.amount) + n(l.tax))}</dd></div>
            ))}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total claimed</dt><dd className="tabular-nums">{fmt(total)}</dd></div>
            {mode === 'against_advance' && adv && <>
              <div className="flex justify-between"><dt className="text-muted-foreground">Covered by {adv.number}</dt><dd className="tabular-nums">− {fmt(fromAdvance)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>{total > outstanding ? 'Company pays you' : 'You return'}</dt><dd className="tabular-nums" style={{ color: total > outstanding ? 'var(--tone-green)' : 'var(--tone-amber)' }}>{fmt(Math.abs(total - outstanding))}</dd></div>
            </>}
            {mode === 'direct' && <div className="flex justify-between font-semibold"><dt>Company pays you</dt><dd className="tabular-nums" style={{ color: 'var(--tone-green)' }}>{fmt(total)}</dd></div>}
          </dl>
          {tried && problems.length > 0 && <ul className="mt-3 space-y-1 text-xs text-danger" role="alert">{problems.map((p) => <li key={p}>• {p}</li>)}</ul>}
          {missingReceipts > 0 && <p className="mt-3 text-xs" style={{ color: 'var(--tone-amber)' }}>{missingReceipts} line(s) need a receipt before submitting.</p>}
          <p className="mt-3 text-xs text-muted-foreground">After approval, finance prepares a reimbursement voucher; you can follow it on the claim.</p>
        </Card>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur lg:start-60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-muted-foreground">{busy || `${lines.length} expense${lines.length > 1 ? 's' : ''} · total ${fmt(total)}`}</span>
          <span className="flex gap-2">
            <Button variant="outline" disabled={!!busy} onClick={() => save(false)}>Save draft</Button>
            <Button disabled={!!busy} onClick={() => save(true)}>Submit for approval</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
