import { BadRequestException, Injectable } from '@nestjs/common';
import { fromMinor, isBalanced, toMinor } from '@erp/shared';
import { Tx } from './audit.service';
import { NumberingService } from './numbering.service';
import { SettingsService } from './settings.service';

export interface PostLine { accountId: string; debit?: number; credit?: number; employeeId?: string | null; partyType?: string; partyId?: string; memo?: string }
export interface PostInput { companyId: string; branchId?: string | null; date?: Date; memo: string; sourceType?: string; sourceId?: string; userId?: string; lines: PostLine[] }

@Injectable()
export class LedgerService {
  constructor(private numbering: NumberingService, private settings: SettingsService) {}

  /** Double-entry posting. Zero lines are dropped; must balance to the paisa. */
  async post(tx: Tx, p: PostInput) {
    const lines = p.lines.filter((l) => toMinor(l.debit) !== 0 || toMinor(l.credit) !== 0);
    if (!isBalanced(lines)) throw new BadRequestException('Journal does not balance');
    if (lines.some((l) => !l.accountId)) throw new BadRequestException('Missing account in posting — configure Settings › finance.accounts');
    const date = p.date ?? new Date();
    const number = await this.numbering.next(tx, p.companyId, p.branchId, 'JV', 'JV-{YYYY}-{SEQ:6}', date);
    return tx.journalEntry.create({
      data: {
        companyId: p.companyId, branchId: p.branchId, number, date, memo: p.memo, amount: fromMinor(lines.reduce((t, l) => t + toMinor(l.debit), 0)), sourceType: p.sourceType, sourceId: p.sourceId, createdById: p.userId,
        lines: {
          create: lines.map((l) => ({
            companyId: p.companyId, accountId: l.accountId, employeeId: l.employeeId, partyType: l.partyType, partyId: l.partyId, memo: l.memo, date,
            debit: fromMinor(toMinor(l.debit)), credit: fromMinor(toMinor(l.credit)),
          })),
        },
      },
    });
  }

  async accounts(companyId: string) {
    return this.settings.get(companyId, 'finance.accounts');
  }

  /** Personal sub-ledger account for an employee/director (created on demand). */
  async employeeAccount(tx: Tx, companyId: string, employeeId: string): Promise<string> {
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    if (emp.accountId) return emp.accountId;
    const acc = await this.accounts(companyId);
    const account = await tx.account.create({
      data: { companyId, parentId: acc.advances || null, code: `EMP-${emp.code}`, name: `${emp.isDirector ? 'Director' : 'Employee'} – ${emp.name}`, type: 'asset', employeeId },
    });
    await tx.employee.update({ where: { id: employeeId }, data: { accountId: account.id } });
    return account.id;
  }
}
