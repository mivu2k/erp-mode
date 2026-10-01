import { BadRequestException, Injectable } from '@nestjs/common';
import { weightedAvg } from '@erp/shared';
import { Tx } from './audit.service';
import { SettingsService } from './settings.service';

export interface MoveInput {
  companyId: string; productId: string; warehouseId: string;
  qty: number; // + in, - out
  unitCost?: number; // required for inbound purchases; outbound uses avg cost
  type: string; refType?: string; refId?: string; serial?: string | null; note?: string; userId?: string;
  /** Serial status after an outbound move (issued/sold/demo/rma/scrapped/out). */
  serialStatus?: string;
}

@Injectable()
export class StockService {
  constructor(private settings: SettingsService) {}

  /** Posts one stock movement and updates the running level + weighted average cost. Returns unit cost used. */
  async move(tx: Tx, m: MoveInput): Promise<number> {
    if (m.qty === 0) return 0;
    const product = await tx.product.findFirst({ where: { id: m.productId, companyId: m.companyId } });
    if (!product) throw new BadRequestException('Unknown product');
    if (product.serialized && Math.abs(m.qty) !== 1) throw new BadRequestException(`${product.sku} is serialized: move one serial at a time`);
    if (product.serialized && !m.serial) throw new BadRequestException(`${product.sku} requires a serial number`);

    // Row lock on the level keeps concurrent moves consistent.
    await tx.stockLevel.upsert({ where: { productId_warehouseId: { productId: m.productId, warehouseId: m.warehouseId } }, update: {}, create: { companyId: m.companyId, productId: m.productId, warehouseId: m.warehouseId } });
    const [level] = await tx.$queryRaw<{ id: string; qty: string; avgCost: string }[]>`
      SELECT id, qty, avgCost FROM StockLevel WHERE productId = ${m.productId} AND warehouseId = ${m.warehouseId} FOR UPDATE`;
    const qty = Number(level.qty);
    const avg = Number(level.avgCost);

    let unitCost: number;
    let newAvg = avg;
    if (m.qty > 0) {
      unitCost = m.unitCost ?? avg;
      newAvg = weightedAvg(qty, avg, m.qty, unitCost);
    } else {
      unitCost = avg;
      if (qty + m.qty < 0 && !(await this.settings.get(m.companyId, 'inventory.allowNegative'))) {
        throw new BadRequestException(`Insufficient stock for ${product.sku} (have ${qty}, need ${-m.qty})`);
      }
    }
    await tx.stockLevel.update({ where: { id: level.id }, data: { qty: qty + m.qty, avgCost: newAvg } });
    await tx.stockMovement.create({
      data: { companyId: m.companyId, productId: m.productId, warehouseId: m.warehouseId, qty: m.qty, unitCost, type: m.type, refType: m.refType, refId: m.refId, serial: m.serial, note: m.note, userId: m.userId },
    });
    if (m.qty > 0) await tx.product.update({ where: { id: product.id }, data: { cost: newAvg } });

    if (m.serial) {
      const where = { companyId_serial: { companyId: m.companyId, serial: m.serial } };
      if (m.qty > 0) {
        await tx.serialItem.upsert({ where, update: { productId: m.productId, warehouseId: m.warehouseId, status: 'in_stock' }, create: { companyId: m.companyId, productId: m.productId, serial: m.serial, warehouseId: m.warehouseId } });
      } else {
        const s = await tx.serialItem.findUnique({ where });
        if (!s || s.warehouseId !== m.warehouseId || s.status !== 'in_stock') throw new BadRequestException(`Serial ${m.serial} is not in stock at this warehouse`);
        await tx.serialItem.update({ where, data: { status: m.serialStatus ?? 'out', warehouseId: null } });
      }
    }
    return unitCost;
  }

  /** Transfer = out of one warehouse + in to another at the same cost. */
  async transfer(tx: Tx, m: Omit<MoveInput, 'warehouseId' | 'qty'> & { from: string; to: string; qty: number }) {
    const cost = await this.move(tx, { ...m, warehouseId: m.from, qty: -m.qty, serialStatus: 'out' });
    await this.move(tx, { ...m, warehouseId: m.to, qty: m.qty, unitCost: cost });
    return cost;
  }
}
