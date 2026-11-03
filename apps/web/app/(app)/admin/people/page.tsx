'use client';
import { Button, Card, EmptyState, ErrorBox, Input, PageHeader } from '@erp/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { InlineList } from '@/lib/InlineList';
import { can, useMeta } from '@/lib/meta';

interface User { id: string; name: string; email?: string | null; username?: string | null; isActive: boolean; lastLoginAt?: string | null }

/** Who works here and how they are organised: users, departments, designations, cost centers. */
export default function People() {
  const meta = useMeta();
  const [users, setUsers] = useState<User[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api<{ rows: User[] }>('r/core.user?pageSize=500&sort=name:asc').then((d) => setUsers(d.rows)).catch(setError); }, []);
  const shown = (users ?? []).filter((u) => !q || `${u.name} ${u.email ?? ''} ${u.username ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const when = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : 'never');

  return (
    <>
      <PageHeader title="Users & teams" subtitle="People who sign in, and the departments and designations they belong to"
        actions={<>{can(meta, 'core.role.manage') && <Link href="/admin/roles"><Button variant="outline">Roles & permissions</Button></Link>}{can(meta, 'core.user.create') && <Link href="/r/core.user/new"><Button>+ New user</Button></Link>}</>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <div className="grid items-start gap-4 xl:grid-cols-[3fr_2fr]">
        <Card title={<span>Users{users && <span className="ms-2 text-xs font-normal text-muted-foreground">{users.filter((u) => u.isActive).length} active</span>}</span>}
          actions={<Input aria-label="Find a user" placeholder="Find…" className="h-9 w-48" value={q} onChange={(e) => setQ(e.target.value)} />}>
          {users && !shown.length ? <EmptyState title={q ? 'No user matches' : 'No users yet'} /> : (
            <ul className="-mx-2 divide-y divide-border/60 text-sm">
              {shown.map((u) => (
                <li key={u.id}>
                  <Link href={`/r/core.user/${u.id}`} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
                    <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{u.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{u.name}</span><span className="block truncate text-xs text-muted-foreground">{u.email ?? u.username ?? ''}</span></span>
                    <span className="hidden text-xs text-muted-foreground sm:block">last sign-in {when(u.lastLoginAt)}</span>
                    {!u.isActive && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">disabled</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-4">
          <InlineList resource="core.department" title="Departments" cols={[{ name: 'name', label: 'Name', required: true }, { name: 'branchId', label: 'Branch', ref: 'core.branch' }]} />
          <InlineList resource="core.designation" title="Designations" hint="Job titles, e.g. Technician, Accountant." cols={[{ name: 'name', label: 'Name', required: true }]} />
          <InlineList resource="core.costcenter" title="Cost centers" cols={[{ name: 'code', label: 'Code', width: '7rem', required: true }, { name: 'name', label: 'Name', required: true }]} />
        </div>
      </div>
    </>
  );
}
