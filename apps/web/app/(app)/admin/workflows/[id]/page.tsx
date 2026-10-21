'use client';
import { Button, Card, ErrorBox, Input, Label, PageHeader, Select, Switch } from '@erp/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useMeta } from '@/lib/meta';
import { RefPicker } from '@/lib/RefPicker';

interface Step { name: string; approverType: 'role' | 'user' | 'manager' | 'department_head'; approverId?: string; mode?: 'any' | 'all'; escalateAfterHours?: number; escalateToRoleId?: string }
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
  const [w, setW] = useState<Wf | null>(isNew ? { name: '', resource: docs[0]?.key ?? '', priority: 0, isActive: true, steps: [{ name: 'Manager', approverType: 'manager', mode: 'any' }], conditions: null } : null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!isNew) api<Wf>(`r/core.workflow/${id}`).then((d) => setW({ ...d, steps: d.steps ?? [], conditions: d.conditions ?? null })).catch(setError); }, [id, isNew]);
  if (!w) return <ErrorBox error={error} />;
  const c = w.conditions ?? {};
  const setC = (x: Partial<Cond>) => setW({ ...w, conditions: Object.fromEntries(Object.entries({ ...c, ...x }).filter(([, v]) => v !== '' && v != null && !Number.isNaN(v))) as Cond });
  const setStep = (i: number, x: Partial<Step>) => setW({ ...w, steps: w.steps.map((s, j) => (j === i ? { ...s, ...x } : s)) });
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = async () => {
    setError(null); setSaved(false);
    try {
      const body = { ...w, conditions: Object.keys(c).length ? c : null };
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
        <Card title="Approval steps" actions={<Button size="sm" variant="outline" onClick={() => setW({ ...w, steps: [...w.steps, { name: `Step ${w.steps.length + 1}`, approverType: 'role', mode: 'any' }] })}>+ Add step</Button>}>
          <ol className="space-y-3 text-sm">
            {w.steps.map((s, i) => (
              <li key={i} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                  <Input aria-label={`Step ${i + 1} name`} className="flex-1" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} />
                  <Button size="sm" variant="ghost" disabled={i === 0} aria-label="Move up" onClick={() => { const x = [...w.steps]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; setW({ ...w, steps: x }); }}>↑</Button>
                  <Button size="sm" variant="ghost" disabled={w.steps.length === 1} aria-label={`Remove step ${i + 1}`} onClick={() => setW({ ...w, steps: w.steps.filter((_, j) => j !== i) })}>✕</Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div><Label htmlFor={`t${i}`}>Who approves</Label>
                    <Select id={`t${i}`} value={s.approverType} onChange={(e) => setStep(i, { approverType: e.target.value as Step['approverType'], approverId: undefined })}>{WHO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
                  {s.approverType === 'role' && <div><Label>Role</Label><RefPicker f={{ name: 'approverId', type: 'string', ref: 'core.role' }} value={s.approverId ?? null} onChange={(v) => setStep(i, { approverId: v as string })} /></div>}
                  {s.approverType === 'user' && <div><Label>Person</Label><RefPicker f={{ name: 'approverId', type: 'string', ref: 'core.user' }} value={s.approverId ?? null} onChange={(v) => setStep(i, { approverId: v as string })} /></div>}
                  {s.approverType === 'role' && <div><Label htmlFor={`m${i}`}>Needs</Label>
                    <Select id={`m${i}`} value={s.mode ?? 'any'} onChange={(e) => setStep(i, { mode: e.target.value as 'any' | 'all' })}><option value="any">Any one of them</option><option value="all">Every one of them</option></Select></div>}
                  <div><Label htmlFor={`e${i}`}>If no answer after (hours)</Label><Input id={`e${i}`} type="number" placeholder="never" value={s.escalateAfterHours ?? ''} onChange={(e) => setStep(i, { escalateAfterHours: num(e.target.value) })} /></div>
                  {s.escalateAfterHours ? <div><Label>…also ask role</Label><RefPicker f={{ name: 'escalateToRoleId', type: 'string', ref: 'core.role' }} value={s.escalateToRoleId ?? null} onChange={(v) => setStep(i, { escalateToRoleId: v as string })} /></div> : null}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">Steps run in order; a rejection at any step stops the document.</p>
        </Card>
      </div>
    </>
  );
}
