import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeProblems } from './intake';

test('intake problems: customer, fault and duplicate serials', () => {
  assert.deepEqual(Object.keys(intakeProblems(null, [{ fault: ' ' }])), ['customer', 'fault0']);
  assert.deepEqual(intakeProblems('c1', [{ fault: 'no TX', serial: 'A1' }, { fault: 'dead', serial: ' A1 ' }]), { serial1: 'Same serial entered twice' });
  assert.deepEqual(intakeProblems('c1', [{ fault: 'x' }, { fault: 'y' }]), {});
});
