'use client';
import { api } from './api';
import type { Meta } from './meta';

type Rec = Record<string, unknown>;
const cache = new Map<string, Promise<Rec | null>>();

/** Fetch a record the user can see (cached briefly per page). */
export function fetchRec(key: string, id: string): Promise<Rec | null> {
  const k = `${key}/${id}`;
  if (!cache.has(k)) {
    cache.set(k, api<Rec>(`r/${k}`).catch(() => null));
    setTimeout(() => cache.delete(k), 30_000);
  }
  return cache.get(k)!;
}

const path = (o: unknown, p: string) => p.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Rec)[k] : undefined), o);

/**
 * Evaluates an autofill/prefill expression against a record:
 *   'cost'            field
 *   'qty-receivedQty' difference of fields (any count)
 *   'taxId>value.rate' follow the taxId reference, then read value.rate
 *   '=ok'             literal
 */
export async function evalExpr(expr: string, rec: Rec, sourceKey: string, meta: Meta): Promise<unknown> {
  if (expr.startsWith('=')) return expr.slice(1);
  if (expr.includes('>')) {
    const [field, rest] = expr.split('>');
    const id = rec[field];
    const ref = meta.resources.find((r) => r.key === sourceKey)?.fields.find((f) => f.name === field)?.ref;
    if (!id || !ref) return undefined;
    const target = await fetchRec(ref, String(id));
    return target ? path(target, rest) : undefined;
  }
  if (/[-+]/.test(expr)) {
    // a-b+c: each term is a field of rec
    const v = expr.split(/(?=[-+])/).reduce((s, t) => s + (t[0] === '-' ? -1 : 1) * (Number(rec[t.replace(/^[-+]/, '')] ?? 0) || 0), 0);
    return Math.round(v * 1000) / 1000;
  }
  return path(rec, expr);
}

/** Applies autofill rules for a changed field: fetches the picked record and returns the values to set. */
export async function autofillPatch(rules: Record<string, string> | undefined, refKey: string | undefined, id: unknown, meta: Meta): Promise<Rec> {
  if (!rules || !refKey || !id) return {};
  const src = await fetchRec(refKey, String(id));
  if (!src) return {};
  const out: Rec = {};
  for (const [target, expr] of Object.entries(rules)) {
    const v = await evalExpr(expr, src, refKey, meta);
    if (v !== undefined && v !== null && v !== '') out[target] = typeof v === 'number' ? String(v) : v;
  }
  return out;
}

/** Live computed fields, e.g. { days: 'days(from,to)' } → inclusive day count. */
export function computeFields(rules: Record<string, string> | undefined, values: Rec): Rec {
  const out: Rec = {};
  for (const [field, expr] of Object.entries(rules ?? {})) {
    const m = expr.match(/^days\((\w+),(\w+)\)$/);
    if (m && values[m[1]] && values[m[2]]) {
      const d = Math.round((Date.parse(String(values[m[2]]).slice(0, 10)) - Date.parse(String(values[m[1]]).slice(0, 10))) / 86_400_000) + 1;
      if (d > 0) out[field] = String(d);
    }
  }
  return out;
}
