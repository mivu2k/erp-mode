import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCES } from '@erp/shared';
import { amountInWords, PRINT_PROFILES } from './print-profiles';

test('amount in words', () => {
  assert.equal(amountInWords(1234.5, 'PKR'), 'PKR one thousand two hundred thirty-four and 50/100 only');
  assert.equal(amountInWords(2_000_015, 'USD'), 'USD two million fifteen only');
  assert.equal(amountInWords(0, 'PKR'), 'PKR zero only');
  assert.equal(amountInWords(100000, 'PKR'), 'PKR one hundred thousand only');
});

test('every print profile belongs to a real resource', () => {
  const keys = new Set(RESOURCES.map((r) => r.key));
  assert.deepEqual(Object.keys(PRINT_PROFILES).filter((k) => !keys.has(k)), []);
});
