'use client';
import { Button, Card, ErrorBox, Input, Label, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { RefPicker } from '@/lib/RefPicker';

/** Record a plain expense (rent, office costs…) paid from cash or bank — one form, posted straight to the ledger. */
export default function RecordExpense() {
  const empty = { date: new Date().toISOString().slice(0, 10), expenseAccountId: null as unknown, paidFromId: null as unknown, vendorId: null as unknown, amount: '', memo: '', reference: '' };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ id: string; number: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { setDone(await api<{ id: string; number: string }>('finance/expense', 'POST', { ...f, amount: Number(f.amount), vendorId: f.vendorId || null, reference: f.reference || undefined })); setF({ ...empty, date: f.date, paidFromId: f.paidFromId }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Record an expense" subtitle="Rent, office costs, repairs… paid from cash or bank. Expenses by employees go through expense claims." />
      <div className="mb-3"><ErrorBox error={error} /></div>
      {done && <p role="status" className="mb-3 rounded-md px-3 py-2 text-sm" style={{ color: 'var(--tone-green)', background: 'var(--tone-green-bg)' }}>Recorded as <Link className="underline" href={`/r/finance.journal/${done.id}`}>{done.number}</Link>. Enter the next one below.</p>}
      <Card>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <div><Label htmlFor="d">Date</Label><Input id="d" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
          <div><Label htmlFor="a">Amount</Label><Input id="a" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div><Label>Expense (what it was)</Label><RefPicker f={{ name: 'expenseAccountId', type: 'string', ref: 'finance.account', label: 'Expense account', filters: { type: 'expense', isGroup: false } }} value={f.expenseAccountId} onChange={(v) => setF({ ...f, expenseAccountId: v })} /></div>
          <div><Label>Paid from</Label><RefPicker f={{ name: 'paidFromId', type: 'string', ref: 'finance.account', label: 'Paid from', filters: { $or: [{ isCash: true }, { isBank: true }] } }} value={f.paidFromId} onChange={(v) => setF({ ...f, paidFromId: v })} /></div>
          <div><Label>Paid to (vendor, optional)</Label><RefPicker f={{ name: 'vendorId', type: 'string', ref: 'purchase.vendor', label: 'Vendor' }} value={f.vendorId} onChange={(v) => setF({ ...f, vendorId: v })} /></div>
          <div><Label htmlFor="r">Receipt / reference no.</Label><Input id="r" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label htmlFor="m">What for</Label><Input id="m" value={f.memo} placeholder="e.g. Office rent — November" onChange={(e) => setF({ ...f, memo: e.target.value })} /></div>
        </div>
        <div className="mt-4"><Button disabled={busy || !f.expenseAccountId || !f.paidFromId || !(Number(f.amount) > 0) || !f.memo.trim()} onClick={save}>{busy ? 'Saving…' : 'Record expense'}</Button></div>
      </Card>
    </>
  );
}
