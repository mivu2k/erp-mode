'use client';
import { Button, Card, ErrorBox, Input, Label, PageHeader, Select, Switch } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useMeta } from '@/lib/meta';
import { RefPicker } from '@/lib/RefPicker';

interface Step { name: string; approverType: 'role' | 'user' | 'manager' | 'department_head'; approverId?: string; escalateAfterHours?: number; escalateToRoleId?: string }
interface Cond { minAmount?: number; maxAmount?: number; branchId?: string; departmentId?: string; equals?: Record<string, unknown> }
interface Wf { name: string; resource: string; priority: number; isActive: boolean; steps: Step[]; conditions: Cond | null }
const WHO: [Step['approverType'], string][] = [['role', 'Anyone with a role'], ['user', 'A specific person'], ['manager', "The requester's manager"], ['department_head', 'Head of the department']];

/** An approval chain as a form: what it applies to, when, and who approves at each step. */
export default function Workflow() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const meta = useMeta();
  const docs = meta.resources.filter((r) => r.workflow);
  const [w, setW] = useState<Wf | null>(isNew ? { name: '', resource: docs[0]?.key ?? '', priority: 0, isActive: true, steps: [{ name: 'Approval', approverType: 'manager' }], conditions: null } : null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!isNew) api<Wf>(`r/core.workflow/${id}`).then((d) => setW({ ...d, steps: d.steps?.length ? d.steps : [{ name: 'Approval', approverType: 'manager' }], conditions: d.conditions ?? null })).catch(setError); }, [id, isNew]);
  if (!w) return <ErrorBox error={error} />;
  const c = w.conditions ?? {};
  const setC = (x: Partial<Cond>) => setW({ ...w, conditions: Object.fromEntries(Object.entries({ ...c, ...x }).filter(([, v]) => v !== '' && v != null && !Number.isNaN(v))) as Cond });
  const setStep = (i: number, x: Partial<Step>) => setW({ ...w, steps: w.steps.map((s, j) => (j === i ? { ...s, ...x } : s)) });
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = async () => {
    setError(null); setSaved(false);
    try {
      const body = { ...w, steps: w.steps.slice(0, 1), conditions: Object.keys(c).length ? c : null }; // one step: one decision
      if (isNew) { const r = await api<{ id: string }>('r/core.workflow', 'POST', body); router.replace(`/admin/workflows/${r.id}`); } else { await api(`r/core.workflow/${id}`, 'PATCH', body); setSaved(true); }
    } catch (e) { setError(e); }
  };

  return (
    <>
      <nav className="mb-2 text-xs text-muted-foreground"><Link className="hover:underline" href="/r/core.workflow">Workflows</Link></nav>
      <PageHeader title={isNew ? 'New approval workflow' : w.name || 'Workflow'} actions={<><Button onClick={save}>{isNew ? 'Create' : 'Save'}</Button>{saved && <span role="status" className="self-center text-xs" style={{ color: 'var(--tone-green)' }}>Saved</span>}</>} />
      <div className="mb-3"><ErrorBox error={error} /></div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="Applies to">
          <div className="space-y-3 text-sm">
            <div><Label htmlFor="n">Name</Label><Input id="n" value={w.name} placeholder="e.g. Large purchase orders" onChange={(e) => setW({ ...w, name: e.target.value })} /></div>
            <div><Label htmlFor="r">Document</Label>
              <Select id="r" value={w.resource} onChange={(e) => setW({ ...w, resource: e.target.value })}>{docs.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label htmlFor="mn">Only when amount is at least</Label><Input id="mn" type="number" value={c.minAmount ?? ''} placeholder="any" onChange={(e) => setC({ minAmount: num(e.target.value) })} /></div>
              <div><Label htmlFor="mx">and at most</Label><Input id="mx" type="number" value={c.maxAmount ?? ''} placeholder="any" onChange={(e) => setC({ maxAmount: num(e.target.value) })} /></div>
            </div>
            <div><Label>Only for branch</Label><RefPicker f={{ name: 'branchId', type: 'string', ref: 'core.branch' }} value={c.branchId ?? null} onChange={(v) => setC({ branchId: (v as string) || undefined })} /></div>
            <div><Label>Only for department</Label><RefPicker f={{ name: 'departmentId', type: 'string', ref: 'core.department' }} value={c.departmentId ?? null} onChange={(v) => setC({ departmentId: (v as string) || undefined })} /></div>
            <div><Label htmlFor="p">If several workflows match, the higher number wins</Label><Input id="p" type="number" className="w-28" value={w.priority} onChange={(e) => setW({ ...w, priority: Number(e.target.value) || 0 })} /></div>
            <Switch checked={w.isActive} onChange={(v) => setW({ ...w, isActive: v })} label="In use" />
          </div>
        </Card>
        <Card title="Who approves">
          {(() => { const s = w.steps[0]; return (
            <div className="space-y-3 text-sm">
              <div><Label htmlFor="t0">Approver</Label>
                <Select id="t0" value={s.approverType} onChange={(e) => setStep(0, { approverType: e.target.value as Step['approverType'], approverId: undefined })}>{WHO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
              {s.approverType === 'role' && <div><Label>Role</Label><RefPicker f={{ name: 'approverId', type: 'string', ref: 'core.role' }} value={s.approverId ?? null} onChange={(v) => setStep(0, { approverId: v as string })} /></div>}
              {s.approverType === 'user' && <div><Label>Person</Label><RefPicker f={{ name: 'approverId', type: 'string', ref: 'core.user' }} value={s.approverId ?? null} onChange={(v) => setStep(0, { approverId: v as string })} /></div>}
              <div className="grid gap-2 sm:grid-cols-2">
                <div><Label htmlFor="e0">If no answer after (hours)</Label><Input id="e0" type="number" placeholder="never" value={s.escalateAfterHours ?? ''} onChange={(e) => setStep(0, { escalateAfterHours: num(e.target.value) })} /></div>
                {s.escalateAfterHours ? <div><Label>…also ask role</Label><RefPicker f={{ name: 'escalateToRoleId', type: 'string', ref: 'core.role' }} value={s.escalateToRoleId ?? null} onChange={(v) => setStep(0, { escalateToRoleId: v as string })} /></div> : null}
              </div>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">One decision settles it: this approver — <b>or anyone whose role has Approve rights</b> for this document (e.g. Admin) — approves, rejects or sends it back. Nobody can approve their own request.</p>
            </div>
          ); })()}
        </Card>
      </div>
    </>
  );
}
