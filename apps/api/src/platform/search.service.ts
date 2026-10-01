import { Injectable } from '@nestjs/common';
import { moduleOf, ResourceDef } from '@erp/shared';
import { Tx } from './audit.service';

type Rec = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

@Injectable()
export class SearchService {
  async index(tx: Tx, def: ResourceDef, rec: Rec) {
    if (rec.deletedAt) return this.remove(tx, def.key, str(rec.id));
    const title = str(rec[def.title]) || str(rec.id);
    const data = {
      companyId: str(rec.companyId), module: moduleOf(def.key), title: title.slice(0, 191),
      subtitle: def.subtitle ? str(rec[def.subtitle]).slice(0, 191) : null,
      keywords: (def.search ?? []).map((f) => str(rec[f])).filter(Boolean).join(' '),
      barcode: def.barcode ? str(rec[def.barcode]).slice(0, 191) || null : null,
    };
    await tx.searchIndex.upsert({ where: { entityType_entityId: { entityType: def.key, entityId: str(rec.id) } }, update: data, create: { ...data, entityType: def.key, entityId: str(rec.id) } });
  }

  remove(tx: Tx, key: string, id: string) {
    return tx.searchIndex.deleteMany({ where: { entityType: key, entityId: id } });
  }
}
