'use client';
import { Button, Card, ErrorBox, Switch } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, qs } from './api';

interface Role { id: string; name: string; isSystem?: boolean }

/** A user's roles: tick the roles, save. Permissions come from the roles (edit them in the permission matrix). */
export function UserRoles({ id, canEdit }: { id: string; canEdit: boolean }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api<{ rows: Role[] }>(`r/core.role?${qs({ pageSize: 200, sort: 'name:asc' })}`), api<string[]>(`users/${id}/roles`)])
      .then(([r, mine]) => { setRoles(r.rows); setOn(new Set(mine)); setSaved(new Set(mine)); }).catch(setError);
  }, [id]);
  const dirty = on.size !== saved.size || [...on].some((x) => !saved.has(x));
  const save = async () => {
    setBusy(true); setError(null);
    try { await api(`users/${id}/roles`, 'POST', { roleIds: [...on] }); setSaved(new Set(on)); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Roles" actions={canEdit && <Button size="sm" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : dirty ? 'Save roles' : 'Saved'}</Button>}>
      <ErrorBox error={error} />
      {!roles ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map((r) => (
            <Switch key={r.id} checked={on.has(r.id)} disabled={!canEdit}
              onChange={(c) => setOn((s) => { const n = new Set(s); if (c) n.add(r.id); else n.delete(r.id); return n; })}
              label={<span>{r.name}{r.isSystem ? <span className="ms-1 text-xs text-muted-foreground">(system)</span> : null}</span>} />
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        {on.size ? `${on.size} role(s) selected.` : 'No roles — the user can sign in but sees nothing.'} Changes apply on the user&apos;s next request.
        {' '}What each role can do: <Link className="text-primary hover:underline" href="/admin/roles">Roles &amp; permissions</Link>.
      </p>
    </Card>
  );
}
