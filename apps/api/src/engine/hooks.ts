import { Injectable } from '@nestjs/common';
import type { ResourceDef } from '@erp/shared';
import type { Tx } from '../platform/audit.service';
import type { AuthUser } from '../rbac/rbac';

export type Row = Record<string, unknown>;
/** `body` is the raw request body (create/update only) for fields that aren't columns, e.g. a plain password. */
export interface HookCtx { tx: Tx; user: AuthUser; def: ResourceDef; body?: Row }

/**
 * Domain logic plugs into the generic engine here instead of writing its own CRUD.
 * `data` in before* hooks includes child arrays (e.g. data.lines) and may be mutated (totals, defaults).
 */
export interface ResourceHooks {
  beforeCreate?(ctx: HookCtx, data: Row): Promise<void> | void;
  afterCreate?(ctx: HookCtx, rec: Row): Promise<void> | void;
  beforeUpdate?(ctx: HookCtx, data: Row, before: Row): Promise<void> | void;
  afterUpdate?(ctx: HookCtx, rec: Row, before: Row): Promise<void> | void;
  /** Last check before a record enters approval (e.g. receipts attached). Throw to block. */
  beforeSubmit?(ctx: HookCtx, rec: Row): Promise<void> | void;
  onApproved?(ctx: HookCtx, rec: Row): Promise<void> | void;
  onRejected?(ctx: HookCtx, rec: Row): Promise<void> | void;
  /** Inside the delete transaction, after the row is gone (soft or hard). */
  afterDelete?(ctx: HookCtx, before: Row): Promise<void> | void;
}

@Injectable()
export class HooksService {
  private map = new Map<string, ResourceHooks[]>();

  private seen = new Set<string>();

  /**
   * Registers hooks once. Module classes are both controllers and providers, so Nest constructs them twice;
   * an identical registration (same resource + same handler code) from the second instance is ignored,
   * otherwise every posting would run twice.
   */
  on(key: string, hooks: ResourceHooks) {
    const id = `${key}|${Object.entries(hooks).map(([name, fn]) => `${name}:${String(fn)}`).join('|')}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.map.set(key, [...(this.map.get(key) ?? []), hooks]);
  }

  async run<K extends keyof ResourceHooks>(key: string, name: K, ...args: Parameters<NonNullable<ResourceHooks[K]>>) {
    for (const h of this.map.get(key) ?? []) {
      const fn = h[name] as ((...a: unknown[]) => unknown) | undefined;
      if (fn) await fn.apply(h, args);
    }
  }
}

/** Minimal typed view of a Prisma model delegate, for dynamic access by name. */
export interface Delegate {
  findMany(args: object): Promise<Row[]>;
  findFirst(args: object): Promise<Row | null>;
  count(args: object): Promise<number>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  groupBy(args: object): Promise<Row[]>;
}
export const delegate = (db: Tx, name: string) => (db as unknown as Record<string, Delegate>)[name];
