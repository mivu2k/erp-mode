import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password';

test('password hash roundtrip', async () => {
  const h = await hashPassword('Secret123');
  assert.ok(await verifyPassword('Secret123', h));
  assert.ok(!(await verifyPassword('secret123', h)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});
