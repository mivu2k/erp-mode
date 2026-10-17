import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeList } from './inventory';

test('product barcodes: main + extras, any separator, no blanks or repeats', () => {
  assert.deepEqual(barcodeList('111', '222\n333, 222 ;444'), ['111', '222', '333', '444']);
  assert.deepEqual(barcodeList(null, ''), []);
  assert.deepEqual(barcodeList('', ' 555 '), ['555']);
});
