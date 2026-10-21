'use client';
import { Button, Card, cx, EmptyState, ErrorBox, humanize, Input, PageHeader } from '@erp/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { can, useMeta } from '@/lib/meta';

interface Item { id: string; type: string; code?: string | null; name: string; isActive: boolean; sort: number }
/** Where each list is used, so people know what they're editing. */
const USED: Record<string, string> = {
  accessory: 'Repair intake — accessories handed in', equipment_type: 'Repair intake — equipment types', fault: 'Repair intake — common faults',
  employee_type: 'HR — employee types', holiday: 'HR — public holidays', expense_head: 'Finance — expense types', payment_method: 'Payments — cash, bank, cheque…',
  product_category: 'Inventory — product categories', unit: 'Inventory — units of measure', service_rate: 'Repair — labour / service rates',
  tax: 'Sales tax rates', currency: 'Currencies', reason: 'Reasons (rejections, adjustments…)',
};

/** Master data as lists: pick a list, see only its items, add / rename / switch off in place. */
export default function Lists() {
  const meta = useMeta();
  const edit = can(meta, 'core.masterdata.create');
  const [items, setItems] = useState<Item[] | null>(null);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [newList, setNewList] = useState('');
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ rows: Item[] }>('r/core.masterdata?pageSize=5000&sort=sort:asc').then((d) => setItems(d.rows)).catch(setError), []);
  useEffect(() => { load(); }, [load]);
  const types = useMemo(() => [...new Set([...(items ?? []).map((i) => i.type), ...(type ? [type] : [])])].sort((a, b) => humanize(a).localeCompare(humanize(b))), [items, type]);
  useEffect(() => { if (!type && types.length) setType(types[0]); }, [types, type]);
  const shown = (items ?? []).filter((i) => i.type === type && (!q || `${i.name} ${i.code ?? ''}`.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const run = (p: Promise<unknown>) => { setError(null); p.then(load).catch(setError); };
  const add = () => { if (!name.trim()) return; run(api('r/core.masterdata', 'POST', { type, name: name.trim(), isActive: true })); setName(''); };

  return (
    <>
      <PageHeader title="Lists" subtitle="The choices that appear in dropdowns across the system" />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <div className="grid items-start gap-4 md:grid-cols-[16rem_1fr]">
        <Card title="Lists">
          <ul className="-mx-2 space-y-0.5 text-sm">
            {types.map((t) => (
              <li key={t}><button onClick={() => { setType(t); setQ(''); }} className={cx('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-start', t === type ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}>
                <span>{humanize(t)}</span><span className="text-xs text-muted-foreground">{(items ?? []).filter((i) => i.type === t).length}</span></button></li>
            ))}
          </ul>
          {edit && (
            <form className="mt-3 flex gap-1 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); const t = newList.trim().toLowerCase().replace(/\W+/g, '_'); if (t) { setType(t); setNewList(''); } }}>
              <Input aria-label="New list name" placeholder="New list…" value={newList} onChange={(e) => setNewList(e.target.value)} /><Button type="submit" variant="outline">Add</Button>
            </form>
          )}
        </Card>
        {type && (
          <Card title={<span>{humanize(type)}{USED[type] && <span className="ms-2 text-xs font-normal text-muted-foreground">{USED[type]}</span>}</span>}
            actions={<Input aria-label="Search this list" placeholder="Search…" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} />}>
            {edit && (
              <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
                <Input aria-label={`Add to ${humanize(type)}`} placeholder={`Add to ${humanize(type).toLowerCase()}… (press Enter)`} value={name} onChange={(e) => setName(e.target.value)} />
                <Button type="submit" disabled={!name.trim()}>Add</Button>
              </form>
            )}
            {!shown.length ? <EmptyState title={q ? 'Nothing matches' : 'Empty list'} hint={edit && !q ? 'Type a name above and press Enter.' : undefined} /> : (
              <ul className="divide-y divide-border/60 text-sm">
                {shown.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 py-1.5">
                    <Input aria-label={`Name of ${i.name}`} defaultValue={i.name} readOnly={!edit} className={cx('h-9 flex-1', !i.isActive && 'text-muted-foreground line-through')}
                      onBlur={(e) => { const v = e.target.value.trim(); if (edit && v && v !== i.name) run(api(`r/core.masterdata/${i.id}`, 'PATCH', { name: v })); }} />
                    {edit && <label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={i.isActive} onChange={(e) => { const isActive = e.target.checked; setItems((xs) => xs && xs.map((x) => (x.id === i.id ? { ...x, isActive } : x))); run(api(`r/core.masterdata/${i.id}`, 'PATCH', { isActive })); }} />In use</label>}
                    {can(meta, 'core.masterdata.delete') && <Button size="sm" variant="ghost" aria-label={`Delete ${i.name}`} onClick={() => confirm(`Delete “${i.name}”?`) && run(api(`r/core.masterdata/${i.id}`, 'DELETE'))}>✕</Button>}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">Untick “In use” to hide a choice from dropdowns without losing it on old records.</p>
          </Card>
        )}
      </div>
    </>
  );
}
