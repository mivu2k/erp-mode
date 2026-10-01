'use client';
import type { FieldMeta } from '@erp/ui';
import { humanize, Input } from '@erp/ui';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, qs } from './api';
import { useMeta } from './meta';

interface Opt { id: string; label: string; sub?: string }

/** Searchable picker for foreign keys; shows titles, stores ids. Master data is narrowed by type when known. */
export function RefPicker({ f, value, onChange, knownLabel }: { f: FieldMeta; value: unknown; onChange(v: unknown): void; knownLabel?: string | null }) {
  const meta = useMeta();
  const target = meta.resources.find((r) => r.key === f.ref);
  const [text, setText] = useState('');
  const [opts, setOpts] = useState<Opt[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const mdType: Record<string, string> = { categoryId: 'product_category', unitId: 'unit', taxId: 'tax', methodId: 'payment_method', headId: 'expense_head', reasonId: 'reason', serviceId: 'service_rate' };

  const initial = useRef({ value, knownLabel });
  useEffect(() => {
    if (!value || !target) return setLabel('');
    // The record already carries the title of its references (_refs): no extra request needed.
    if (value === initial.current.value && initial.current.knownLabel) return setLabel(initial.current.knownLabel);
    if (label && opts.some((o) => o.id === value)) return;
    api<Record<string, unknown>>(`r/${target.key}/${value}`).then((r) => setLabel(String(r[target.title] ?? value))).catch(() => setLabel(String(value)));
  }, [value, target]);

  useEffect(() => {
    if (!open || !target) return;
    const t = setTimeout(() => {
      const filters = { ...(target.key === 'core.masterdata' && mdType[f.name] ? { type: mdType[f.name] } : {}), ...f.filters };
      api<{ rows: Record<string, unknown>[] }>(`r/${target.key}?${qs({ search: text, pageSize: 20, filters })}`)
        .then((d) => setOpts(d.rows.map((r) => ({ id: String(r.id), label: String(r[target.title] ?? r.id), sub: target.subtitle ? String(r[target.subtitle] ?? '') : undefined }))))
        .catch(() => setOpts([]));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open, target]);

  // The list is position:fixed at the input's screen position, so table/card overflow can't clip it; it flips up near the bottom.
  const [pos, setPos] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < 272 && r.top > window.innerHeight - r.bottom;
      setPos({ position: 'fixed', left: r.left, width: Math.max(r.width, 240), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // The user can't browse this list (e.g. branches for an employee): show what's set, never a raw-id text box.
  if (!target) {
    const own = value && value === meta.user.employeeId ? meta.user.name : null;
    return <Input value={knownLabel ?? own ?? (value ? '(set)' : '')} disabled readOnly placeholder="Set automatically" aria-label={f.label ?? humanize(f.name)} />;
  }
  return (
    <div ref={box} className="relative">
      <Input role="combobox" aria-expanded={open} aria-label={f.label ?? humanize(f.name)} id={f.name} value={open ? text : label} placeholder={`Search ${target.label.toLowerCase()}…`}
        onFocus={() => { setOpen(true); setText(''); }} onChange={(e) => setText(e.target.value)} />
      {open && (
        <ul role="listbox" style={pos} className="z-50 max-h-64 overflow-auto rounded-[var(--radius)] border border-border bg-card py-1 shadow-lg">
          {value != null && value !== '' && <li><button type="button" className="w-full px-3 py-1.5 text-start text-sm text-muted-foreground hover:bg-muted" onClick={() => { onChange(null); setOpen(false); }}>Clear</button></li>}
          {opts.map((o) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button type="button" className="w-full px-3 py-1.5 text-start text-sm hover:bg-muted" onClick={() => { onChange(o.id); setLabel(o.label); setOpen(false); }}>
                {o.label}{o.sub && <span className="ms-2 text-xs text-muted-foreground">{o.sub}</span>}
              </button>
            </li>
          ))}
          {!opts.length && <li className="px-3 py-1.5 text-sm text-muted-foreground">No matches</li>}
        </ul>
      )}
    </div>
  );
}

export const renderRef = (f: FieldMeta, value: unknown, onChange: (v: unknown) => void, refs?: Record<string, string | null>) =>
  <RefPicker f={f} value={value} onChange={onChange} knownLabel={refs?.[f.name]} />;
