'use client';
import { RichText } from './RichText';
import { ReactNode, useState } from 'react';
import { Button, cx, Input, Label, Select, Switch, Textarea } from './primitives';

export interface FieldMeta { name: string; type: string; required?: boolean; options?: string[]; ref?: string; readonly?: boolean; restricted?: boolean; label?: string; filters?: Record<string, unknown> }
/** `refs` = titles already known for this row's foreign keys (from the API's `_refs`). */
export type RefRenderer = (f: FieldMeta, value: unknown, onChange: (v: unknown) => void, refs?: Record<string, string | null>) => ReactNode;

/** Short codes that read better spelled out (option values, field names). */
const WORDS: Record<string, string> = { nfc: 'NFC card', qr: 'QR code', rotating_qr: 'Rotating QR (on screen)', ipWhitelist: 'IP whitelist', radiusM: 'Radius (m)', lat: 'Latitude', lng: 'Longitude' };
export const humanize = (s: string) => WORDS[s] ?? s.replace(/Id$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

const toInput = (type: string, v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (type === 'date') return String(v).slice(0, 10);
  if (type === 'datetime') {
    const d = new Date(String(v));
    return isNaN(+d) ? '' : new Date(+d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  return String(v);
};

/** One input for any schema field type. */
export function FieldInput({ f, value, onChange, renderRef, disabled, refs }: { f: FieldMeta; value: unknown; onChange(v: unknown): void; renderRef?: RefRenderer; disabled?: boolean; refs?: Record<string, string | null> }) {
  const [jsonText, setJsonText] = useState(() => (value === undefined || value === null ? '' : JSON.stringify(value, null, 2)));
  const [jsonErr, setJsonErr] = useState(false);
  const ro = disabled || f.readonly;
  // Every input gets an accessible name, including cells in line tables that have no visible <label>.
  const aria = f.label ?? humanize(f.name);
  if (f.ref && renderRef && !ro) return <>{renderRef(f, value, onChange, refs)}</>;
  // File fields render through the app's renderer too (upload needs record context), also when read-only (preview).
  if ((f.type === 'file' || f.type === 'files') && renderRef) return <>{renderRef({ ...f, readonly: ro }, value, onChange, refs)}</>;
  if (f.ref && ro && refs?.[f.name]) return <Input id={f.name} aria-label={aria} value={refs[f.name] ?? ''} disabled />;
  switch (f.type) {
    case 'bool':
      return <Switch id={f.name} checked={!!value} disabled={ro} onChange={onChange} label={<span className="sr-only">{aria}</span>} />;
    case 'enum':
      return (
        <Select id={f.name} aria-label={aria} value={String(value ?? '')} disabled={ro} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {f.options?.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
        </Select>
      );
    case 'richtext':
      return <RichText id={f.name} value={String(value ?? '')} disabled={ro} onChange={(v) => onChange(v)} />;
    case 'text':
      return <Textarea id={f.name} aria-label={aria} value={String(value ?? '')} disabled={ro} onChange={(e) => onChange(e.target.value)} />;
    case 'json':
      // A list with fixed options (e.g. a kiosk station's punch methods) picks them as toggle chips.
      if (f.options?.length) {
        const on = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div role="group" aria-label={aria} className="flex flex-wrap gap-1.5">
            {f.options.map((o) => (
              <button key={o} type="button" aria-pressed={on.includes(o)} disabled={ro} onClick={() => onChange(on.includes(o) ? on.filter((x) => x !== o) : [...on, o])}
                className={cx('rounded-full border px-3 py-1 text-sm transition disabled:opacity-60', on.includes(o) ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {on.includes(o) ? '✓ ' : ''}{humanize(o)}
              </button>
            ))}
          </div>
        );
      }
      // A plain list of strings (accessories, tags) edits as comma-separated text.
      if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
        return <Input id={f.name} aria-label={aria} value={(value as string[]).join(', ')} disabled={ro} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trimStart()).filter((x, i, a) => x || i === a.length - 1))} />;
      }
      return (
        <div>
          <Textarea id={f.name} aria-label={aria} className="font-mono text-xs" rows={4} value={jsonText} disabled={ro}
            onChange={(e) => setJsonText(e.target.value)}
            onBlur={() => {
              try { onChange(jsonText.trim() ? JSON.parse(jsonText) : null); setJsonErr(false); } catch { setJsonErr(true); }
            }} />
          {jsonErr && <p className="mt-1 text-xs text-danger">Invalid JSON</p>}
        </div>
      );
    case 'int': case 'float': case 'money': case 'decimal':
      return <Input id={f.name} aria-label={aria} type="number" inputMode="decimal" step={f.type === 'int' ? 1 : 'any'} value={toInput(f.type, value)} disabled={ro} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} className="tabular-nums" />;
    case 'date':
      return <Input id={f.name} aria-label={aria} type="date" value={toInput('date', value)} disabled={ro} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime':
      return <Input id={f.name} aria-label={aria} type="datetime-local" value={toInput('datetime', value)} disabled={ro} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    default:
      return <Input id={f.name} aria-label={aria} value={String(value ?? '')} disabled={ro} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Metadata-driven form grid: text areas span the row, switches sit inline with their label. */
export function FormGrid({ fields, values, onChange, renderRef, disabled, columns = 3 }: { fields: FieldMeta[]; values: Record<string, unknown>; onChange(name: string, v: unknown): void; renderRef?: RefRenderer; disabled?: boolean; columns?: 1 | 3 }) {
  return (
    <div className={columns === 1 ? 'grid gap-y-4' : 'grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3'}>
      {fields.map((f) => (
        <div key={f.name} className={f.type === 'text' || f.type === 'json' || f.type === 'richtext' ? 'sm:col-span-2 lg:col-span-3' : f.type === 'bool' ? 'flex items-end pb-2' : ''}>
          {f.type === 'bool' ? (
            <Switch id={f.name} checked={!!values[f.name]} disabled={disabled || f.readonly} onChange={(v) => onChange(f.name, v)} label={f.label ?? humanize(f.name)} />
          ) : (
            <>
              <Label htmlFor={f.name} required={f.required}>{f.label ?? humanize(f.name)}</Label>
              <FieldInput f={f} value={values[f.name]} onChange={(v) => onChange(f.name, v)} renderRef={renderRef} disabled={disabled} refs={values._refs as Record<string, string | null> | undefined} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Editable child lines (PO lines, claim lines, gatepass items). */
export function LinesEditor({ fields, rows, onChange, renderRef, disabled, onCell, canAdd = true }: {
  fields: FieldMeta[]; rows: Record<string, unknown>[]; onChange(rows: Record<string, unknown>[]): void; renderRef?: RefRenderer; disabled?: boolean;
  /** Called after a cell changes (used for autofill, e.g. product → price). */
  onCell?(index: number, field: string, value: unknown, rows: Record<string, unknown>[]): void;
  canAdd?: boolean;
}) {
  const cols = fields.filter((f) => f.type !== 'json' && (!f.readonly || disabled || rows.some((r) => r[f.name] != null && Number(r[f.name]) !== 0)));
  const set = (i: number, k: string, v: unknown) => {
    const next = rows.map((r, j) => (j === i ? { ...r, [k]: v } : r));
    onChange(next);
    onCell?.(i, k, v, next);
  };
  const has = (n: string) => fields.some((f) => f.name === n);
  const num = (v: unknown) => Number(v ?? 0) || 0;
  // Running total when the lines carry money: qty × price, or amount (+ tax).
  const total = has('price') && has('qty') ? rows.reduce((s, r) => s + num(r.qty) * num(r.price), 0)
    : has('amount') ? rows.reduce((s, r) => s + num(r.amount) + num(r.tax), 0) : null;
  return (
    <div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No lines yet{!disabled && ' — add the first one below.'}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/70 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-2 py-2 text-start font-medium">#</th>
                {cols.map((c) => <th key={c.name} className="px-2 py-2 text-start font-medium">{c.label ?? humanize(c.name)}{c.required && <span className="text-danger">*</span>}</th>)}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="px-2 py-2.5 text-xs tabular-nums text-muted-foreground">{i + 1}</td>
                  {cols.map((c) => (
                    <td key={c.name} className={['int', 'float', 'money', 'decimal'].includes(c.type) ? 'w-28 min-w-24 px-1.5 py-1.5' : 'min-w-40 px-1.5 py-1.5'}>
                      <FieldInput f={c} value={r[c.name]} onChange={(v) => set(i, c.name, v)} renderRef={renderRef} disabled={disabled} refs={r._refs as Record<string, string | null> | undefined} />
                    </td>
                  ))}
                  <td className="px-1 py-2">{!disabled && <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</Button>}</td>
                </tr>
              ))}
            </tbody>
            {total !== null && (
              <tfoot>
                <tr className="border-t border-border bg-muted/40 font-medium">
                  <td colSpan={cols.length + 1} className="px-2 py-2 text-end text-muted-foreground">Total</td>
                  <td className="px-2 py-2 text-end tabular-nums">{total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {!disabled && canAdd && (
        <button type="button" onClick={() => onChange([...rows, {}])}
          className="mt-3 w-full rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground transition hover:border-primary hover:text-primary">+ Add line</button>
      )}
    </div>
  );
}
