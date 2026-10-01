import { Injectable } from '@nestjs/common';
import { formatNumber, periodKey } from '@erp/shared';
import { Tx } from './audit.service';

@Injectable()
export class NumberingService {
  /**
   * Next document number. Must run inside a transaction: the SELECT ... FOR UPDATE row lock serializes
   * concurrent callers so numbers are never duplicated. A branch-specific sequence wins over the company-wide one.
   */
  async next(tx: Tx, companyId: string, branchId: string | null | undefined, docType: string, defaultPattern: string, date = new Date()): Promise<string> {
    const branch = branchId ? await tx.branch.findUnique({ where: { id: branchId }, select: { code: true } }) : null;
    let rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM Sequence WHERE companyId = ${companyId} AND docType = ${docType} AND branchId IN (${branchId ?? ''}, '')
      ORDER BY branchId DESC LIMIT 1 FOR UPDATE`;
    if (!rows.length) {
      await tx.sequence.createMany({ data: [{ companyId, branchId: '', docType, pattern: defaultPattern }], skipDuplicates: true });
      rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM Sequence WHERE companyId = ${companyId} AND branchId = '' AND docType = ${docType} FOR UPDATE`;
    }
    const seq = await tx.sequence.findUniqueOrThrow({ where: { id: rows[0].id } });
    const period = periodKey(seq.reset, date);
    const current = period === seq.period ? seq.current + 1 : 1;
    await tx.sequence.update({ where: { id: seq.id }, data: { current, period } });
    return formatNumber(seq.pattern, current, date, branch?.code ?? '');
  }
}
