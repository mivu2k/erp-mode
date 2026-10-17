'use client';
import { Button, DataView, EmptyState, ListParams, PageHeader, Row } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { can, useMeta, useResource } from '@/lib/meta';
import { renderRef } from '@/lib/RefPicker';
import { AuthImage } from '@/lib/FilePanel';

export default function ListPage() {
  const { key } = useParams<{ key: string }>();
  const r = useResource(key);
  const meta = useMeta();
  const router = useRouter();
  const search = useSearchParams();
  const savedViews = useMemo(() => ({
    list: () => api<never[]>(`views/${key}`),
    save: (name: string, config: object) => api(`views/${key}`, 'POST', { name, config }),
    remove: (id: string) => api(`views/${id}`, 'DELETE'),
  }), [key]);
  // Accounts have their own screen (tree + balances); the plain list would be a second, poorer copy.
  useEffect(() => { if (key === 'finance.account') router.replace('/finance/accounts'); }, [key, router]);
  if (!r) return <EmptyState title="Not available" hint="This screen doesn't exist or you don't have access." />;
  // URL parameters naming a field fix the list to that value, e.g. ?kind=part → spare parts only (menus link this way).
  const fixed = Object.fromEntries([...search.entries()].filter(([k]) => r.fields.some((f) => f.name === k)));
  const fixedQs = new URLSearchParams(fixed).toString();
  const toQuery = (p: ListParams) => { const filters = { ...p.filters, ...fixed }; return { page: p.page, pageSize: p.pageSize, search: p.search, sort: p.sort, filters: Object.keys(filters).length ? filters : undefined }; };
  const title = key === 'inventory.product' && fixed.kind === 'part' ? 'Spare parts' : r.label;
  const canCreate = r.can.create && (!r.ops || r.ops.includes('create'));
  return (
    <>
      <PageHeader title={title} actions={
        <>
          {(key === 'repair.job' || key === 'repair.intake') && <Link href="/repair/intake"><Button>New intake</Button></Link>}
          {key === 'hrm.payroll' && <Link href="/hrm/payroll"><Button>Run payroll</Button></Link>}
          {canCreate && <Link href={`${r.createPath ?? `/r/${key}/new`}${fixedQs ? `?${fixedQs}` : ''}`}><Button>New</Button></Link>}
        </>
      } />
      <DataView
        id={fixedQs ? `${key}?${fixedQs}` : key}
        title={title}
        fields={[...r.fields, ...r.customFields.map((c) => ({ name: `custom.${c.name}`, label: c.label, type: c.type === 'number' ? 'float' : c.type === 'file' ? 'string' : c.type, options: c.options ?? undefined }))]}
        defaultColumns={r.list}
        statuses={r.statuses}
        calendarField={r.calendar}
        thumbnail={r.fields.some((f) => f.name === 'photo' || f.name === 'images') ? (row) => {
          const id = (Array.isArray(row.images) ? row.images[0] : row.photo) as string | undefined;
          return id ? <AuthImage id={id} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-xs text-muted-foreground">No image</div>;
        } : undefined}
        renderRef={renderRef}
        savedViews={savedViews}
        load={(p) => api<{ rows: Row[]; total: number }>(`r/${key}?${qs(toQuery(p))}`)}
        onOpen={(row) => router.push(`/r/${key}/${row.id}`)}
        onMove={r.can.update && r.statuses && !r.readonly?.includes('status') ? (row, status) => api(`r/${key}/${row.id}`, 'PATCH', { status }) : undefined}
        onExport={r.can.export ? (format, p, columns) => openDoc(`r/${key}/export?${qs({ ...toQuery(p), format, columns: columns.join(',') })}`) : undefined}
        bulkActions={[
          // Registry bulk actions (e.g. brochure / presentation for the selected catalog items).
          ...(r.bulk ?? []).filter((b) => !b.permission || can(meta, b.permission)).map((b) => ({
            // Paths starting with "/" are app pages (open with the selection); others are API documents.
            label: b.label, run: async (rows: Row[]) => (b.path.startsWith('/')
              ? router.push(`${b.path}?items=${rows.map((x) => `c:${x.id}`).join(',')}`)
              : openDoc(`${b.path}${b.path.includes('?') ? '&' : '?'}ids=${rows.map((x) => x.id).join(',')}`)),
          })),
          ...(r.can.delete && (!r.ops || r.ops.includes('delete')) ? [{ label: 'Delete', run: async (rows: Row[]) => { if (confirm(`Delete ${rows.length} record(s)?`)) for (const x of rows) await api(`r/${key}/${x.id}`, 'DELETE'); } }] : []),
        ]}
      />
    </>
  );
}
