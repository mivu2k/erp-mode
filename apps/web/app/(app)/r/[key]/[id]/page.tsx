'use client';
import { Button, Card, cx, Dialog, EmptyState, ErrorBox, FieldMeta, FormGrid, formatCell, RefRenderer, humanize, Input, LinesEditor, Menu, PageHeader, Skeleton, StatusBadge, Tabs, Textarea, Timeline, useT } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, openDoc, qs } from '@/lib/api';
import { ActionDef, can, ResourceMeta, useMeta, useResource } from '@/lib/meta';
import { fromMinor, IMMUTABLE, nextInstallment, toMinor, type ActionField } from '@erp/shared';
import { renderRef as refPicker } from '@/lib/RefPicker';
import { Attachments, FileField, FilesField } from '@/lib/FilePanel';
import { UserRoles } from '@/lib/UserRoles';
import { JobFlow } from '@/lib/JobFlow';
import { JobParts } from '@/lib/JobParts';
import { UtilityBillDialog } from '@/lib/UtilityBillDialog';
import { ClaimProgress, DiagnosisHistory, DocHeader, RepairUnit, JournalLines, JsonLines, objectList, ReadDetails, ReadLines } from '@/lib/ReadView';
import { autofillPatch, computeFields, evalExpr } from '@/lib/autofill';

type Rec = Record<string, unknown> & { id?: string; status?: string; _refs?: Record<string, string> };

export default function RecordPage() {
  const { key, id } = useParams<{ key: string; id: string }>();
  const meta = useMeta();
  const r = useResource(key);
  const router = useRouter();
  const t = useT();
  const isNew = id === 'new';
  const search = useSearchParams();
  const [rec, setRec] = useState<Rec | null>(isNew ? {} : null);
  // New records can be prefilled from the URL, e.g. /r/payables.due/new?direction=payable
  const [values, setValues] = useState<Rec>(() => {
    if (!isNew) return {};
    // Sensible starting values: today for a `date`, yourself as the employee on your own requests, then URL params.
    const d: Rec = {};
    if (r?.fields.some((f) => f.name === 'date')) d.date = new Date().toISOString().slice(0, 10);
    if (r?.owner === 'employeeId' && meta.user.employeeId && r.fields.some((f) => f.name === 'employeeId')) d.employeeId = meta.user.employeeId;
    return { ...d, ...Object.fromEntries(search.entries()) };
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('details');
  const [action, setAction] = useState<ActionDef | null>(null);
  const [editAnyway, setEditAnyway] = useState(false);
  const [editJob, setEditJob] = useState(false);
  const [myApproval, setMyApproval] = useState<string | null>(null); // pending approval request this user can decide
  const [pairing, setPairing] = useState<{ code: string; link: string; qrSvg: string; station: string; expiresInMin: number } | null>(null);

  // Pickers for this record: references via RefPicker, attachment-id fields via FileField (needs the record id).
  const renderRef: RefRenderer = (f, v, onChange, refs) =>
    f.type === 'file' ? <FileField f={f} value={v} onChange={onChange} entityType={key} entityId={isNew ? null : id} />
    : f.type === 'files' ? <FilesField f={f} value={v} onChange={onChange} entityType={key} entityId={isNew ? null : id} />
    : refPicker(f, v, onChange, refs);

  // Products have their own screen (structured form, barcodes, stock); keep any prefill query (?barcode=…).
  useEffect(() => { if (key === 'inventory.product') router.replace(`/inventory/products/${id}${search.toString() ? `?${search}` : ''}`); }, [key, id, router, search]);
  useEffect(() => { if (key === 'reports.report' && !isNew) router.replace(`/reports/saved/${id}`); }, [key, id, isNew, router]);

  const load = useCallback(() => {
    if (isNew) return;
    api<Rec>(`r/${key}/${id}`).then((d) => { setRec(d); setValues(d); }).catch(setError);
  }, [key, id, isNew]);
  useEffect(load, [load]);
  // Waiting for my approval? Decide right here instead of hunting for it in the inbox.
  const pendingNow = rec?.status === 'pending';
  useEffect(() => {
    setMyApproval(null);
    if (pendingNow) api<{ id: string; resource: string; recordId: string }[]>('approvals/inbox').then((xs) => setMyApproval(xs.find((x) => x.resource === key && x.recordId === id)?.id ?? null)).catch(() => {});
  }, [pendingNow, key, id]);
  // Resources with a guided create screen send /new there.
  // A resource with its own create screen; the query (pre-fills like ?barcode=…) goes along.
  useEffect(() => { if (isNew && r?.createPath) router.replace(`${r.createPath}${search.toString() ? `?${search}` : ''}`); }, [isNew, r, router, search]);

  if (!r) return <EmptyState title="Not available" />;
  if (!rec) return error ? <ErrorBox error={error} /> : <div className="space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;

  // Super-admin override: every record is editable/deletable (ledgers excepted); the API logs it as an override.
  const force = !isNew && can(meta, 'core.record.manage') && !IMMUTABLE.includes(key);
  const ops = force ? ['create', 'update', 'delete'] : r.ops ?? ['create', 'update', 'delete'];
  // Locked by status, or handled only through workflow actions (invoices, receipts…): both read as a document.
  const locked = !isNew && ((!!r.editableWhen && !r.editableWhen.includes(String(rec.status))) || (!!r.ops && !r.ops.includes('update')));
  const editable = isNew ? r.can.create && ops.includes('create') : r.can.update && ops.includes('update') && (!locked || force);
  const title = isNew
    ? key === 'payables.due' && values.direction ? `New ${values.direction}` : `New ${r.label.replace(/s$/, '').toLowerCase()}`
    : String(rec._refs?.[r.title] ?? rec[r.title] ?? rec.id); // a ref title (e.g. employee) shows its name, not its id
  const extra: FieldMeta[] = !isNew ? []
    : key === 'core.user' ? [{ name: 'password', type: 'string', required: true }]
    : key === 'payables.due' ? [{ name: 'repeatMonths', type: 'int', label: 'Repeat monthly (number of months, e.g. rent)' }]
    : [];
  // Editable fields go in the form; system-managed ones (readonly, auto numbers) become a read-only summary.
  // Status is always system-driven (workflow, actions, automation) — never typed in, not even under the override.
  // Read-only fields open up only after "Edit anyway" on a locked record (super-admin override).
  const isSystem = (f: FieldMeta) => f.name === 'status' || (!(force && editAnyway) && (f.readonly || (r.number?.field === f.name)));
  const lineCols = r.lineColumns ?? {};
  // Internal ids/tokens never become inputs, even under the super-admin override.
  const hiddenInForm = (f: FieldMeta) => ['journalId', 'sourceId', 'sourceType', 'trackToken', 'qrToken', 'idempotencyKey'].includes(f.name) || f.name.endsWith('Enc');
  const formFields = [...r.fields.filter((f) => !isSystem(f) && !lineCols[f.name] && !hiddenInForm(f)).map((f) => (r.rich?.includes(f.name) ? { ...f, type: 'richtext' } : f)), ...extra];

  /** Field change with autofill (picked record → other fields) and live computed fields. */
  const change = async (k: string, v: unknown) => {
    setValues((s) => ({ ...s, [k]: v, ...computeFields(r.compute, { ...s, [k]: v }) }));
    const rules = r.autofill?.[k];
    if (!rules || !v) return;
    const patch = await autofillPatch(rules, r.fields.find((f) => f.name === k)?.ref, v, meta);
    setValues((s) => (s[k] === v ? { ...s, ...patch, ...computeFields(r.compute, { ...s, ...patch }) } : s));
  };
  /** Same for a cell in child lines (e.g. product → price, tax rate). */
  const changeCell = (rel: string, fields: FieldMeta[]) => async (i: number, k: string, v: unknown) => {
    const rules = r.lineAutofill?.[rel]?.[k];
    if (!rules || !v) return;
    const patch = await autofillPatch(rules, fields.find((f) => f.name === k)?.ref, v, meta);
    setValues((s) => ({ ...s, [rel]: ((s[rel] as Rec[]) ?? []).map((row, j) => (j === i && row[k] === v ? { ...row, ...patch } : row)) }));
  };
  // Internal ids never show raw; a source document becomes a link below.
  const internal = new Set(['kind', 'journalId', 'sourceId', 'sourceType']);
  const summary = r.fields.filter((f) => isSystem(f) && f.type !== 'json' && !internal.has(f.name) && !isNew && rec[f.name] !== null && rec[f.name] !== undefined && rec[f.name] !== '');
  const source = typeof rec.sourceType === 'string' && typeof rec.sourceId === 'string' ? meta.resources.find((x) => x.key === rec.sourceType) : undefined;
  const qc = rec.testResults as Record<string, unknown> | null | undefined;
  // Flat JSON facts (e.g. a voucher's settlement breakdown) read better as summary rows than as raw JSON.
  const facts = r.fields.filter((f) => f.type === 'json' && f.readonly && rec[f.name] && typeof rec[f.name] === 'object' && !Array.isArray(rec[f.name])
    && Object.values(rec[f.name] as object).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
  const dirty = !isNew && JSON.stringify(values) !== JSON.stringify(rec);
  // Posted/locked (or view-only) records read as a document, not a greyed-out form. Super admin can switch to the form.
  const isJob = key === 'repair.job' && !isNew;
  // A repair job reads as its workflow; the form is one click away.
  const readMode = !isNew && (!editable || (force && locked && !editAnyway) || (isJob && !editJob));
  const partyKey = ['customerId', 'vendorId', 'employeeId'].find((k) => rec[k]);
  const partyRef = partyKey ? r.fields.find((f) => f.name === partyKey)?.ref : undefined;
  // A partly approved claim is worth what was approved, not what was claimed.
  const docAmount = rec.approvedTotal != null ? Number(rec.approvedTotal) : r.amountField && rec[r.amountField] != null ? Number(rec[r.amountField]) : rec.total != null ? Number(rec.total) : null;
  const docDate = typeof rec.date === 'string' ? rec.date.slice(0, 10) : typeof rec.createdAt === 'string' ? new Date(rec.createdAt).toLocaleDateString() : undefined;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Rec = {};
      for (const f of formFields) if (values[f.name] !== undefined) body[f.name] = values[f.name];
      for (const c of Object.keys(r!.children)) if (values[c] !== undefined) body[c] = (values[c] as Rec[]).map(({ _refs, id: _id, ...line }) => line);
      for (const c of Object.keys(lineCols)) if (values[c] !== undefined) body[c] = cleanRows(values[c] as Rec[], lineCols[c]);
      if (r!.customFields.length) body.custom = values.custom ?? {};
      const saved = await api<Rec>(isNew ? `r/${key}` : `r/${key}/${id}`, isNew ? 'POST' : 'PATCH', body);
      if (isNew) router.replace(`/r/${key}/${saved.id}`);
      else { setRec(saved); setValues(saved); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const doAction = (a: ActionDef) => {
    if (a.opens) return openDoc(a.path.replace(':id', id) + (a.path.startsWith('print/') || a.path.includes('format=') || a.path.includes('presentation') ? '' : `${a.path.includes('?') ? '&' : '?'}format=html`)).catch(setError);
    if (a.confirm && !confirm(a.confirm)) return;
    if (!a.fields) return run(() => api(a.path.replace(':id', id), 'POST', {}).then((res) => {
      if (res && typeof res === 'object' && 'password' in res) alert(`Password: ${(res as { password: string | null }).password ?? '(none)'}`);
      if (res && typeof res === 'object' && 'link' in res && 'qrSvg' in res) setPairing(res as NonNullable<typeof pairing>);
    }));
    setAction(a);
  };
  const actions = (r.actions ?? []).filter((a) => !isNew && can(meta, a.permission ?? `${key}.update`) && (!a.when || a.when.includes(String(rec.status))));
  // A quotation only goes through internal approval when its discount is over the limit.
  const canSubmit = !isNew && r.workflow && (r.editableWhen ?? ['draft']).includes(String(rec.status)) && r.can.update
    && (key !== 'repair.quotation' || !!(rec.custom as { needsApproval?: boolean } | null)?.needsApproval);
  const decide = (verb: 'approve' | 'reject') => {
    const comment = verb === 'reject' ? window.prompt('Reason for rejecting') : undefined;
    if (verb === 'reject' && !comment?.trim()) return;
    run(() => api(`approvals/${myApproval}/${verb}`, 'POST', { comment }).then(() => setMyApproval(null)));
  };
  // Workflow actions stay visible; the rest (prints, ledgers…) collapse into "More".
  const primary = isJob ? [] : actions.filter((a) => !a.opens).slice(0, 3); // a job's next step lives in its flow panel
  // Printing is its own button (not buried in More): A4 / A5 / POS slip and PDFs.
  const prints = [
    ...(!isNew && r.printable && r.can.print ? [
      { label: 'Print (A4)', onClick: () => openDoc(`print/${key}/${id}`).catch(setError) },
      { label: 'Print (A5)', onClick: () => openDoc(`print/${key}/${id}?size=a5`).catch(setError) },
      { label: 'POS receipt (80mm)', onClick: () => openDoc(`print/${key}/${id}?size=80`).catch(setError) },
      { label: 'Download PDF (A4)', onClick: () => openDoc(`print/${key}/${id}?format=pdf`).catch(setError) },
      { label: 'Download PDF (A5)', onClick: () => openDoc(`print/${key}/${id}?size=a5&format=pdf`).catch(setError) },
    ] : []),
  ];
  const more = [
    ...actions.filter((a) => !primary.includes(a)).map((a) => ({ label: a.label, onClick: () => doAction(a) })),
    ...(!isNew && r.can.delete && ops.includes('delete') && (!locked || force) ? [{ label: t('Delete'), onClick: () => confirm('Delete this record?') && run(async () => { await api(`r/${key}/${id}`, 'DELETE'); router.replace(`/r/${key}`); }) }] : []),
  ];
  const mod = meta.modules.find((m) => m.key === (r.group ?? key.split('.')[0]));

  return (
    <div className={dirty ? 'pb-20' : ''}>
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t(mod?.label ?? '')}</span><span aria-hidden="true">/</span>
        <Link href={`/r/${key}`} className="hover:text-foreground hover:underline">{r.label}</Link>
      </nav>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{title} {!isNew && <StatusBadge status={rec.status as string} />}</span>}
        actions={
          <>
            {isNew && editable && <Button disabled={busy} onClick={save}>{t('Create')}</Button>}
            {force && locked && <Button variant="ghost" onClick={() => { setEditAnyway((x) => !x); setValues(rec); }}>{editAnyway ? 'Done editing' : 'Edit anyway'}</Button>}
            {myApproval && <><Button disabled={busy} onClick={() => decide('approve')}>Approve</Button><Button variant="outline" disabled={busy} onClick={() => decide('reject')}>Reject</Button></>}
            {canSubmit && <Button disabled={busy} onClick={() => run(async () => { if (dirty) await save(); await api(`r/${key}/${id}/submit`, 'POST'); })}>{t('Submit for approval')}</Button>}
            {isJob && editable && !(force && locked) && <Button variant="ghost" onClick={() => { setEditJob((x) => !x); setValues(rec); }}>{editJob ? 'Done editing' : 'Edit details'}</Button>}
            {primary.map((a) => <Button key={a.name} variant="outline" disabled={busy} onClick={() => doAction(a)}>{a.label}</Button>)}
            {prints.length > 0 && <Menu label="Print" items={prints} />}
            {more.length > 0 && <Menu label="More" items={more} />}
          </>
        }
      />
      <div className="mb-3"><ErrorBox error={error} /></div>
      {locked && !force && <p className="mb-3 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{rec.status ? `Read-only while ${humanize(String(rec.status))}.` : 'Posted records are read-only.'}</p>}
      {force && locked && <p className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--tone-amber)', background: 'var(--tone-amber-bg)' }}>Super-admin override: this record is {rec.status ? humanize(String(rec.status)) : 'read-only once saved'} — you can still edit or delete it, and every change is logged as an override. Posted amounts are not re-posted to the ledger.</p>}
      {isJob && <JobFlow rec={rec} jobId={id} actions={actions} onAction={doAction} />}
      {!isNew && <Tabs value={tab} onChange={setTab} tabs={[{ key: 'details', label: t('Details') }, { key: 'files', label: t('Attachments') }, { key: 'activity', label: t('Activity') }, ...(r.timeTracking ? [{ key: 'time', label: t('Time') }] : []), ...(r.workflow ? [{ key: 'approvals', label: t('Approvals') }] : []), ...(key === 'core.user' ? [{ key: 'roles', label: t('Roles') }] : [])]} />}

      {(isNew || tab === 'details') && (
        <div className={summary.length || qc || facts.length ? 'grid items-start gap-4 lg:grid-cols-[1fr_18rem]' : ''}>
          <div className="min-w-0 space-y-4">
            {readMode ? (
              <>
                <DocHeader rec={rec} title={title} kind={r.label.replace(/s$/, '')} amount={docAmount} date={docDate}
                  party={partyKey ? { label: humanize(partyKey), name: rec._refs?.[partyKey], href: partyRef ? `/r/${partyRef}/${rec[partyKey]}` : undefined } : undefined} />
                <ReadDetails rec={rec} fields={formFields.filter((f) => ![partyKey, r.amountField, 'status', r.number?.field].includes(f.name) && !objectList(rec[f.name]))} />
                {r.fields.filter((f) => f.type === 'json' && objectList(rec[f.name]) && !lineCols[f.name]).map((f) => <JsonLines key={f.name} title={humanize(f.name)} rows={rec[f.name] as Rec[]} />)}
                {(key === 'repair.quotation' || key === 'repair.invoice') && typeof rec.jobId === 'string' && <RepairUnit jobId={rec.jobId} />}
                {key === 'finance.claim' && rec.booked === true && <ClaimProgress rec={rec} />}
                {(key === 'repair.job' || key === 'fleet.maintenance') && <JobParts jobId={id} onChanged={load} />}
                {key === 'repair.job' && <DiagnosisHistory diagnosis={rec.diagnosis} />}
                {key === 'finance.journal' && <JournalLines rec={rec} />}
                {key !== 'finance.journal' && Object.entries(r.children).map(([rel, fields]) => <ReadLines key={rel} title={humanize(rel)} rows={(rec[rel] as Rec[]) ?? []} fields={fields} />)}
                {Object.entries(lineCols).map(([rel, cols]) => <ReadLines key={rel} title={humanize(rel)} rows={(rec[rel] as Rec[]) ?? []} fields={colsToFields(cols).filter((f) => !cols[f.name].hidden)} />)}
              </>
            ) : (<>
            <Card title={isNew ? 'Details' : undefined}>
              <FormGrid fields={formFields} values={values} disabled={!editable} renderRef={renderRef} onChange={change} />
            </Card>
            {(key === 'repair.job' || key === 'fleet.maintenance') && !isNew && <JobParts jobId={id} onChanged={load} />}
            {key === 'repair.job' && !isNew && <DiagnosisHistory diagnosis={rec.diagnosis} />}
            {Object.entries(r.children).map(([rel, fields]) => (
              <Card key={rel} title={humanize(rel)}>
                <LinesEditor fields={fields} rows={(values[rel] as Record<string, unknown>[]) ?? []} disabled={!editable} renderRef={renderRef} onChange={(rows) => setValues((s) => ({ ...s, [rel]: rows }))} onCell={changeCell(rel, fields)} />
              </Card>
            ))}
            {Object.entries(lineCols).map(([rel, cols]) => {
              const fields = colsToFields(cols).filter((f) => !cols[f.name].hidden);
              return (
                <Card key={rel} title={humanize(rel)}>
                  <LinesEditor fields={fields} rows={(values[rel] as Record<string, unknown>[]) ?? []} disabled={!editable} renderRef={renderRef} onChange={(rows) => setValues((s) => ({ ...s, [rel]: rows }))} />
                </Card>
              );
            })}
            </>)}
            {!isNew && r.related?.map((rel) => <Related key={rel.resource + rel.field} spec={rel} id={id} />)}
            {r.customFields.length > 0 && (
              <Card title="Additional fields">
                <FormGrid fields={r.customFields.map((c) => ({ name: c.name, label: c.label, type: c.type === 'number' ? 'float' : c.type === 'file' ? 'string' : c.type, required: c.required, options: c.options ?? undefined }))}
                  values={(values.custom as Record<string, unknown>) ?? {}} disabled={!editable}
                  onChange={(k, v) => setValues((s) => ({ ...s, custom: { ...((s.custom as object) ?? {}), [k]: v } }))} />
              </Card>
            )}
          </div>
          {(summary.length > 0 || qc || facts.length > 0) && (
            <Card title="Summary" className="lg:sticky lg:top-20">
              <dl className="space-y-2.5 text-sm">
                {summary.map((f) => (
                  <div key={f.name} className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">{humanize(f.name)}</dt>
                    <dd className="text-end font-medium">{formatCell(rec as never, f, f.name)}</dd>
                  </div>
                ))}
                {source && (
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">For</dt>
                    <dd><Link className="text-primary hover:underline" href={`/r/${source.key}/${rec.sourceId}`}>{source.label.replace(/s$/, '')} ↗</Link></dd></div>
                )}
                {facts.map((f) => (
                  <div key={f.name} className="space-y-1.5 border-t border-border pt-2.5">
                    <div className="font-medium">{humanize(f.name)}</div>
                    {Object.entries(rec[f.name] as Record<string, unknown>).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{humanize(k)}</dt><dd className="tabular-nums">{typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)}</dd></div>
                    ))}
                  </div>
                ))}
                {!isNew && ['finance.advance', 'finance.loan', 'finance.claim'].includes(key) && <Vouchers sourceId={id} />}
                {qc && (
                  <div className="space-y-1.5 border-t border-border pt-2.5">
                    <div className="flex items-center justify-between"><dt className="font-medium">QC bench test</dt><dd><StatusBadge status={qc.pass ? 'completed' : 'rejected'} /></dd></div>
                    {([['rfPowerW', 'RF output', ' W'], ['rxSensitivity', 'RX sensitivity', ''], ['freqErrorHz', 'Freq. error', ' Hz'], ['vswr', 'VSWR', ''], ['audioOk', 'Audio', ''], ['firmwareAfter', 'Firmware', ''], ['by', 'Tested by', '']] as const)
                      .filter(([k]) => qc[k] !== null && qc[k] !== undefined && qc[k] !== '')
                      .map(([k, label, unit]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{typeof qc[k] === 'boolean' ? (qc[k] ? 'OK' : 'Fail') : `${qc[k]}${unit}`}</dd></div>)}
                    {typeof qc.notes === 'string' && qc.notes && <p className="text-xs text-muted-foreground">{qc.notes}</p>}
                  </div>
                )}
                {typeof rec.createdAt === 'string' && <div className="flex justify-between gap-3 border-t border-border pt-2.5"><dt className="text-muted-foreground">Created</dt><dd className="text-end">{new Date(rec.createdAt).toLocaleString()}</dd></div>}
                {typeof rec.updatedAt === 'string' && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Updated</dt><dd className="text-end">{new Date(rec.updatedAt).toLocaleString()}</dd></div>}
              </dl>
            </Card>
          )}
        </div>
      )}
      {pairing && (
        <Dialog open onClose={() => setPairing(null)} title={`Pair a device as “${pairing.station}”`}
          footer={<Button onClick={() => setPairing(null)}>Done</Button>}>
          <ol className="mb-4 list-decimal space-y-1 ps-5 text-sm">
            <li>On the kiosk tablet/PC, <b>scan this QR</b> with its camera — or open the link below in its browser.</li>
            <li>It pairs automatically and switches to the punch screen.</li>
          </ol>
          {/* SVG generated by our API from the link text */}
          <div className="mx-auto mb-4 w-48 rounded-lg bg-white p-3 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <div className="flex gap-2">
            <Input readOnly value={pairing.link} aria-label="Pairing link" onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <Button variant="outline" onClick={() => navigator.clipboard?.writeText(pairing.link)}>Copy</Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Or type code <b className="font-mono text-foreground">{pairing.code}</b> on the kiosk. Valid once, for {pairing.expiresInMin} minutes. Pairing again replaces the previous device.</p>
        </Dialog>
      )}
      {!isNew && tab === 'files' && <Attachments entityType={key} entityId={id} canUpload={r.can.update} />}
      {!isNew && tab === 'activity' && <Activity resource={key} id={id} />}
      {!isNew && tab === 'approvals' && <Approvals resource={key} id={id} />}
      {!isNew && tab === 'roles' && <UserRoles id={id} canEdit={can(meta, 'core.user.manage')} />}
      {!isNew && tab === 'time' && <TimeLogs resource={key} id={id} canTrack={r.can.update} />}

      {editable && dirty && (
        <div className="no-print fixed inset-x-0 bottom-14 z-30 border-t border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur lg:bottom-0 lg:start-60">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">Unsaved changes</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setValues(rec)}>Discard</Button>
              <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : t('Save')}</Button>
            </div>
          </div>
        </div>
      )}

      {action && (action.path === 'utilities/connections/:id/bill'
        ? <UtilityBillDialog id={id} onClose={() => setAction(null)} onDone={() => { setAction(null); load(); }} />
        : <ActionDialog action={action} id={id} rec={rec} resource={r} onClose={() => setAction(null)} onDone={() => { setAction(null); load(); }} />)}
    </div>
  );
}

type Cols = Record<string, ActionField & { hidden?: boolean; readonly?: boolean; label?: string }>;

/** Registry column specs → form field metadata. */
function colsToFields(cols: Cols): FieldMeta[] {
  return Object.entries(cols).map(([name, f]) => ({
    name, label: f.label, type: f.type === 'number' ? 'float' : f.type === 'ref' ? 'string' : f.type, ref: f.ref, required: f.required, options: f.options, filters: f.filters, readonly: f.readonly,
  }));
}

/** Rows ready to send: no display-only data, no empty rows, numbers as numbers, comma lists split. */
function cleanRows(rows: Rec[], cols: Cols): Rec[] {
  return rows
    .map(({ _refs, ...row }) => Object.fromEntries(Object.entries(row).filter(([k]) => k in cols).map(([k, v]) => [k,
      cols[k].type === 'number' || cols[k].type === 'money' ? (v === '' || v == null ? undefined : Number(v))
        : k === 'serials' && typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v])))
    .filter((row) => !('qty' in cols) || Number(row.qty) > 0);
}

/** Resolves an ActionField `from` spec ('amount' or 'total-paid') against the record. */
function prefill(rec: Rec, from?: string) {
  if (!from) return undefined;
  const [a, b] = from.split('-');
  const v = Number(rec[a] ?? 0) - (b ? Number(rec[b] ?? 0) : 0);
  return Number.isFinite(v) && v > 0 ? String(Math.round(v * 100) / 100) : undefined;
}

function ActionDialog({ action, id, rec, resource, onClose, onDone }: { action: ActionDef; id: string; rec: Rec; resource: ResourceMeta; onClose(): void; onDone(): void }) {
  const meta = useMeta();
  const all = Object.entries(action.fields ?? {});
  const fields: FieldMeta[] = colsToFields(Object.fromEntries(all.filter(([, f]) => f.type !== 'lines')));
  const lineFields = all.filter(([, f]) => f.type === 'lines');
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...Object.fromEntries(fields.filter((f) => f.options?.length === 1).map((f) => [f.name, f.options![0]])),
    ...Object.fromEntries(all.map(([n, f]) => [n, f.from && !f.from.includes('-') && f.type === 'ref' ? rec[f.from] : prefill(rec, f.from)]).filter(([, v]) => v !== undefined && v !== null)),
  }));
  // Line tables start from the document's own lines (e.g. what is still to be received).
  useEffect(() => {
    for (const [name, f] of lineFields) {
      if (!f.prefill) continue;
      const src = (rec[f.prefill.rel] as Rec[] | undefined) ?? [];
      Promise.all(src.map(async (line) => {
        const row: Rec = { _refs: line._refs };
        for (const [col, expr] of Object.entries(f.prefill!.map)) row[col] = await evalExpr(expr, line, resource.key, meta);
        return row;
      })).then((rows) => setValues((s) => ({ ...s, [name]: rows.filter((x) => !f.prefill!.keepIf || Number(x[f.prefill!.keepIf]) > 0) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const wide = fields.some((f) => f.type === 'json') || lineFields.length > 0;
  const submit = async () => {
    setBusy(true);
    try {
      const body = { ...values };
      for (const [name, f] of lineFields) body[name] = cleanRows((values[name] as Rec[]) ?? [], f.columns ?? {});
      const res = await api<{ reference?: string; paid?: number; outstanding?: number; invoiceId?: string } | undefined>(action.path.replace(':id', id), 'POST', body);
      if (res?.reference) alert(`${res.reference}: ${res.paid?.toLocaleString()} received. Outstanding: ${res.outstanding?.toLocaleString()}`);
      // An action that raised an invoice (e.g. a sale-out gatepass leaving the gate) goes straight to it, ready for payment.
      if (res?.invoiceId) { location.href = `/r/repair.invoice/${res.invoiceId}`; return; }
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  // Advance/loan repayment: which installment is due, detected from what's been recovered so far.
  const plan = action.path.endsWith('advances/:id/return') ? nextInstallment({ amount: toMinor(rec.amount as string), installments: Number(rec.installments ?? 1), recovered: toMinor(rec.recovered as string) }) : null;
  // What is this action about? Show the record, its amount and the party so nobody pays the wrong thing.
  const party = ['employeeId', 'customerId', 'vendorId'].find((k) => rec._refs?.[k] && rec._refs[k] !== '—');
  const amount = resource.amountField && rec[resource.amountField] != null ? Number(rec[resource.amountField]) : rec.total != null ? Number(rec.total) : null;
  return (
    <Dialog open onClose={onClose} title={action.label} wide={wide}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={submit}>{busy ? 'Working…' : action.label}</Button></>}>
      <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{String(rec[resource.title] ?? '')}</span>
          {amount !== null && <span className="text-lg font-semibold tabular-nums">{amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
        </div>
        {party && <div className="mt-0.5 text-xs text-muted-foreground">{humanize(party)}: {rec._refs?.[party]}</div>}
      </div>
      {plan && <InstallmentPlan plan={plan} mode={String(values.mode ?? '')} custom={Number(values.amount) || 0} />}
      <FormGrid columns={wide && fields.length > 2 ? 3 : 1} fields={plan && values.mode !== 'custom_amount' ? fields.filter((f) => f.name !== 'amount') : fields} values={values} renderRef={refPicker} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
      {lineFields.map(([name, f]) => (
        <div key={name} className="mt-5">
          <div className="mb-2 text-[13px] font-medium text-foreground/80">{humanize(name)}</div>
          <LinesEditor fields={colsToFields(f.columns ?? {}).filter((c) => !f.columns?.[c.name].hidden)} rows={(values[name] as Rec[]) ?? []}
            canAdd={!f.prefill} renderRef={refPicker} onChange={(rows) => setValues((s) => ({ ...s, [name]: rows }))} />
        </div>
      ))}
      {error != null && <div className="mt-3"><ErrorBox error={error} /></div>}
    </Dialog>
  );
}

interface Tl { kind: string; at: string; user?: string; action?: string; body?: string; after?: Record<string, unknown>; internal?: boolean }

function Activity({ resource, id }: { resource: string; id: string }) {
  const [items, setItems] = useState<Tl[]>([]);
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(true);
  const load = useCallback(() => { api<Tl[]>(`r/${resource}/${id}/timeline`).then(setItems).catch(() => {}); }, [resource, id]);
  useEffect(load, [load]);
  return (
    <Card title="Activity">
      <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) api(`r/${resource}/${id}/comments`, 'POST', { body: text, internal }).then(() => { setText(''); load(); }); }}>
        <Textarea placeholder="Add a note…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs"><Input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal only</label>
          <Button size="sm">Add note</Button>
        </div>
      </form>
      <Timeline items={items.map((t) => ({
        at: t.at,
        title: t.kind === 'comment' ? <><b>{t.user}</b> commented{t.internal ? ' (internal)' : ''}</> : <><b>{t.user ?? 'System'}</b> {t.action}{t.after && 'status' in t.after ? <> → <StatusBadge status={String(t.after.status)} /></> : null}</>,
        body: t.kind === 'comment' ? t.body : t.action === 'update' && t.after ? Object.keys(t.after).map(humanize).join(', ') : undefined,
      }))} />
    </Card>
  );
}

interface Req { id: string; status: string; step: number; createdAt: string; actions: { action: string; userId: string; comment?: string; createdAt: string; step: number }[] }

function Approvals({ resource, id }: { resource: string; id: string }) {
  const [reqs, setReqs] = useState<Req[]>([]);
  useEffect(() => { api<Req[]>(`r/${resource}/${id}/approvals`).then(setReqs).catch(() => {}); }, [resource, id]);
  if (!reqs.length) return <Card><EmptyState title="Not submitted yet" /></Card>;
  return (
    <div className="space-y-3">
      {reqs.map((q) => (
        <Card key={q.id} title={<span className="flex items-center gap-2">Request {new Date(q.createdAt).toLocaleDateString()} <StatusBadge status={q.status} /></span>}>
          <Timeline items={q.actions.map((a) => ({ at: a.createdAt, title: `Step ${a.step + 1}: ${a.action}`, body: a.comment }))} />
        </Card>
      ))}
    </div>
  );
}

interface Tlog { id: string; user?: string; startedAt: string; endedAt?: string | null; minutes: number; note?: string | null }

function TimeLogs({ resource, id, canTrack }: { resource: string; id: string; canTrack: boolean }) {
  const [d, setD] = useState<{ total: number; running: Tlog | null; logs: Tlog[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => { api<typeof d>(`time/${resource}/${id}`).then(setD).catch(setError); }, [resource, id]);
  useEffect(load, [load]);
  const fmt = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;
  return (
    <Card title={`Time logged: ${d ? fmt(d.total) : '…'}`} actions={canTrack && (d?.running
      ? <Button size="sm" variant="danger" onClick={() => api('time/stop', 'POST', {}).then(load).catch(setError)}>Stop (running since {new Date(d.running.startedAt).toLocaleTimeString()})</Button>
      : <Button size="sm" onClick={() => api(`time/${resource}/${id}/start`, 'POST').then(load).catch(setError)}>Start timer</Button>)}>
      <ErrorBox error={error} />
      {!d?.logs.length ? <EmptyState title="No time logged" /> : (
        <table className="w-full text-sm">
          <tbody>
            {d.logs.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="py-1.5">{l.user}</td>
                <td className="py-1.5 text-muted-foreground">{new Date(l.startedAt).toLocaleString()}</td>
                <td className="py-1.5 text-end tabular-nums">{l.endedAt ? fmt(l.minutes) : 'running…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

interface Voucher { id: string; number: string; amount: string; status: string }

/** Payment vouchers raised for an advance, loan or claim. */
function Vouchers({ sourceId }: { sourceId: string }) {
  const [rows, setRows] = useState<Voucher[]>([]);
  useEffect(() => { api<{ rows: Voucher[] }>(`r/finance.voucher?${qs({ filters: { sourceId }, pageSize: 20 })}`).then((d) => setRows(d.rows)).catch(() => {}); }, [sourceId]);
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5 border-t border-border pt-2.5">
      <div className="font-medium">Payment vouchers</div>
      {rows.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-3">
          <Link href={`/r/finance.voucher/${v.id}`} className="text-primary hover:underline">{v.number}</Link>
          <span className="flex items-center gap-2 tabular-nums">{Number(v.amount).toLocaleString()} <StatusBadge status={v.status} /></span>
        </div>
      ))}
    </div>
  );
}

/** Read-only list of records that point at this one (e.g. an intake's units, quotations and invoices). */
function Related({ spec, id }: { spec: { resource: string; field: string; label: string; columns: string[] }; id: string }) {
  const meta = useMeta();
  const target = meta.resources.find((x) => x.key === spec.resource);
  const [rows, setRows] = useState<Rec[] | null>(null);
  useEffect(() => { api<{ rows: Rec[] }>(`r/${spec.resource}?${qs({ filters: { [spec.field]: id }, pageSize: 100, sort: 'createdAt:asc' })}`).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [spec, id]);
  if (!target || !rows?.length) return null;
  // Repair units print right from the row (job card, 80mm slip, unit tag), same as just after intake.
  const jobs = spec.resource === 'repair.job' && target.can.print;
  const fields = new Map<string, FieldMeta>([...target.fields.map((f): [string, FieldMeta] => [f.name, f]), ['createdAt', { name: 'createdAt', type: 'datetime' }]]);
  return (
    <Card title={`${spec.label} (${rows.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>{spec.columns.map((c) => <th key={c} className="px-2 py-1.5 text-start font-medium">{humanize(c)}</th>)}{jobs && <th className="px-2 py-1.5 text-end font-medium">Print</th>}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)} className="border-t border-border">
                {spec.columns.map((c, i) => (
                  <td key={c} className="px-2 py-2">
                    {i === 0 ? <Link className="text-primary hover:underline" href={`/r/${spec.resource}/${row.id}`}>{formatCell(row as never, fields.get(c), c)}</Link> : formatCell(row as never, fields.get(c), c)}
                  </td>
                ))}
                {jobs && (
                  <td className="whitespace-nowrap px-2 py-1.5 text-end">
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${row.id}`)}>Job card</Button>
                      <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${row.id}?size=80`)}>Slip 80mm</Button>
                      <Button size="sm" variant="outline" onClick={() => openDoc(`print/repair.job/${row.id}?template=label`)}>Unit tag</Button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function InstallmentPlan({ plan, mode, custom }: { plan: ReturnType<typeof nextInstallment>; mode: string; custom: number }) {
  const f = (m: number) => fromMinor(m).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const now = mode === 'full_settlement' ? plan.outstanding : mode === 'custom_amount' ? toMinor(custom) : mode === 'next_installment' ? plan.due : null;
  return (
    <div className="mb-4 space-y-2">
      <div className="flex gap-1" aria-label={`Installment ${plan.no} of ${plan.of}`}>
        {Array.from({ length: plan.of }, (_, i) => (
          <span key={i} title={`Installment ${i + 1}`} className="h-1.5 flex-1 rounded-full"
            style={{ background: i + 1 < plan.no || !plan.outstanding ? 'var(--tone-green)' : i + 1 === plan.no ? 'var(--tone-amber)' : 'var(--border)' }} />
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Next</dt><dd className="text-end font-medium">{plan.outstanding ? `Installment ${plan.no} of ${plan.of}` : 'Fully repaid'}</dd>
        <dt className="text-muted-foreground">Installment size</dt><dd className="text-end tabular-nums">{f(plan.per)}</dd>
        <dt className="text-muted-foreground">Due now</dt><dd className="text-end tabular-nums">{f(plan.due)}</dd>
        <dt className="text-muted-foreground">Outstanding</dt><dd className="text-end tabular-nums">{f(plan.outstanding)}</dd>
        {now !== null && <><dt className="font-medium">This payment</dt><dd className={cx('text-end font-semibold tabular-nums', now > plan.outstanding && 'text-danger')}>{f(now)}{now > plan.outstanding ? ' — more than outstanding' : ''}</dd></>}
      </dl>
    </div>
  );
}
