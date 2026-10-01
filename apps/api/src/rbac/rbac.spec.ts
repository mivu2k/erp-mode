import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthUser, inScope, mergeScopes, scopeWhere } from './rbac';

const u: AuthUser = {
  id: 'u', name: 'U', locale: 'en', companyId: 'c', branchId: 'b', departmentId: 'd', employeeId: 'e', roleIds: [], disabledModules: ['fleet'],
  permissions: { 'x.a.view': 'own', 'x.b.view': 'branch', 'x.c.view': 'department', 'fleet.v.view': 'all' },
};

test('mergeScopes keeps widest scope', () => {
  assert.deepEqual(mergeScopes([{ key: 'a', scope: 'own' }, { key: 'a', scope: 'branch' }, { key: 'a', scope: 'department' }]), { a: 'branch' });
});

test('scopeWhere', () => {
  assert.deepEqual(scopeWhere(u, 'x.a.view', { owner: 'employeeId' }), { companyId: 'c', employeeId: 'e' });
  assert.deepEqual(scopeWhere(u, 'x.b.view'), { companyId: 'c', branchId: 'b' });
  // model without departmentId degrades to owner, never widens
  assert.deepEqual(scopeWhere(u, 'x.c.view', { columns: new Set(['companyId', 'createdById']) }), { companyId: 'c', createdById: 'u' });
  assert.throws(() => scopeWhere(u, 'x.z.view'));
  assert.throws(() => scopeWhere(u, 'fleet.v.view'), /fleet/); // module disabled
});

test('inScope', () => {
  assert.ok(inScope(u, 'x.b.view', { companyId: 'c', branchId: 'b' }));
  assert.ok(!inScope(u, 'x.b.view', { companyId: 'c', branchId: 'other' }));
});
