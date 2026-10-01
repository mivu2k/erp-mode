import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService, Tx } from '../platform/audit.service';
import { NotifyService } from '../platform/notify.service';
import { PrismaService } from '../platform/prisma.service';
import { assertCan, AuthUser, can } from '../rbac/rbac';
import { delegate, HooksService, Row } from './hooks';
import { ResourceService } from './resource.service';

export interface Conditions { minAmount?: number; maxAmount?: number; branchId?: string; departmentId?: string; equals?: Record<string, unknown> }
export interface Step {
  name: string;
  approverType: 'role' | 'user' | 'manager' | 'department_head';
  approverId?: string;
  /** any (default): one approval moves on; all: every approver must approve (parallel sign-off). */
  mode?: 'any' | 'all';
  escalateAfterHours?: number;
  escalateToRoleId?: string;
}

/** Is a step complete? Escalation approvers can always close it alone. Delegates count for their delegator. */
export function stepComplete(step: Step, base: string[], approvedBy: Set<string>, delegates: Map<string, string>, escalationIds: string[]): boolean {
  if (step.mode !== 'all') return approvedBy.size > 0;
  if (escalationIds.some((id) => approvedBy.has(id))) return true;
  return base.length > 0 && base.every((id) => approvedBy.has(id) || (delegates.has(id) && approvedBy.has(delegates.get(id)!)));
}

export const escalated = (step: Step | undefined, stepStartedAt: Date, now = Date.now()) =>
  !!step?.escalateAfterHours && !!step.escalateToRoleId && now - +stepStartedAt >= step.escalateAfterHours * 3_600_000;

/** Does a workflow definition apply to this record? */
export function matches(c: Conditions | null | undefined, rec: Row, amount: number): boolean {
  if (!c) return true;
  if (c.minAmount != null && amount < c.minAmount) return false;
  if (c.maxAmount != null && amount > c.maxAmount) return false;
  if (c.branchId && rec.branchId !== c.branchId) return false;
  if (c.departmentId && rec.departmentId !== c.departmentId) return false;
  return Object.entries(c.equals ?? {}).every(([k, v]) => String(rec[k]) === String(v));
}

type Action = 'approve' | 'reject' | 'return' | 'comment';

@Injectable()
export class WorkflowService {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private hooks: HooksService,
    private notify: NotifyService,
    private audit: AuditService,
  ) {}

  async submit(user: AuthUser, key: string, id: string) {
    const m = this.resources.meta(key);
    if (!m.def.workflow) throw new BadRequestException(`${m.def.label} has no approval workflow`);
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.resources.load(tx, user, key, id, 'update');
      if (!(m.def.editableWhen ?? ['draft']).includes(String(rec.status))) throw new BadRequestException(`Cannot submit while ${rec.status}`);
      await this.hooks.run(key, 'beforeSubmit', { tx, user, def: m.def }, rec);
      const amount = m.def.amountField ? Number(rec[m.def.amountField] ?? 0) : 0;
      const defs = await tx.workflowDefinition.findMany({ where: { companyId: user.companyId, resource: key, isActive: true, deletedAt: null }, orderBy: { priority: 'desc' } });
      const wf = defs.find((d) => matches(d.conditions as Conditions | null, rec, amount));
      const ctx = { tx, user, def: m.def };

      if (!wf || !(wf.steps as unknown as Step[]).length) {
        const approved = await this.resources.setStatus(tx, user, key, id, 'approved');
        await this.hooks.run(key, 'onApproved', ctx, approved);
        return { status: 'approved', autoApproved: true };
      }
      await tx.approvalRequest.updateMany({ where: { resource: key, recordId: id, status: 'returned' }, data: { status: 'resubmitted' } });
      const req = await tx.approvalRequest.create({
        data: {
          companyId: user.companyId, resource: key, recordId: id, definitionId: wf.id, requestedById: user.id,
          title: `${m.def.label}: ${String(rec[m.def.title] ?? id)}`, amount: m.def.amountField ? new Prisma.Decimal(amount) : null,
          actions: { create: { step: 0, userId: user.id, action: 'submit' } },
        },
      });
      await this.resources.setStatus(tx, user, key, id, 'pending');
      await this.routeStep(tx, req.id);
      return { status: 'pending', requestId: req.id };
    });
  }

  async act(user: AuthUser, requestId: string, action: Action, comment?: string) {
    if ((action === 'reject' || action === 'return') && !comment?.trim()) throw new BadRequestException('A reason is required');
    return this.prisma.$transaction(async (tx) => {
      const req = await tx.approvalRequest.findFirst({ where: { id: requestId, companyId: user.companyId, status: 'pending' } });
      if (!req) throw new NotFoundException();
      const wf = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: req.definitionId } });
      const steps = wf.steps as unknown as Step[];
      const step = steps[req.step];
      const who = await this.resolve(tx, req, step);
      const admin = can(user, 'core.approval.manage');
      if (!who.all.includes(user.id) && !admin) throw new ForbiddenException('You are not an approver for this step');
      // Maker-checker: whoever submitted can't approve it (admins with approval override excepted).
      if (action === 'approve' && req.requestedById === user.id && !admin) throw new ForbiddenException('You cannot approve your own request');

      // An approval admin's approval is final: the remaining steps are skipped (and the trail says so).
      const skipped = action === 'approve' && admin && req.step + 1 < steps.length ? ` [admin approval — steps ${req.step + 2}–${steps.length} skipped]` : '';
      await tx.approvalAction.create({ data: { requestId, step: req.step, userId: user.id, action, comment: skipped ? `${comment ?? ''}${skipped}`.trim() : comment } });
      if (action === 'comment') return { status: 'pending' };

      const m = this.resources.meta(req.resource);
      const ctx = { tx, user, def: m.def };
      const link = `/r/${req.resource}/${req.recordId}`;
      if (action === 'approve' && !admin) {
        const approvedBy = new Set((await tx.approvalAction.findMany({ where: { requestId, step: req.step, action: 'approve' } })).map((a) => a.userId));
        if (!stepComplete(step, who.base, approvedBy, who.delegates, who.escalation)) return { status: 'pending', step: req.step, waitingFor: who.base.filter((id) => !approvedBy.has(id)).length };
      }
      if (action === 'approve' && req.step + 1 < steps.length && !admin) {
        await tx.approvalRequest.update({ where: { id: requestId }, data: { step: req.step + 1 } });
        await this.routeStep(tx, requestId);
        return { status: 'pending', step: req.step + 1 };
      }
      const final = { approve: 'approved', reject: 'rejected', return: 'returned' }[action];
      await tx.approvalRequest.update({ where: { id: requestId }, data: { status: final } });
      await tx.approvalAssignee.deleteMany({ where: { requestId } });
      const rec = await this.resources.setStatus(tx, user, req.resource, req.recordId, final);
      if (final === 'approved') await this.hooks.run(req.resource, 'onApproved', ctx, rec);
      if (final === 'rejected') await this.hooks.run(req.resource, 'onRejected', ctx, rec);
      await this.notify.send(user.companyId, [req.requestedById], { title: `${req.title} was ${final}`, body: comment, link }, tx);
      return { status: final };
    });
  }

  /**
   * Requests the user can act on right now: one indexed lookup on the step's recorded approvers
   * (the user, or anyone who has delegated to them). Approval admins see every pending request.
   */
  async inbox(user: AuthUser) {
    const admin = can(user, 'core.approval.manage');
    await this.routeLegacy(user.companyId);
    const delegators = (await this.prisma.user.findMany({ where: { delegateToId: user.id, delegateUntil: { gt: new Date() } }, select: { id: true } })).map((u) => u.id);
    const pending = await this.prisma.approvalRequest.findMany({
      where: { companyId: user.companyId, status: 'pending', ...(admin ? {} : { requestedById: { not: user.id }, assignees: { some: { userId: { in: [user.id, ...delegators] } } } }) },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending.length) return [];
    const [defs, mine] = await Promise.all([
      this.prisma.workflowDefinition.findMany({ where: { id: { in: [...new Set(pending.map((p) => p.definitionId))] } } }),
      this.prisma.approvalAction.findMany({ where: { requestId: { in: pending.map((p) => p.id) }, userId: user.id, action: 'approve' }, select: { requestId: true, step: true } }),
    ]);
    const def = new Map(defs.map((d) => [d.id, d.steps as unknown as Step[]]));
    const approvedByMe = new Set(mine.map((a) => `${a.requestId}:${a.step}`));
    return this.context(user, pending.flatMap((r) => {
      const step = def.get(r.definitionId)?.[r.step];
      // In an "everyone approves" step, what I've already approved leaves my inbox while others still decide.
      if (!step || (step.mode === 'all' && approvedByMe.has(`${r.id}:${r.step}`))) return [];
      return [{ ...r, stepName: step.name, escalated: escalated(step, r.updatedAt) }];
    }));
  }

  async mine(user: AuthUser, kind: 'requested' | 'acted') {
    if (kind === 'requested') return this.context(user, await this.prisma.approvalRequest.findMany({ where: { companyId: user.companyId, requestedById: user.id }, orderBy: { createdAt: 'desc' }, take: 200 }));
    const acts = await this.prisma.approvalAction.findMany({
      where: { userId: user.id, action: { in: ['approve', 'reject', 'return'] } }, include: { request: true }, orderBy: { createdAt: 'desc' }, take: 200,
    });
    return this.context(user, acts.map((a) => ({ ...a.request, myAction: a.action, actedAt: a.createdAt, comment: a.comment })));
  }

  /**
   * What an approver needs without opening the record: who asked, which module, and the record's list columns
   * (names instead of ids). One query per resource type, not per request.
   */
  private async context<T extends { resource: string; recordId: string; requestedById: string }>(user: AuthUser, rows: T[]) {
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requestedById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const details = new Map<string, [string, unknown][]>();
    await Promise.all([...new Set(rows.map((r) => r.resource))].map(async (key) => {
      const m = this.resources.resourceDef(key) && this.resources.meta(key);
      if (!m) return;
      const skip = new Set(['number', 'status', 'createdAt', 'updatedAt', m.def.amountField ?? '', ...(m.def.hidden ?? []), ...(m.def.restricted ?? [])]);
      // The "why" (purpose/reason/notes) always shows, even when the list view leaves it out.
      const cols = [...new Set([...(m.def.list ?? []), 'purpose', 'reason', 'description', 'notes'])].filter((c) => m.columns.has(c) && !skip.has(c));
      const recs = await delegate(this.prisma, m.delegate).findMany({
        where: { id: { in: rows.filter((r) => r.resource === key).map((r) => r.recordId) }, ...(m.columns.has('companyId') ? { companyId: user.companyId } : {}) },
        select: { id: true, ...Object.fromEntries(cols.map((c) => [c, true])) },
      });
      await this.resources.attachRefs(this.prisma, user, m, recs);
      for (const rec of recs) {
        const refs = (rec._refs ?? {}) as Row;
        details.set(`${key}:${rec.id}`, cols.map((c) => [c, refs[c] ?? rec[c]] as [string, unknown]).filter(([, v]) => v !== null && v !== '' && v !== undefined));
      }
    }));
    return rows.map((r) => ({ ...r, module: r.resource.split('.')[0], requestedBy: users.get(r.requestedById) ?? null, details: details.get(`${r.resource}:${r.recordId}`) ?? [] }));
  }

  async history(user: AuthUser, key: string, id: string) {
    assertCan(user, `${key}.view`);
    return this.prisma.approvalRequest.findMany({ where: { companyId: user.companyId, resource: key, recordId: id }, include: { actions: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'asc' } });
  }

  /** Everyone who may act now: base approvers, their active delegates, and the escalation role once overdue. */
  async resolve(tx: Tx, req: { companyId: string; resource: string; recordId: string; requestedById: string; updatedAt: Date }, step?: Step) {
    const base = await this.approvers(tx, req, step);
    const users = await tx.user.findMany({ where: { id: { in: base }, delegateToId: { not: null }, delegateUntil: { gt: new Date() } }, select: { id: true, delegateToId: true } });
    const delegates = new Map(users.map((u) => [u.id, u.delegateToId!]));
    const escalation = escalated(step, req.updatedAt)
      ? (await tx.userRole.findMany({ where: { roleId: step!.escalateToRoleId }, select: { userId: true } })).map((u) => u.userId)
      : [];
    return { base, delegates, escalation, all: [...new Set([...base, ...delegates.values(), ...escalation])] };
  }

  /** Scheduler hook: once a step is overdue, its escalation role joins the approvers and is notified (once per step). */
  async escalateOverdue() {
    const pending = await this.prisma.approvalRequest.findMany({ where: { status: 'pending' }, take: 5000 });
    if (!pending.length) return 0;
    const [defs, done] = await Promise.all([
      this.prisma.workflowDefinition.findMany({ where: { id: { in: [...new Set(pending.map((p) => p.definitionId))] } } }),
      this.prisma.approvalAction.findMany({ where: { requestId: { in: pending.map((p) => p.id) }, action: 'escalated' }, select: { requestId: true, step: true } }),
    ]);
    const def = new Map(defs.map((d) => [d.id, d.steps as unknown as Step[]]));
    const already = new Set(done.map((a) => `${a.requestId}:${a.step}`));
    let n = 0;
    for (const r of pending) {
      const step = def.get(r.definitionId)?.[r.step];
      if (!escalated(step, r.updatedAt) || already.has(`${r.id}:${r.step}`)) continue;
      const roleUsers = (await this.prisma.userRole.findMany({ where: { roleId: step!.escalateToRoleId }, select: { userId: true } })).map((u) => u.userId);
      await this.prisma.$transaction([
        this.prisma.approvalAction.create({ data: { requestId: r.id, step: r.step, userId: 'system', action: 'escalated', comment: `No decision after ${step!.escalateAfterHours}h` } }),
        this.prisma.approvalAssignee.createMany({ data: roleUsers.map((userId) => ({ requestId: r.id, userId, step: r.step })), skipDuplicates: true }),
      ]);
      await this.notify.toRole(r.companyId, step!.escalateToRoleId!, { title: `Escalated: ${r.title}`, link: '/approvals' });
      n++;
    }
    return n;
  }

  private async approvers(tx: Tx, req: { companyId: string; resource: string; recordId: string; requestedById: string }, step?: Step): Promise<string[]> {
    if (!step) return [];
    switch (step.approverType) {
      case 'user':
        return step.approverId ? [step.approverId] : [];
      case 'role':
        return (await tx.userRole.findMany({ where: { roleId: step.approverId ?? '' }, select: { userId: true } })).map((u) => u.userId);
      case 'manager': {
        const emp = await tx.employee.findFirst({ where: { userId: req.requestedById }, select: { managerId: true } });
        const mgr = emp?.managerId ? await tx.employee.findUnique({ where: { id: emp.managerId }, select: { userId: true } }) : null;
        return mgr?.userId ? [mgr.userId] : [];
      }
      case 'department_head': {
        const u = await tx.user.findUnique({ where: { id: req.requestedById }, select: { departmentId: true } });
        const dept = u?.departmentId ? await tx.department.findUnique({ where: { id: u.departmentId } }) : null;
        const head = dept?.headId ? await tx.employee.findUnique({ where: { id: dept.headId }, select: { userId: true } }) : null;
        return head?.userId ? [head.userId] : [];
      }
    }
  }

  /** A step starts: record who must act (approvers + their escalation role if already overdue) and tell them. */
  private async routeStep(tx: Tx, requestId: string, notify = true) {
    const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
    const wf = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: req.definitionId } });
    const who = await this.resolve(tx, req, (wf.steps as unknown as Step[])[req.step]);
    await tx.approvalAssignee.deleteMany({ where: { requestId } });
    await tx.approvalAssignee.createMany({ data: [...new Set([...who.base, ...who.escalation])].map((userId) => ({ requestId, userId, step: req.step })), skipDuplicates: true });
    if (notify) await this.notify.send(req.companyId, [...who.base, ...who.delegates.values()], { title: `Approval needed: ${req.title}`, link: `/approvals` }, tx);
  }

  /** Requests created before approvers were recorded get routed once (no re-notification). */
  private async routeLegacy(companyId: string) {
    const legacy = await this.prisma.approvalRequest.findMany({ where: { companyId, status: 'pending', assignees: { none: {} } }, select: { id: true }, take: 500 });
    for (const r of legacy) await this.prisma.$transaction((tx) => this.routeStep(tx, r.id, false));
  }

}
