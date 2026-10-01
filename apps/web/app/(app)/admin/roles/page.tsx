'use client';
import { Button, Card, cx, ErrorBox, humanize, Input, PageHeader, Select } from '@erp/ui';
import { ACTIONS, MODULES, RESOURCES } from '@erp/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

type Grants = Record<string, string>; // permission key → scope
interface Role { id: string; name: string; isSystem?: boolean }

const SCOPES: [string, string][] = [['own', 'Own records'], ['department', 'Department'], ['branch', 'Branch'], ['all', 'Everything']];
const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', update: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export', print: 'Print', manage: 'Manage' };
const WIDEST = (xs: string[]) => SCOPES.map(([s]) => s).reverse().find((s) => xs.includes(s)) ?? 'own'; // a fresh grant starts at the least access; widen it on purpose

/** Pick a role on the left; tick what it may do per screen, and how much data it sees. */
export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [roleId, setRoleId] = useState('');
  const [all, setAll] = useState<string[]>([]);
  const [grants, setGrants] = useState<Grants>({});
  const [saved, setSaved] = useState<Grants>({});
  const [q, setQ] = useState('');
  const [find, setFind] = useState('');
  const [msg, setMsg] = useState<unknown>(null);
  const [ok, setOk] = useState('');

  const loadRoles = (select?: string) => api<{ rows: Role[] }>('r/core.role?pageSize=200&sort=name:asc').then((d) => { setRoles(d.rows); setRoleId((cur) => select ?? (cur || d.rows[0]?.id || '')); });
  useEffect(() => { loadRoles(); api<string[]>('admin/permissions').then(setAll); }, []);
  useEffect(() => {
    if (!roleId) return;
    api<{ key: string; scope: string }[]>(`roles/${roleId}/permissions`).then((p) => { const g = Object.fromEntries(p.map((x) => [x.key, x.scope])); setGrants(g); setSaved(g); });
  }, [roleId]);

  const dirty = JSON.stringify(Object.entries(grants).filter(([, s]) => s).sort()) !== JSON.stringify(Object.entries(saved).filter(([, s]) => s).sort());
  const pick = (id: string) => { if (dirty && !confirm('Discard unsaved changes to this role?')) return; setRoleId(id); setOk(''); };

  // Resources grouped by module, with human labels; filtered by the search box.
  const groups = useMemo(() => {
    const keys = [...new Set(all.map((k) => k.split('.').slice(0, 2).join('.')))];
    const label = (k: string) => RESOURCES.find((r) => r.key === k)?.label ?? humanize(k.split('.')[1]);
    const mod = (k: string) => RESOURCES.find((r) => r.key === k)?.group ?? k.split('.')[0];
    const out = new Map<string, { key: string; label: string }[]>();
    for (const k of keys) {
      const l = label(k);
      const m = mod(k);
      if (q && !`${l} ${k} ${MODULES[m]?.label ?? m}`.toLowerCase().includes(q.toLowerCase())) continue;
      out.set(m, [...(out.get(m) ?? []), { key: k, label: l }]);
    }
    return [...out.entries()].map(([m, rs]) => ({ key: m, label: MODULES[m]?.label ?? humanize(m), rows: rs.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [all, q]);

  const has = (k: string) => all.includes(k);
  const rowScope = (r: string) => WIDEST(ACTIONS.map((a) => grants[`${r}.${a}`]).filter(Boolean));
  const setRow = (r: string, actions: readonly string[], scope = rowScope(r)) => setGrants((g) => {
    const n = { ...g };
    for (const a of ACTIONS) delete n[`${r}.${a}`];
    for (const a of actions) if (has(`${r}.${a}`)) n[`${r}.${a}`] = scope;
    return n;
  });
  const toggle = (r: string, a: string) => setGrants((g) => {
    const k = `${r}.${a}`;
    const n = { ...g };
    if (n[k]) delete n[k]; else n[k] = rowScope(r);
    // Anything beyond view implies view.
    if (!n[k] && a === 'view') for (const x of ACTIONS) delete n[`${r}.${x}`];
    if (n[k] && a !== 'view' && has(`${r}.view`)) n[`${r}.view`] ??= n[k];
    return n;
  });
  const granted = (r: string) => ACTIONS.filter((a) => grants[`${r}.${a}`]);

  const save = () => api(`roles/${roleId}/permissions`, 'PUT', Object.entries(grants).filter(([, s]) => s).map(([key, scope]) => ({ key, scope })))
    .then(() => { setSaved(grants); setOk('Saved — users pick up the change on their next request.'); setMsg(null); }).catch(setMsg);
  const create = async (from?: string) => {
    const name = prompt(from ? 'Name for the copy' : 'New role name')?.trim();
    if (!name) return;
    try {
      const r = from ? await api<{ id: string }>(`roles/${from}/clone`, 'POST', { name }) : await api<{ id: string }>('r/core.role', 'POST', { name });
      await loadRoles(r.id);
    } catch (e) { setMsg(e); }
  };
  const rename = async () => {
    const cur = roles.find((r) => r.id === roleId);
    const name = prompt('Rename role', cur?.name)?.trim();
    if (!name || name === cur?.name) return;
    try { await api(`r/core.role/${roleId}`, 'PATCH', { name }); await loadRoles(roleId); } catch (e) { setMsg(e); }
  };
  const role = roles.find((r) => r.id === roleId);
  const total = Object.values(grants).filter(Boolean).length;

  return (
    <div className="pb-20">
      <PageHeader title="Roles & permissions" subtitle="Choose a role, then tick what it can do on each screen and how much data it can see" />
      <div className="mb-3"><ErrorBox error={msg} /></div>
      <div className="grid items-start gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="lg:sticky lg:top-20">
          <Input aria-label="Find role" placeholder="Find role…" value={find} onChange={(e) => setFind(e.target.value)} className="mb-2" />
          <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto" role="listbox" aria-label="Roles">
            {roles.filter((r) => r.name.toLowerCase().includes(find.toLowerCase())).map((r) => (
              <li key={r.id}>
                <button type="button" role="option" aria-selected={r.id === roleId} onClick={() => pick(r.id)}
                  className={cx('w-full rounded-lg px-3 py-2 text-start text-sm transition', r.id === roleId ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  {r.name}{r.isSystem && <span className="ms-1 text-[10px] uppercase tracking-wide text-muted-foreground">system</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={() => create()}>+ New role</Button>
            <Button size="sm" variant="outline" disabled={!roleId} onClick={() => create(roleId)}>Duplicate</Button>
            <Button size="sm" variant="ghost" disabled={!roleId || role?.isSystem} onClick={rename}>Rename</Button>
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{role?.name ?? '—'}</h2>
              <p className="text-xs text-muted-foreground">{total} permission{total === 1 ? '' : 's'} granted</p>
            </div>
            <Input aria-label="Filter screens" placeholder="Filter screens or modules…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
          </div>

          {groups.map((g) => {
            const n = g.rows.filter((r) => granted(r.key).length).length;
            return (
              <Card key={g.key} title={<span>{g.label} <span className="ms-1 text-xs font-normal text-muted-foreground">{n}/{g.rows.length} screens</span></span>}
                actions={<span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => g.rows.forEach((r) => setRow(r.key, ['view']))}>All view-only</Button>
                  <Button size="sm" variant="ghost" onClick={() => g.rows.forEach((r) => setRow(r.key, ACTIONS))}>Full access</Button>
                  <Button size="sm" variant="ghost" onClick={() => g.rows.forEach((r) => setRow(r.key, []))}>Clear</Button>
                </span>}>
                <div className="divide-y divide-border">
                  {g.rows.map((r) => {
                    const on = granted(r.key);
                    return (
                      <div key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                        <div className="w-48 min-w-0">
                          <div className={cx('truncate text-sm', on.length ? 'font-medium' : 'text-muted-foreground')}>{r.label}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">{r.key}</div>
                        </div>
                        <div className="flex flex-1 flex-wrap gap-1.5">
                          {ACTIONS.filter((a) => has(`${r.key}.${a}`)).map((a) => {
                            const active = !!grants[`${r.key}.${a}`];
                            return (
                              <button key={a} type="button" aria-pressed={active} aria-label={`${r.label}: ${ACTION_LABEL[a]}`} onClick={() => toggle(r.key, a)}
                                className={cx('rounded-full border px-2.5 py-0.5 text-xs transition', active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-muted-foreground')}>
                                {active ? '✓ ' : ''}{ACTION_LABEL[a]}
                              </button>
                            );
                          })}
                        </div>
                        <Select aria-label={`${r.label}: data access`} className="w-36" disabled={!on.length} value={on.length ? rowScope(r.key) : ''} onChange={(e) => setRow(r.key, on, e.target.value)}>
                          {!on.length && <option value="">No access</option>}
                          {SCOPES.map(([s, l]) => <option key={s} value={s}>{l}</option>)}
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
          <p className="text-xs text-muted-foreground">
            <b>Data access</b> — Own records: only what the user created or is assigned · Department / Branch: records of their department or branch · Everything: all records.
            Ticking any action also grants View.
          </p>
        </div>
      </div>

      {(dirty || ok) && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur lg:start-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-muted-foreground">{dirty ? `Unsaved changes to ${role?.name}` : ok}</span>
            {dirty && <span className="flex gap-2">
              <Button variant="ghost" onClick={() => { setGrants(saved); setOk(''); }}>Discard</Button>
              <Button onClick={save}>Save changes</Button>
            </span>}
          </div>
        </div>
      )}
    </div>
  );
}
