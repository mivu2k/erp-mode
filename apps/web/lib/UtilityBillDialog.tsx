'use client';
import { Button, Dialog, ErrorBox, Input, Label } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from './api';

type Preview = { billDate: string; periodFrom: string | null; periodTo: string | null; dueDate: string | null; units: number | null; energyCharge: number; fixedCharge: number; total: number; unit: string | null; tariff: number | null; name: string };
const FIELDS = ['billDate', 'billRef', 'periodFrom', 'periodTo', 'dueDate', 'units', 'energyCharge', 'fixedCharge', 'tax', 'otherCharges', 'arrears', 'lateAmount'] as const;
type Form = Record<(typeof FIELDS)[number], string>;
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** Record a utility bill: grouped fields, suggestions from readings/tariff (as placeholders), and the live total the server will save. */
export function UtilityBillDialog({ id, onClose, onDone }: { id: string; onClose(): void; onDone(): void }) {
  const [f, setF] = useState<Form>(() => ({ ...Object.fromEntries(FIELDS.map((k) => [k, ''])), billDate: new Date().toISOString().slice(0, 10) }) as Form);
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form, v: string) => setF((s) => ({ ...s, [k]: v }));
  // Re-price as the user types (debounced); the server applies the same defaults it will use on save.
  useEffect(() => {
    const t = setTimeout(() => api<Preview>(`utilities/connections/${id}/bill-preview`, 'POST', f).then(setP).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [id, f]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
      await api(`utilities/connections/${id}/bill`, 'POST', body);
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const field = (k: keyof Form, label: string, type: 'date' | 'number' | 'text' = 'number', hint?: string) => (
    <div>
      <Label htmlFor={`ub-${k}`} required={k === 'billDate'}>{label}</Label>
      <Input id={`ub-${k}`} type={type} step={type === 'number' ? '0.01' : undefined} inputMode={type === 'number' ? 'decimal' : undefined} value={f[k]} placeholder={hint ?? ''} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  const sug = (v: string | number | null | undefined) => (v == null || v === '' ? 'auto' : `${typeof v === 'number' ? fmt(v) : v} (auto)`);

  return (
    <Dialog open wide onClose={onClose} title={`Record bill${p ? ` — ${p.name}` : ''}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !f.billDate} onClick={submit}>{busy ? 'Saving…' : `Record bill${p?.total ? ` · ${fmt(p.total)}` : ''}`}</Button></>}>
      <ErrorBox error={error} />
      <div className="grid gap-5 lg:grid-cols-[1fr_15rem]">
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bill</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {field('billDate', 'Bill date', 'date')}
              {field('billRef', 'Provider bill no.', 'text', 'e.g. 0123-4567')}
              {field('dueDate', 'Due date', 'date')}
            </div>
            {!f.dueDate && p?.dueDate && <p className="mt-1 text-xs text-muted-foreground">Due {p.dueDate} if left blank (bill date + due days)</p>}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Billing period & usage</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {field('periodFrom', 'From', 'date')}
              {field('periodTo', 'To', 'date')}
              {field('units', `Units${p?.unit ? ` (${p.unit})` : ''}`, 'number', sug(p?.units))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {!f.periodFrom && p?.periodFrom ? `Period starts ${p.periodFrom} (end of the previous bill). ` : ''}
              {!f.units ? (p?.units != null ? `${fmt(p.units)} units from meter readings in this period.` : 'No readings in this period — enter units or the usage charge.') : ''}
            </p>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Charges</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {field('energyCharge', 'Usage charge', 'number', sug(p && !f.energyCharge ? p.energyCharge : null))}
              {field('fixedCharge', 'Fixed / line rent', 'number', sug(p && !f.fixedCharge ? p.fixedCharge : null))}
              {field('tax', 'Tax')}
              {field('otherCharges', 'Other charges')}
              {field('arrears', 'Arrears')}
              {field('lateAmount', 'Payable after due date')}
            </div>
          </section>
        </div>

        <aside className="h-fit rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <h3 className="mb-3 font-semibold">Bill total</h3>
          <dl className="space-y-1.5">
            <div className="flex justify-between"><dt className="text-muted-foreground">Usage{p?.units != null && p.tariff != null && !f.energyCharge ? ` (${fmt(p.units)} × ${fmt(p.tariff)})` : ''}</dt><dd className="tabular-nums">{fmt(p?.energyCharge)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Fixed</dt><dd className="tabular-nums">{fmt(p?.fixedCharge)}</dd></div>
            {(['tax', 'otherCharges', 'arrears'] as const).filter((k) => Number(f[k])).map((k) => (
              <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k === 'otherCharges' ? 'Other' : k === 'tax' ? 'Tax' : 'Arrears'}</dt><dd className="tabular-nums">{fmt(Number(f[k]))}</dd></div>
            ))}
            <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><dt>Total</dt><dd className="tabular-nums">{fmt(p?.total)}</dd></div>
            {p?.dueDate && <div className="flex justify-between text-xs text-muted-foreground"><dt>Due</dt><dd>{f.dueDate || p.dueDate}</dd></div>}
            {f.lateAmount && <div className="flex justify-between text-xs" style={{ color: 'var(--tone-amber)' }}><dt>After due date</dt><dd className="tabular-nums">{fmt(Number(f.lateAmount))}</dd></div>}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Saving books it as a payable on P &amp; R.</p>
        </aside>
      </div>
    </Dialog>
  );
}
