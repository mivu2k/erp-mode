'use client';
import { Button, Card, ErrorBox, Input, Label, PageHeader } from '@erp/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { RefPicker } from '@/lib/RefPicker';

interface Line { accountId: unknown; debit: string; credit: string; memo: string }
const blank = (): Line => ({ accountId: null, debit: '', credit: '', memo: '' });
const n = (v: string) => Number(v) || 0;
const fmt = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Manual journal: opening balances, corrections, depreciation. Debits must equal credits before it can post. */
export default function NewJournal() {
  const router = useRouter();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dr = lines.reduce((t, l) => t + n(l.debit), 0);
  const cr = lines.reduce((t, l) => t + n(l.credit), 0);
  const balanced = dr > 0 && Math.round(dr * 100) === Math.round(cr * 100);
  const set = (i: number, x: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...x } : l)));
  const post = async () => {
    setBusy(true); setError(null);
    try {
      const je = await api<{ id: string }>('finance/journal', 'POST', { date, memo, lines: lines.filter((l) => l.accountId && (n(l.debit) || n(l.credit))).map((l) => ({ accountId: l.accountId, debit: n(l.debit), credit: n(l.credit), memo: l.memo || undefined })) });
      router.replace(`/r/finance.journal/${je.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="New journal entry" subtitle="Opening balances, corrections, depreciation — debits must equal credits" actions={<Button disabled={!balanced || !memo.trim() || busy} onClick={post}>{busy ? 'Posting…' : 'Post to ledger'}</Button>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div><Label htmlFor="d">Date</Label><Input id="d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><Label htmlFor="m">What is this entry for</Label><Input id="m" value={memo} placeholder="e.g. Opening balances 1 July" onChange={(e) => setMemo(e.target.value)} /></div>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-2 text-start font-medium">Account</th><th className="w-36 py-2 text-end font-medium">Debit</th><th className="w-36 py-2 text-end font-medium">Credit</th><th className="py-2 text-start font-medium">Note</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-border/60">
                <td className="py-1.5 pe-2"><RefPicker f={{ name: 'accountId', type: 'string', ref: 'finance.account', label: `Account ${i + 1}`, filters: { isGroup: false } }} value={l.accountId} onChange={(v) => set(i, { accountId: v })} /></td>
                <td className="py-1.5 pe-2"><Input aria-label={`Debit ${i + 1}`} type="number" min={0} step="0.01" className="text-end" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
                <td className="py-1.5 pe-2"><Input aria-label={`Credit ${i + 1}`} type="number" min={0} step="0.01" className="text-end" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
                <td className="py-1.5 pe-2"><Input aria-label={`Note ${i + 1}`} value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} /></td>
                <td className="py-1.5">{lines.length > 2 && <Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="py-2"><Button size="sm" variant="outline" onClick={() => setLines([...lines, blank()])}>+ Line</Button></td>
              <td className="py-2 pe-2 text-end tabular-nums">{fmt(dr)}</td><td className="py-2 pe-2 text-end tabular-nums">{fmt(cr)}</td>
              <td colSpan={2} className="py-2 text-sm font-normal" style={{ color: balanced ? 'var(--tone-green)' : 'var(--tone-red)' }} role="status">{balanced ? 'Balanced' : dr || cr ? `Out by ${fmt(Math.abs(dr - cr))}` : 'Enter debits and credits'}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </>
  );
}
