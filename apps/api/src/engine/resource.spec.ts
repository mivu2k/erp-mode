import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilters } from './resource.service';
import type { FieldMeta } from './meta';

const f = (name: string, type = 'bool'): [string, FieldMeta] => [name, { name, type: type as FieldMeta['type'], required: false }];
const fields = new Map([f('isCash'), f('isBank'), f('code', 'string')]);

test('buildFilters: whitelisted fields, $or branches, unknown keys dropped', () => {
  assert.deepEqual(buildFilters(fields, { $or: [{ isCash: true }, { isBank: true }], secret: 1 }), { OR: [{ isCash: true }, { isBank: true }] });
  assert.deepEqual(buildFilters(fields, { $or: [{ passwordHash: 'x' }] }), {});
  assert.deepEqual(buildFilters(fields, { code: { contains: 'EMP' } }), { code: { contains: 'EMP' } });
});
