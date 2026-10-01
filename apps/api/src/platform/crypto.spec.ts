import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt } from './crypto';

test('encrypt roundtrip + tamper detection', () => {
  const e = encrypt('1234-pattern');
  assert.equal(decrypt(e), '1234-pattern');
  const [iv, tag, data] = e.split('.');
  assert.throws(() => decrypt([iv, tag, data.slice(0, -2) + 'AA'].join('.')));
});
