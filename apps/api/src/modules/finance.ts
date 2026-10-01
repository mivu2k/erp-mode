import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { fromMinor, nextInstallment, settleClaim, toMinor } from '@erp/shared';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { sendReport } from '../engine/export';
import { HookCtx, HooksService, Row } from '../engine/hooks';
import { parse, ResourceService } from '../engine/resource.service';
import { WorkflowService } from '../engine/workflow.service';
import { NotifyService } from '../platform/notify.service';
import { Tx } from '../platform/audit.service';
import { LedgerService } from '../platform/ledger.service';
import { NumberingService } from '../platform/numbering.service';
import { PrismaService } from '../platform/prisma.service';
import { SettingsService } from '../platform/settings.service';
import { assertCan, AuthUser, can, CurrentUser, Permissions } from '../rbac/rbac';

const repayBody = z.object({
  mode: z.enum(['next_installment', 'custom_amount', 'full_settlement']).optional(),
  amount: z.coerce.number().positive().nullish(), accountId: z.string(), methodId: z.string().nullish(), idempotencyKey: z.string().max(100).optional(),
});
const moneyBody = z.object({ amount: z.coerce.number().positive(), accountId: z.string(), methodId: z.string().nullish(), idempotencyKey: z.string().max(100).optional() });
const voucherBody = z.object({ accountId: z.string(), methodId: z.string().nullish(), notes: z.string().max(2000).nullish() });
const claimPayBody = voucherBody.extend({ amount: z.coerce.number().positive().nullish() });
const adjustBody = z.object({ lines: z.array(z.object({ lineId: z.string(), approved: z.coerce.number().min(0) })).min(1), note: z.string().max(2000).nullish() });
/** What the company owes on a claim: the approved total (partial approval) or the claimed total. */
export const claimPayable = (c: { total?: unknown; approvedTotal?: unknown }) => toMinor((c.approvedTotal ?? c.total) as string);

@Controller('finance')
export class FinanceController {
  constructor(
    private prisma: PrismaService,
    private resources: ResourceService,
    private ledger: LedgerService,
    private numbering: NumberingService,
    private settings: SettingsService,
    private workflow: WorkflowService,
    private notify: NotifyService,
    hooks: HooksService,
  ) {
    hooks.on('finance.cash', {
      afterCreate: async ({ tx, user }, rec) => {
        if (rec.fromAccountId === rec.toAccountId) throw new BadRequestException('From and to accounts must differ');
        const je = await this.ledger.post(tx, {
          companyId: user.companyId, branchId: rec.branchId as string | null, date: rec.date as Date, memo: String(rec.memo ?? `Cash ${rec.number}`), sourceType: 'finance.cash', sourceId: String(rec.id), userId: user.id,
          lines: [{ accountId: String(rec.toAccountId), debit: Number(rec.amount) }, { accountId: String(rec.fromAccountId), credit: Number(rec.amount) }],
        });
        await tx.cashTransaction.update({ where: { id: String(rec.id) }, data: { journalId: je.id } });
      },
    });
    const employeeDefaults = async ({ tx, user }: HookCtx, data: Row) => {
      if (!data.employeeId) return;
      const emp = await tx.employee.findFirst({ where: { id: String(data.employeeId), companyId: user.companyId } });
      if (!emp) throw new BadRequestException('Unknown employee');
      data.departmentId = emp.departmentId;
      data.branchId = emp.branchId ?? data.branchId;
    };
    const advanceHooks = {
      beforeCreate: async (ctx: HookCtx, data: Row) => {
        await employeeDefaults(ctx, data);
        const n = Math.max(1, Number(data.installments ?? 1));
        data.installmentAmount = fromMinor(Math.ceil(toMinor(data.amount as string) / n));
      },
      beforeUpdate: (_ctx: HookCtx, data: Row, before: Row) => {
        const n = Math.max(1, Number(data.installments ?? before.installments ?? 1));
        data.installmentAmount = fromMinor(Math.ceil(toMinor((data.amount ?? before.amount) as string) / n));
      },
    };
    hooks.on('finance.advance', advanceHooks);
    hooks.on('finance.loan', advanceHooks);
    // Money moves only when the voucher's own approval completes; a rejected voucher hands the document back.
    hooks.on('finance.voucher', {
      onApproved: ({ tx, user }, rec) => this.executeVoucher(tx, user, rec),
      onRejected: async ({ tx, user }, rec) => {
        const booked = rec.sourceType === 'finance.claim' && (await tx.expenseClaim.findUnique({ where: { id: String(rec.sourceId) } }))?.booked;
        await this.resources.setStatus(tx, user, String(rec.sourceType), String(rec.sourceId), booked ? 'partially_paid' : 'approved');
      },
    });
    const claimTotals = async (ctx: HookCtx, data: Row, before?: Row) => {
      const lines = data.lines as Row[] | undefined;
      if (lines) {
        data.total = fromMinor(lines.reduce((s, l) => s + toMinor(l.amount as string) + toMinor(l.tax as string), 0));
        data.approvedTotal = null; // edited lines need a fresh approval
        for (const l of lines) delete l.approved;
      }
      const mode = data.mode ?? before?.mode;
      const advanceId = data.advanceId ?? before?.advanceId;
      if (mode === 'against_advance') {
        const adv = await ctx.tx.advance.findFirst({ where: { id: String(advanceId ?? ''), companyId: ctx.user.companyId, employeeId: String(data.employeeId ?? before?.employeeId), kind: 'expense', status: 'disbursed' } });
        if (!adv) throw new BadRequestException('Pick a disbursed expense advance of the same employee');
      }
    };
    hooks.on('payables.due', {
      beforeCreate: async ({ tx, user }, data) => {
        const party = data.customerId ? await tx.customer.findFirst({ where: { id: String(data.customerId), companyId: user.companyId } })
          : data.vendorId ? await tx.vendor.findFirst({ where: { id: String(data.vendorId), companyId: user.companyId } })
          : data.employeeId ? await tx.employee.findFirst({ where: { id: String(data.employeeId), companyId: user.companyId } }) : null;
        data.partyType = data.customerId ? 'customer' : data.vendorId ? 'vendor' : data.employeeId ? 'employee' : 'other';
        if (party) data.partyName = party.name;
        if (!data.partyName) throw new BadRequestException('Pick a customer, vendor or employee, or type a party name');
        const acc = await tx.account.findFirst({ where: { id: String(data.accountId), companyId: user.companyId, isGroup: false } });
        if (!acc) throw new BadRequestException('Pick a posting (non-group) account');
      },
      // Posts the due; with repeatMonths > 1 also creates the following monthly dues (rent, EMIs…).
      afterCreate: async ({ tx, user, body }, rec) => {
        await this.postDue(tx, user, rec);
        const n = Math.min(Math.max(Number(body?.repeatMonths ?? 1), 1), 60);
        const first = rec.dueDate as Date;
        for (let i = 1; i < n; i++) {
          const dueDate = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, first.getUTCDate()));
          const { id: _id, number: _n, journalId: _j, createdAt: _c, updatedAt: _u, ...rest } = rec;
          const copy = await tx.due.create({
            data: { ...(rest as Prisma.DueUncheckedCreateInput), dueDate, paid: 0, status: 'open', number: await this.numbering.next(tx, user.companyId, rec.branchId as string | null, 'DUE', 'DUE-{YYYY}-{SEQ:5}', dueDate) },
          });
          await this.postDue(tx, user, copy as unknown as Row);
        }
      },
    });
    hooks.on('finance.claim', {
      beforeCreate: async (ctx, data) => {
        await employeeDefaults(ctx, data);
        await claimTotals(ctx, data);
      },
      beforeUpdate: (ctx, data, before) => claimTotals(ctx, data, before),
      onApproved: async ({ tx, user }, rec) => { await this.settleCovered(tx, user, rec); },
      // Drafts can be saved without receipts; they're required when the claim goes for approval.
      beforeSubmit: async ({ tx, user }, rec) => {
        const lines = await tx.expenseClaimLine.findMany({ where: { claimId: String(rec.id) } });
        if (!lines.length) throw new BadRequestException('Add at least one expense line');
        const threshold = toMinor((await this.settings.get(user.companyId, 'finance.claims')).receiptThreshold);
        const missing = threshold > 0 ? lines.filter((l) => toMinor(l.amount) + toMinor(l.tax) > threshold && !l.attachmentId).length : 0;
        if (missing) throw new BadRequestException(`Attach a receipt to ${missing} line(s) above ${fromMinor(threshold)} before submitting`);
      },
    });
  }

  /** Expense advances and salary advances/loans share one table; `kind` picks the screen (and its permissions). */
  private async loadAdvance(tx: Tx, user: AuthUser, id: string, action = 'view') {
    const kind = (await tx.advance.findFirst({ where: { id, companyId: user.companyId }, select: { kind: true } }))?.kind;
    const key = kind === 'salary' ? 'finance.loan' : 'finance.advance';
    return { a: await this.resources.load(tx, user, key, id, action), key };
  }

  /** Creates a draft payment voucher, marks the source, then sends the voucher into its approval workflow. */
  private async prepareVoucher(user: AuthUser, make: (tx: Tx) => Promise<Omit<Prisma.PaymentVoucherUncheckedCreateInput, 'companyId'>>, source: { key: string; id: string; status: string }) {
    const voucher = await this.prisma.$transaction(async (tx) => {
      if (await tx.paymentVoucher.count({ where: { sourceType: source.key, sourceId: source.id, status: { in: ['draft', 'pending', 'returned'] }, deletedAt: null } })) {
        throw new BadRequestException('A voucher for this document is already waiting for approval');
      }
      const data = await make(tx);
      const v = await tx.paymentVoucher.create({ data: { ...data, companyId: user.companyId, createdById: user.id, number: await this.numbering.next(tx, user.companyId, data.branchId, 'PV', 'PV-{YYYY}-{SEQ:5}') } });
      await this.resources.setStatus(tx, user, source.key, source.id, source.status);
      return v;
    });
    const wf = await this.workflow.submit(user, 'finance.voucher', voucher.id);
    return { voucherId: voucher.id, number: voucher.number, ...wf };
  }

  /** Step 1 of paying out an approved advance/loan: a disbursement voucher (approved separately before cash moves). */
  @Post('advances/:id/disburse')
  @Permissions('finance.voucher.create')
  async disburse(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(voucherBody, body);
    const { a, key } = await this.prisma.$transaction((tx) => this.loadAdvance(tx, user, id));
    if (a.status !== 'approved') throw new BadRequestException('Advance must be approved first');
    return this.prepareVoucher(user, async () => ({
      purpose: key === 'finance.loan' ? 'loan_disbursement' : 'advance_disbursement', sourceType: key, sourceId: id, employeeId: String(a.employeeId),
      branchId: a.branchId as string | null, departmentId: a.departmentId as string | null, amount: String(a.amount), accountId: b.accountId, methodId: b.methodId, notes: b.notes ?? (a.purpose as string | null),
    }), { key, id, status: 'disbursement_pending' });
  }

  /** Employee returns unspent advance cash / pays off a loan early. */
  /** From a settled claim: the employee hands back what's left of the advance it was spent against. */
  @Post('claims/:id/return-advance')
  @Permissions('finance.payment.create')
  async returnFromClaim(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const c = await this.prisma.$transaction((tx) => this.resources.load(tx, user, 'finance.claim', id, 'view'));
    if (c.mode !== 'against_advance' || !c.advanceId) throw new BadRequestException('This claim was not against an advance');
    return this.returnCash(user, String(c.advanceId), { ...(body as object), mode: 'full_settlement' });
  }

  @Post('advances/:id/return')
  @Permissions('finance.payment.create')
  returnCash(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(repayBody, body);
    return this.prisma.$transaction(async (tx) => {
      const { a, key } = await this.loadAdvance(tx, user, id);
      if (a.status !== 'disbursed') throw new BadRequestException('Advance is not outstanding');
      // Repay the next installment (default), any custom amount, or everything that's left.
      const plan = nextInstallment({ amount: toMinor(a.amount as string), installments: Number(a.installments), recovered: toMinor(a.recovered as string) });
      const mode = b.mode ?? (b.amount ? 'custom_amount' : 'next_installment');
      if (mode === 'custom_amount' && !b.amount) throw new BadRequestException('Enter the amount');
      const minor = mode === 'full_settlement' ? plan.outstanding : mode === 'next_installment' ? plan.due : toMinor(b.amount!);
      const outstanding = plan.outstanding;
      if (minor > outstanding) throw new BadRequestException(`Outstanding is ${fromMinor(outstanding)}`);
      const amount = fromMinor(minor);
      const reference = mode === 'full_settlement' || minor === outstanding ? `Full settlement (after installment ${plan.no - 1}/${plan.of})`
        : mode === 'next_installment' ? `Installment ${plan.no}/${plan.of}` : `Part payment — installment ${plan.no}/${plan.of}`;
      const emp = String(a.employeeId);
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, memo: `Advance repayment ${a.number} — ${reference}`, sourceType: key, sourceId: id, userId: user.id,
        lines: [{ accountId: b.accountId, debit: amount }, { accountId: await this.ledger.employeeAccount(tx, user.companyId, emp), credit: amount, employeeId: emp }],
      });
      await this.payment(tx, user, { direction: 'in', partyType: 'employee', partyId: emp, refType: key, refId: id, amount, accountId: b.accountId, methodId: b.methodId, journalId: je.id, idempotencyKey: b.idempotencyKey, reference });
      const recovered = toMinor(a.recovered as string) + minor;
      await this.resources.setStatus(tx, user, key, id, recovered >= toMinor(a.amount as string) ? 'settled' : 'disbursed', { recovered: fromMinor(recovered) });
      const next = nextInstallment({ amount: toMinor(a.amount as string), installments: Number(a.installments), recovered });
      return { reference, paid: amount, outstanding: fromMinor(outstanding - minor), next: next.outstanding ? { installment: `${next.no}/${next.of}`, due: fromMinor(next.due) } : null };
    });
  }

  /**
   * Step 1 of paying an approved claim: a reimbursement/settlement voucher showing the split.
   * Direct: company reimburses the total. Against advance: the advance absorbs what it can, the excess is reimbursed,
   * and any unspent remainder stays on the advance (refundDue) for the employee to return.
   */
  /** What the claim form needs to guide the employee (anyone who can file a claim may read it). */
  @Get('claims/policy')
  @Permissions('finance.claim.view')
  async claimPolicy(@CurrentUser() user: AuthUser) {
    // Expense types come with the policy: claimants rarely have master-data access.
    const heads = await this.prisma.masterData.findMany({ where: { companyId: user.companyId, type: 'expense_head', isActive: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, name: true } });
    return { receiptThreshold: Number((await this.settings.get(user.companyId, 'finance.claims')).receiptThreshold), heads };
  }

  @Post('claims/:id/pay')
  @Permissions('finance.voucher.create')
  async payClaim(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(claimPayBody, body);
    const c = await this.prisma.$transaction((tx) => this.resources.load(tx, user, 'finance.claim', id, 'view'));
    if (!['approved', 'partially_paid'].includes(String(c.status))) throw new BadRequestException('Claim must be approved first');
    if (await this.prisma.$transaction((tx) => this.settleCovered(tx, user, c))) return { settled: true, message: 'Covered by the advance — settled, no payment needed' };
    return this.prepareVoucher(user, async (tx) => {
      const s = await this.claimSettlement(tx, user, c);
      const paid = toMinor(c.reimbursed as string);
      const balance = s.reimburse - paid;
      // Partial reimbursement: pay part now, the rest on a later voucher.
      const amount = b.amount == null ? balance : toMinor(b.amount);
      if (amount > balance) throw new BadRequestException(`Only ${fromMinor(balance)} is left to reimburse`);
      return {
        purpose: 'claim_reimbursement', sourceType: 'finance.claim', sourceId: id, employeeId: String(c.employeeId), branchId: c.branchId as string | null, departmentId: c.departmentId as string | null,
        amount: String(fromMinor(amount)), accountId: b.accountId, methodId: b.methodId, notes: b.notes ?? (c.notes as string | null),
        breakdown: {
          claimed: fromMinor(toMinor(c.total as string)), approved: fromMinor(claimPayable(c)), fromAdvance: fromMinor(s.fromAdvance), reimburse: fromMinor(s.reimburse),
          alreadyPaid: fromMinor(paid), thisPayment: fromMinor(amount), balanceAfter: fromMinor(balance - amount), refundDue: fromMinor(s.refundDue),
        },
      };
    }, { key: 'finance.claim', id, status: 'payment_pending' });
  }

  /**
   * Partial approval: while the claim waits for approval, a current approver cuts or disallows lines.
   * The claim stays in the workflow; approving it then approves the reduced total.
   */
  @Post('claims/:id/adjust')
  @Permissions('finance.claim.approve')
  async adjustClaim(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(adjustBody, body);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.resources.load(tx, user, 'finance.claim', id, 'view');
      if (c.status !== 'pending') throw new BadRequestException('Only a claim waiting for approval can be adjusted');
      const req = await tx.approvalRequest.findFirst({ where: { companyId: user.companyId, resource: 'finance.claim', recordId: id, status: 'pending' } });
      if (!req) throw new BadRequestException('No approval pending');
      const admin = can(user, 'core.approval.manage');
      if (!admin && !(await this.workflow.resolve(tx, req)).all.includes(user.id)) throw new ForbiddenException('You are not an approver for this step');
      if (!admin && req.requestedById === user.id) throw new ForbiddenException('You cannot approve your own claim');
      const lines = await tx.expenseClaimLine.findMany({ where: { claimId: id } });
      const cut = new Map(b.lines.map((l) => [l.lineId, toMinor(l.approved)]));
      let total = 0;
      for (const l of lines) {
        const claimed = toMinor(l.amount) + toMinor(l.tax);
        const ok = cut.get(l.id) ?? claimed;
        if (ok > claimed) throw new BadRequestException(`Can't approve more than claimed (${fromMinor(claimed)}) on a line`);
        total += ok;
        await tx.expenseClaimLine.update({ where: { id: l.id }, data: { approved: ok === claimed ? null : fromMinor(ok) } });
      }
      const partial = total !== toMinor(c.total as string);
      if (partial && !b.note?.trim()) throw new BadRequestException('Give a reason for approving less than claimed');
      await tx.expenseClaim.update({ where: { id }, data: { approvedTotal: partial ? fromMinor(total) : null, approvalNote: partial ? b.note : null } });
      return { approvedTotal: fromMinor(total), claimed: fromMinor(toMinor(c.total as string)) };
    });
  }

  private async claimSettlement(tx: Tx, user: AuthUser, c: Row) {
    // Once booked, the advance split is fixed; before that it is taken against the advance's current balance.
    if (c.booked) return { fromAdvance: toMinor(c.fromAdvance as string), reimburse: claimPayable(c) - toMinor(c.fromAdvance as string), refundDue: toMinor(c.refundDue as string) };
    const total = claimPayable(c);
    if (c.mode !== 'against_advance') return { fromAdvance: 0, reimburse: total, refundDue: 0 };
    const adv = await tx.advance.findFirstOrThrow({ where: { id: String(c.advanceId), companyId: user.companyId } });
    return settleClaim(total, toMinor(adv.amount) - toMinor(adv.recovered));
  }


  /**
   * Books an approved claim once: the approved expense is debited, the employee's account credited, and the part covered
   * by the advance is taken off it. Returns the journal id (none when nothing was approved).
   */
  private async bookClaim(tx: Tx, user: AuthUser, c: Row, s: { fromAdvance: number }, empAccount: string) {
    const lines = await tx.expenseClaimLine.findMany({ where: { claimId: String(c.id) } });
    const heads = new Map((await tx.masterData.findMany({ where: { id: { in: lines.map((l) => l.headId) }, companyId: user.companyId } })).map((h) => [h.id, (h.value as { accountId?: string } | null)?.accountId]));
    const debit = lines.map((l) => {
      const acc = heads.get(l.headId);
      if (!acc) throw new BadRequestException('Expense head has no GL account (Master Data › expense_head › value.accountId)');
      return { accountId: acc, debit: fromMinor(l.approved != null ? toMinor(l.approved) : toMinor(l.amount) + toMinor(l.tax)), employeeId: String(c.employeeId), memo: l.description ?? undefined };
    }).filter((l) => l.debit > 0);
    if (c.mode === 'against_advance') {
      const adv = await tx.advance.findFirstOrThrow({ where: { id: String(c.advanceId) } });
      const recovered = toMinor(adv.recovered) + s.fromAdvance;
      await tx.advance.update({ where: { id: adv.id }, data: { recovered: fromMinor(recovered), status: recovered >= toMinor(adv.amount) ? 'settled' : 'disbursed' } });
    }
    if (debit.length) {
      return (await this.ledger.post(tx, {
        companyId: user.companyId, branchId: c.branchId as string | null, memo: `Expense claim ${c.number}`, sourceType: 'finance.claim', sourceId: String(c.id), userId: user.id,
        lines: [...debit, { accountId: empAccount, credit: fromMinor(claimPayable(c)), employeeId: String(c.employeeId) }],
      })).id;
    }
    return undefined;
  }

  /** A claim fully covered by its advance moves no cash: settle it straight away instead of via a zero voucher. */
  private async settleCovered(tx: Tx, user: AuthUser, c: Row) {
    const s = await this.claimSettlement(tx, user, c);
    if (c.mode !== 'against_advance' || c.booked || s.reimburse > 0) return false;
    await this.bookClaim(tx, user, c, s, await this.ledger.employeeAccount(tx, user.companyId, String(c.employeeId)));
    await this.resources.setStatus(tx, user, 'finance.claim', String(c.id), 'settled', { booked: true, fromAdvance: fromMinor(s.fromAdvance), reimbursed: '0', refundDue: fromMinor(s.refundDue) });
    return true;
  }

  /** Step 2 (runs when the voucher's approval completes): post to the ledger, record the payment, update the source. */
  private async executeVoucher(tx: Tx, user: AuthUser, v: Row) {
    const emp = String(v.employeeId);
    const accountId = String(v.accountId);
    const sourceId = String(v.sourceId);
    const empAccount = await this.ledger.employeeAccount(tx, user.companyId, emp);
    let journalId: string | undefined;
    if (v.purpose === 'claim_reimbursement') {
      const c = await tx.expenseClaim.findUniqueOrThrow({ where: { id: sourceId } });
      if (c.status !== 'payment_pending') throw new BadRequestException(`Claim ${c.number} is ${c.status}`);
      const s = await this.claimSettlement(tx, user, c as unknown as Row);
      if (!c.booked) journalId = await this.bookClaim(tx, user, c as unknown as Row, s, empAccount);
      const amount = toMinor(v.amount as string);
      if (amount) {
        journalId = (await this.ledger.post(tx, {
          companyId: user.companyId, branchId: c.branchId, memo: `Reimbursement ${c.number} (${v.number})`, sourceType: 'finance.claim', sourceId, userId: user.id,
          lines: [{ accountId: empAccount, debit: fromMinor(amount), employeeId: emp }, { accountId, credit: fromMinor(amount) }],
        })).id;
        await this.payment(tx, user, { direction: 'out', partyType: 'employee', partyId: emp, refType: 'finance.claim', refId: sourceId, amount: fromMinor(amount), accountId, journalId, methodId: v.methodId as string | null });
      }
      const reimbursed = toMinor(c.reimbursed) + amount;
      const done = reimbursed >= s.reimburse;
      await this.resources.setStatus(tx, user, 'finance.claim', sourceId, !done ? 'partially_paid' : c.mode === 'against_advance' ? 'settled' : 'paid',
        { booked: true, fromAdvance: fromMinor(s.fromAdvance), reimbursed: fromMinor(reimbursed), refundDue: fromMinor(s.refundDue) });
    } else {
      const key = String(v.sourceType);
      const a = await tx.advance.findUniqueOrThrow({ where: { id: sourceId } });
      if (a.status !== 'disbursement_pending') throw new BadRequestException(`Advance ${a.number} is ${a.status}`);
      const je = await this.ledger.post(tx, {
        companyId: user.companyId, branchId: a.branchId, memo: `${a.kind === 'salary' ? 'Salary advance/loan' : 'Advance'} ${a.number} (${v.number})`, sourceType: key, sourceId, userId: user.id,
        lines: [{ accountId: empAccount, debit: Number(a.amount), employeeId: emp }, { accountId, credit: Number(a.amount) }],
      });
      journalId = je.id;
      await this.payment(tx, user, { direction: 'out', partyType: 'employee', partyId: emp, refType: key, refId: sourceId, amount: Number(a.amount), accountId, journalId, methodId: v.methodId as string | null });
      await this.resources.setStatus(tx, user, key, sourceId, 'disbursed', { disbursedAt: new Date() });
    }
    await this.resources.setStatus(tx, user, 'finance.voucher', String(v.id), 'paid', { paidAt: new Date(), journalId });
    await this.notify.send(user.companyId, [await this.notify.employeeUser(emp, tx)], { title: `Payment released: ${v.number}`, link: `/r/finance.voucher/${v.id}` }, tx);
  }

  /** Receivable: Dr Receivable / Cr income account. Payable: Dr expense account / Cr Payable. */
  async postDue(tx: Tx, user: AuthUser, rec: Row) {
    const acc = await this.ledger.accounts(user.companyId);
    const amount = Number(rec.amount);
    const party = this.dueParty(rec);
    const lines = rec.direction === 'receivable'
      ? [{ accountId: acc.receivable, debit: amount, ...party }, { accountId: String(rec.accountId), credit: amount }]
      : [{ accountId: String(rec.accountId), debit: amount }, { accountId: acc.payable, credit: amount, ...party }];
    const je = await this.ledger.post(tx, { companyId: user.companyId, branchId: rec.branchId as string | null, date: rec.dueDate as Date, memo: `${rec.direction === 'receivable' ? 'Receivable' : 'Payable'} ${rec.number}: ${rec.description ?? rec.partyName}`, sourceType: 'payables.due', sourceId: String(rec.id), userId: user.id, lines });
    await tx.due.update({ where: { id: String(rec.id) }, data: { journalId: je.id } });
  }

  private dueParty(rec: Row): { partyType?: string; partyId?: string; employeeId?: string } {
    const partyId = (rec.customerId ?? rec.vendorId ?? rec.employeeId) as string | null;
    return partyId ? { partyType: String(rec.partyType), partyId, ...(rec.employeeId ? { employeeId: String(rec.employeeId) } : {}) } : {};
  }

  @Post('dues/:id/pay')
  @Permissions('finance.payment.create')
  payDue(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(moneyBody, body);
    return this.prisma.$transaction(async (tx) => {
      const d = await this.resources.load(tx, user, 'payables.due', id, 'view');
      if (!['open', 'partially_paid'].includes(String(d.status))) throw new BadRequestException('Nothing outstanding');
      const due = toMinor(d.amount as string) - toMinor(d.paid as string);
      if (toMinor(b.amount) > due) throw new BadRequestException(`Only ${fromMinor(due)} is outstanding`);
      const acc = await this.ledger.accounts(user.companyId);
      const party = this.dueParty(d);
      const lines = d.direction === 'receivable'
        ? [{ accountId: b.accountId, debit: b.amount }, { accountId: acc.receivable, credit: b.amount, ...party }]
        : [{ accountId: acc.payable, debit: b.amount, ...party }, { accountId: b.accountId, credit: b.amount }];
      const je = await this.ledger.post(tx, { companyId: user.companyId, memo: `Payment ${d.number}`, sourceType: 'payables.due', sourceId: id, userId: user.id, lines });
      await this.payment(tx, user, { direction: d.direction === 'receivable' ? 'in' : 'out', partyType: String(d.partyType), partyId: String(party.partyId ?? d.partyName), refType: 'payables.due', refId: id, amount: b.amount, accountId: b.accountId, methodId: b.methodId, journalId: je.id, idempotencyKey: b.idempotencyKey });
      const paid = toMinor(d.paid as string) + toMinor(b.amount);
      const settled = paid >= toMinor(d.amount as string);
      await this.resources.setStatus(tx, user, 'payables.due', id, settled ? 'settled' : 'partially_paid', { paid: fromMinor(paid) });
      // A utility bill rides on this due: keep it in step however it's paid (from the bill or from P & R).
      await tx.utilityBill.updateMany({ where: { dueId: id, companyId: user.companyId }, data: { paid: fromMinor(paid), status: settled ? 'paid' : 'partially_paid', ...(settled ? { paidAt: new Date() } : {}) } });
      return { outstanding: fromMinor(due - toMinor(b.amount)) };
    });
  }

  /**
   * One timeline of everything owed either way: manual dues + unpaid customer invoices + open vendor bills,
   * with running totals. Invoices have no due date field, so their invoice date is used.
   */
  @Get('dues/timeline')
  async timeline(@CurrentUser() user: AuthUser, @Query() q: { direction?: string; to?: string }) {
    const to = q.to ? new Date(q.to) : undefined;
    const items: DueItem[] = [];
    if (can(user, 'payables.due.view')) {
      const where = await this.resources.where(user, this.resources.meta('payables.due'), { filters: { status: { in: ['open', 'partially_paid'] }, ...(q.direction ? { direction: q.direction } : {}) } });
      for (const d of await this.prisma.due.findMany({ where: { ...where, ...(to ? { dueDate: { lte: to } } : {}) } as Prisma.DueWhereInput, take: 2000 })) {
        items.push({ source: 'payables.due', id: d.id, number: d.number ?? '', direction: d.direction as DueItem['direction'], party: d.partyName ?? '', description: d.description ?? '', dueDate: d.dueDate, amount: Number(d.amount), paid: Number(d.paid) });
      }
    }
    if (q.direction !== 'payable' && can(user, 'repair.invoice.view')) {
      const where = await this.resources.where(user, this.resources.meta('repair.invoice'), { filters: { status: { in: ['unpaid', 'partially_paid'] } } });
      const inv = await this.prisma.invoice.findMany({ where: { ...where, ...(to ? { date: { lte: to } } : {}) } as Prisma.InvoiceWhereInput, take: 2000 });
      const names = new Map((await this.prisma.customer.findMany({ where: { id: { in: inv.map((i) => i.customerId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
      // Due = invoice date + the company's credit terms.
      const days = Number((await this.settings.get(user.companyId, 'finance.terms')).invoiceDays) || 0;
      for (const i of inv) items.push({ source: 'repair.invoice', id: i.id, number: i.number ?? '', direction: 'receivable', party: names.get(i.customerId) ?? '', description: `Invoice · ${days}-day terms`, dueDate: new Date(+i.date + days * DAY), amount: Number(i.total) - Number(i.credited), paid: Number(i.paid) });
    }
    if (q.direction !== 'receivable' && can(user, 'purchase.bill.view')) {
      const where = await this.resources.where(user, this.resources.meta('purchase.bill'), { filters: { status: { in: ['open', 'partially_paid'] } } });
      const bills = await this.prisma.vendorBill.findMany({ where: where as Prisma.VendorBillWhereInput, take: 2000 });
      const names = new Map((await this.prisma.vendor.findMany({ where: { id: { in: bills.map((b) => b.vendorId) } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
      for (const b of bills) {
        const dueDate = b.dueDate ?? b.date;
        if (!to || dueDate <= to) items.push({ source: 'purchase.bill', id: b.id, number: b.number ?? '', direction: 'payable', party: names.get(b.vendorId) ?? '', description: b.vendorRef ? `Bill ${b.vendorRef}` : 'Vendor bill', dueDate, amount: Number(b.amount), paid: Number(b.paid) });
      }
    }
    // Opening point for the forecast: what's in cash and bank accounts right now.
    let cash = 0;
    if (can(user, 'finance.report.view') || can(user, 'finance.account.view')) {
      const accs = await this.prisma.account.findMany({ where: { companyId: user.companyId, OR: [{ isCash: true }, { isBank: true }] }, select: { id: true } });
      const agg = await this.prisma.journalLine.aggregate({ where: { companyId: user.companyId, accountId: { in: accs.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
      cash = fromMinor(toMinor(agg._sum.debit ?? 0) - toMinor(agg._sum.credit ?? 0));
    }
    return summarizeDues(items, new Date(), cash);
  }

  async payment(tx: Tx, user: AuthUser, p: { direction: string; partyType: string; partyId: string; refType: string; refId: string; amount: number; accountId: string; journalId: string; methodId?: string | null; idempotencyKey?: string; reference?: string }) {
    const number = await this.numbering.next(tx, user.companyId, user.branchId, 'PMT', 'PMT-{YYYY}-{SEQ:5}');
    return tx.payment.create({ data: { companyId: user.companyId, branchId: user.branchId, number, date: new Date(), createdById: user.id, ...p } });
  }

  // ─── Statements & reports ──────────────────────────────────

  /** Running statement for an employee (advances + salary), customer (receivable) or vendor (payable). Own scope applies. */
  @Get('statement/:party/:id')
  async statement(@CurrentUser() user: AuthUser, @Param('party') party: string, @Param('id') id: string, @Query() q: { from?: string; to?: string; format?: string }, @Res() res: Response) {
    const acc = await this.ledger.accounts(user.companyId);
    let where: Record<string, unknown>;
    let name: string;
    if (party === 'employee') {
      const emp = await this.resources.get(user, 'hrm.employee', id).catch(() => null);
      const own = user.employeeId === id;
      if (!own) assertCan(user, 'finance.statement.view');
      if (!emp && !own) throw new NotFoundException();
      const e = await this.prisma.employee.findFirstOrThrow({ where: { id, companyId: user.companyId } });
      name = e.name;
      where = { employeeId: id, accountId: { in: [e.accountId ?? '', acc.salaryPayable] } };
    } else if (party === 'customer' || party === 'vendor') {
      assertCan(user, 'finance.statement.view');
      const p = party === 'customer' ? await this.prisma.customer.findFirstOrThrow({ where: { id, companyId: user.companyId } }) : await this.prisma.vendor.findFirstOrThrow({ where: { id, companyId: user.companyId } });
      name = p.name;
      where = { partyType: party, partyId: id, accountId: party === 'customer' ? acc.receivable : acc.payable };
    } else throw new BadRequestException();
    return this.ledgerReport(user, res, q, where, `Statement — ${name}`);
  }

  @Get('ledger/:accountId')
  @Permissions('finance.account.view')
  async accountLedger(@CurrentUser() user: AuthUser, @Param('accountId') accountId: string, @Query() q: { from?: string; to?: string; format?: string }, @Res() res: Response) {
    const a = await this.prisma.account.findFirstOrThrow({ where: { id: accountId, companyId: user.companyId } });
    return this.ledgerReport(user, res, q, { accountId }, `Ledger — ${a.code} ${a.name}`);
  }

  private async ledgerReport(user: AuthUser, res: Response, q: { from?: string; to?: string; format?: string }, where: Record<string, unknown>, title: string) {
    const base = { companyId: user.companyId, entry: { deletedAt: null }, ...where };
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const opening = from ? await this.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { ...base, date: { lt: from } } }) : null;
    let bal = opening ? toMinor(opening._sum.debit) - toMinor(opening._sum.credit) : 0;
    const lines = await this.prisma.journalLine.findMany({ where: { ...base, date: { gte: from, lte: to } }, include: { entry: { select: { number: true, memo: true } } }, orderBy: [{ date: 'asc' }, { id: 'asc' }], take: 20_000 });
    const rows: Row[] = [{ date: from?.toISOString().slice(0, 10) ?? '', voucher: '', memo: 'Opening balance', debit: '', credit: '', balance: fromMinor(bal) }];
    for (const l of lines) {
      bal += toMinor(l.debit) - toMinor(l.credit);
      rows.push({ date: l.date.toISOString().slice(0, 10), voucher: l.entry.number, memo: l.memo ?? l.entry.memo ?? '', debit: Number(l.debit) || '', credit: Number(l.credit) || '', balance: fromMinor(bal) });
    }
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, q.format, { title, company, columns: ['date', 'voucher', 'memo', 'debit', 'credit', 'balance'], rows, totals: [['Closing balance', fromMinor(bal)]] });
  }

  /** Every account with its balance (debit − credit, all time), for the chart-of-accounts tree. */
  @Get('accounts/chart')
  @Permissions('finance.account.view')
  async chart(@CurrentUser() user: AuthUser) {
    const [accounts, sums] = await Promise.all([
      this.prisma.account.findMany({ where: { companyId: user.companyId, deletedAt: null }, select: { id: true, code: true, name: true, type: true, parentId: true, isCash: true, isBank: true, isGroup: true, employeeId: true }, orderBy: { code: 'asc' } }),
      this.prisma.journalLine.groupBy({ by: ['accountId'], _sum: { debit: true, credit: true }, _max: { date: true }, where: { companyId: user.companyId, entry: { deletedAt: null } } }),
    ]);
    const bal = new Map(sums.map((s) => [s.accountId, { balance: fromMinor(toMinor(s._sum.debit) - toMinor(s._sum.credit)), lastActivity: s._max.date }]));
    return accounts.map((a) => ({ ...a, balance: 0, lastActivity: null, ...bal.get(a.id) }));
  }

  @Get('trial-balance')
  @Permissions('finance.report.view')
  async trialBalance(@CurrentUser() user: AuthUser, @Query() q: { to?: string; format?: string }, @Res() res: Response) {
    const sums = await this.prisma.journalLine.groupBy({ by: ['accountId'], _sum: { debit: true, credit: true }, where: { companyId: user.companyId, entry: { deletedAt: null }, ...(q.to ? { date: { lte: new Date(q.to) } } : {}) } });
    const accounts = new Map((await this.prisma.account.findMany({ where: { companyId: user.companyId } })).map((a) => [a.id, a]));
    let dr = 0;
    let cr = 0;
    const rows: Row[] = sums.map((s) => {
      const net = toMinor(s._sum.debit) - toMinor(s._sum.credit);
      const a = accounts.get(s.accountId);
      if (net > 0) dr += net; else cr -= net;
      return { code: a?.code, account: a?.name, type: a?.type, debit: net > 0 ? fromMinor(net) : '', credit: net < 0 ? fromMinor(-net) : '' };
    }).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, q.format, { title: 'Trial Balance', company, columns: ['code', 'account', 'type', 'debit', 'credit'], rows, totals: [['Debit', fromMinor(dr)], ['Credit', fromMinor(cr)]] });
  }

  @Get('advances/aging')
  @Permissions('finance.report.view')
  async aging(@CurrentUser() user: AuthUser, @Query('format') format: string | undefined, @Res() res: Response) {
    const open = await this.prisma.advance.findMany({ where: { companyId: user.companyId, status: 'disbursed', deletedAt: null } });
    const emps = new Map((await this.prisma.employee.findMany({ where: { id: { in: open.map((a) => a.employeeId) } } })).map((e) => [e.id, e.name]));
    const rows: Row[] = open.map((a) => {
      const days = Math.floor((Date.now() - +(a.disbursedAt ?? a.createdAt)) / 86_400_000);
      return { number: a.number, employee: emps.get(a.employeeId), kind: a.kind, outstanding: fromMinor(toMinor(a.amount) - toMinor(a.recovered)), days, bucket: days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+' };
    });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } });
    return sendReport(res, format, { title: 'Outstanding Advances', company, columns: ['number', 'employee', 'kind', 'outstanding', 'days', 'bucket'], rows });
  }
}

export interface DueItem { source: string; id: string; number: string; direction: 'payable' | 'receivable'; party: string; description: string; dueDate: Date; amount: number; paid: number }

/** Sorts by due date, adds balance/bucket, and totals each direction (minor-unit maths). */
const DAY = 86_400_000;
export const AGING = ['current', '1-30', '31-60', '61-90', '90+'] as const;
const agingOf = (daysOverdue: number) => (daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+');

/**
 * Everything the P&R screen shows, from open items: rows with days overdue, the timeline buckets, aging per side,
 * an 8-week cash forecast starting from today's cash+bank (overdue items are expected in week 1), and per-party totals.
 */
export function summarizeDues(items: DueItem[], now: Date, cash = 0) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rows = items
    .map((i) => {
      const balance = fromMinor(toMinor(i.amount) - toMinor(i.paid));
      const t = Date.UTC(i.dueDate.getUTCFullYear(), i.dueDate.getUTCMonth(), i.dueDate.getUTCDate());
      const daysOverdue = Math.round((today - t) / DAY);
      const bucket = daysOverdue > 0 ? 'overdue' : daysOverdue > -7 ? 'this_week' : daysOverdue > -30 ? 'this_month' : 'later';
      return { ...i, balance, daysOverdue, bucket, aging: agingOf(daysOverdue) };
    })
    .filter((r) => r.balance > 0)
    .sort((a, b) => +a.dueDate - +b.dueDate);
  const m = (xs: typeof rows) => xs.reduce((s, r) => s + toMinor(r.balance), 0);
  const side = (dir: string) => rows.filter((r) => r.direction === dir);
  const sum = (dir: string, bucket?: string) => fromMinor(m(side(dir).filter((r) => !bucket || r.bucket === bucket)));
  const aging = Object.fromEntries(['receivable', 'payable'].map((dir) => [dir, Object.fromEntries(AGING.map((a) => [a, fromMinor(m(side(dir).filter((r) => r.aging === a)))]))]));
  // Week 0 = today..+6 days (plus everything overdue); the running balance starts from cash in hand + bank.
  let bal = toMinor(cash);
  const forecast = Array.from({ length: 8 }, (_, w) => {
    const inWeek = (r: (typeof rows)[number]) => { const k = Math.max(0, Math.floor(-r.daysOverdue / 7)); return k === w; };
    const inn = m(side('receivable').filter(inWeek));
    const out = m(side('payable').filter(inWeek));
    bal += inn - out;
    return { week: w, start: new Date(today + w * 7 * DAY).toISOString().slice(0, 10), in: fromMinor(inn), out: fromMinor(out), balance: fromMinor(bal) };
  });
  const later = rows.filter((r) => -r.daysOverdue >= 56);
  const byParty = new Map<string, { party: string; direction: string; balance: number; count: number; oldest: string; maxOverdue: number }>();
  for (const r of rows) {
    const k = `${r.direction}|${r.party}`;
    const p = byParty.get(k) ?? { party: r.party || '—', direction: r.direction, balance: 0, count: 0, oldest: r.dueDate.toISOString().slice(0, 10), maxOverdue: r.daysOverdue };
    p.balance = fromMinor(toMinor(p.balance) + toMinor(r.balance));
    p.count++;
    p.maxOverdue = Math.max(p.maxOverdue, r.daysOverdue);
    byParty.set(k, p);
  }
  const receivable = sum('receivable');
  const payable = sum('payable');
  return {
    totals: {
      receivable, payable,
      overdueReceivable: sum('receivable', 'overdue'), overduePayable: sum('payable', 'overdue'),
      net: fromMinor(toMinor(receivable) - toMinor(payable)),
      cash, projected: fromMinor(toMinor(cash) + toMinor(receivable) - toMinor(payable)),
      beyondForecast: { in: fromMinor(m(later.filter((r) => r.direction === 'receivable'))), out: fromMinor(m(later.filter((r) => r.direction === 'payable'))) },
    },
    rows, aging, forecast,
    parties: [...byParty.values()].sort((a, b) => b.balance - a.balance),
  };
}
