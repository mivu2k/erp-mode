import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32, totp, verifyTotp } from './totp';

test('RFC 6238 SHA-1 vectors', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(secret, 1_111_111_109_000), '081804');
  assert.ok(verifyTotp(secret, '287082', 59_000 + 30_000));
  assert.ok(!verifyTotp(secret, '287082', 59_000 + 90_000));
});
