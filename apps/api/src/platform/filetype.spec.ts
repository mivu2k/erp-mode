import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff } from './filetype';

test('sniff trusts bytes, not the declared type', () => {
  assert.equal(sniff(Buffer.from('ffd8ffe000104a464946', 'hex'), 'image/png'), 'image/jpeg');
  assert.equal(sniff(Buffer.from('%PDF-1.7\n'), 'application/pdf'), 'application/pdf');
  assert.equal(sniff(Buffer.from('504b030414000600', 'hex'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(sniff(Buffer.from('a,b\n1,2\n'), 'text/csv'), 'text/csv');
  assert.equal(sniff(Buffer.from('MZ\x90\x00'), 'image/png'), null, 'executable disguised as image');
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml'), null, 'svg (script-capable) rejected');
  assert.equal(sniff(Buffer.from([0x61, 0x00, 0x62]), 'text/plain'), null, 'binary posing as text');
});
