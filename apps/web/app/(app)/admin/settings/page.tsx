'use client';
import { Button, Card, ErrorBox, humanize, Input, PageHeader, Switch, Textarea } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { RefPicker } from '@/lib/RefPicker';

type V = unknown;
/** Plain titles and what each setting does; anything not listed still shows, with a humanized name. */
const INFO: Record<string, [string, string?]> = {
  'finance.accounts': ['Accounts used by automatic postings', 'Which ledger account sales, purchases, payroll and payments post to.'],
  'finance.claims': ['Expense claims', 'Receipt threshold: lines above this amount need a receipt (0 = receipts optional).'],
  'finance.terms': ['Credit terms', 'Invoices fall due this many days after their date.'],
  'hrm.payroll': ['Payroll rules'],
  'hrm.kiosk': ['Attendance kiosk', 'How often the kiosk QR code changes.'],
  'inventory.allowNegative': ['Allow stock to go below zero'],
  'catalog.about': ['Company profile for brochures', 'One entry per line. Highlights "Label: value"; locations "Name | address | phone | email".'],
  serials: ['Serial numbers', 'Warranty for sold units when the product has none of its own.'],
  'repair.discountLimit': ['Repair discount limit', 'Quotations with a bigger discount need approval first.'],
  'repair.transitions': ['Repair job statuses', 'From each status, which statuses a job may move to next.'],
  'fleet.fuelHeadId': ['Fuel expense type', 'Fuel entries become expense claims of this type.'],
  files: ['File uploads', 'Largest file in MB and the allowed file kinds.'],
  auth: ['Sign-in protection', 'Lock an account for some minutes after this many wrong passwords.'],
  sms: ['SMS / WhatsApp gateway'],
  smtp: ['Email (SMTP)', 'The mail server used to send emails.'],
  jobs: ['Background jobs', 'Hour of the nightly run and reminder days before expiry.'],
};
const LONG = new Set(['intro', 'mission', 'highlights', 'certifications', 'locations', 'customCss', 'customHtml']);
const SECRET = new Set(['pass', 'token']);

/** One value as a field: account / expense-type pickers, numbers, switches, lists as comma text, long text boxes. */
function Field({ setting, name, value, onChange }: { setting: string; name: string; value: V; onChange(v: V): void }) {
  const id = `${setting}.${name}`;
  if (setting === 'finance.accounts') return <RefPicker f={{ name, type: 'string', ref: 'finance.account', label: humanize(name) }} value={value} onChange={onChange} />;
  if (setting === 'fleet.fuelHeadId') return <RefPicker f={{ name, type: 'string', ref: 'core.masterdata', filters: { type: 'expense_head' }, label: 'Expense type' }} value={value} onChange={onChange} />;
  if (typeof value === 'boolean') return <Switch checked={value} onChange={onChange} label={humanize(name)} />;
  if (typeof value === 'number') return <Input id={id} type="number" step="any" value={String(value)} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  if (Array.isArray(value)) return <Input id={id} value={value.join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (typeof value[0] === 'number' && !isNaN(Number(x)) ? Number(x) : x)))} />;
  if (LONG.has(name)) return <Textarea id={id} rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  return <Input id={id} type={SECRET.has(name) ? 'password' : 'text'} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}

/** Every tunable business rule as a plain form (no JSON): accounts by name, numbers, switches, lists. */
export default function Settings() {
  const [s, setS] = useState<Record<string, V>>({});
  const [msg, setMsg] = useState<Record<string, unknown>>({});
  useEffect(() => { api<Record<string, V>>('admin/settings').then(setS); }, []);
  const save = async (k: string) => {
    try { await api(`admin/settings/${k}`, 'PUT', { value: s[k] }); setMsg((m) => ({ ...m, [k]: 'Saved' })); } catch (e) { setMsg((m) => ({ ...m, [k]: e })); }
  };
  const set = (k: string, v: V) => { setS({ ...s, [k]: v }); setMsg((m) => ({ ...m, [k]: null })); };
  return (
    <>
      <PageHeader title="System settings" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {Object.entries(s).map(([k, v]) => {
          const [title, hint] = INFO[k] ?? [humanize(k.replace(/\./g, ' '))];
          const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, V>) : null;
          return (
            <Card key={k} title={<span>{title}{hint && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{hint}</span>}</span>}
              actions={<Button size="sm" onClick={() => save(k)}>Save</Button>}>
              <div className="space-y-3 text-sm">
                {obj ? Object.entries(obj).map(([name, x]) => (
                  <div key={name}>
                    {typeof x !== 'boolean' && <label htmlFor={`${k}.${name}`} className="mb-1 block text-xs text-muted-foreground">{k === 'repair.transitions' ? `From ${humanize(name)} to` : humanize(name)}</label>}
                    <Field setting={k} name={name} value={x} onChange={(nv) => set(k, { ...obj, [name]: nv })} />
                  </div>
                )) : <Field setting={k} name={k.split('.').pop()!} value={v} onChange={(nv) => set(k, nv)} />}
              </div>
              <div className="mt-2"><ErrorBox error={msg[k] === 'Saved' ? null : msg[k]} />{msg[k] === 'Saved' && <span role="status" className="text-xs" style={{ color: 'var(--tone-green)' }}>Saved</span>}</div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
