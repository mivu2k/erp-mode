import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Tx } from './audit.service';

export interface Notice { title: string; body?: string; link?: string }

@Injectable()
export class NotifyService {
  constructor(private prisma: PrismaService) {}

  // ponytail: in-app only (polled by web). Email/push/WebSocket fan-out plugs in here when SMTP/FCM creds exist.
  async send(companyId: string, userIds: (string | null | undefined)[], n: Notice, tx: Tx = this.prisma) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (ids.length) await tx.notification.createMany({ data: ids.map((userId) => ({ companyId, userId, ...n })) });
  }

  async toRole(companyId: string, roleId: string, n: Notice, tx: Tx = this.prisma) {
    const users = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
    await this.send(companyId, users.map((u) => u.userId), n, tx);
  }

  /** User id of an employee, if the employee has a login. */
  async employeeUser(employeeId: string | null | undefined, tx: Tx = this.prisma) {
    if (!employeeId) return null;
    return (await tx.employee.findUnique({ where: { id: employeeId }, select: { userId: true } }))?.userId ?? null;
  }
}
