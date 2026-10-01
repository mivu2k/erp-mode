import { test } from 'node:test';
import assert from 'node:assert/strict';
import { employeeStatus } from './hrm';

test('employeeStatus: exit events win over leave; leave today → on_leave; else active', () => {
  assert.equal(employeeStatus('termination', true), 'terminated');
  assert.equal(employeeStatus('resignation', false), 'resigned');
  assert.equal(employeeStatus(undefined, true), 'on_leave');
  assert.equal(employeeStatus(undefined, false), 'active');
});
