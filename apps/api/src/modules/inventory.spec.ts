import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeList, makeFromName, skuFor } from './inventory';

test('product barcodes: main + extras, any separator, no blanks or repeats', () => {
  assert.deepEqual(barcodeList('111', '222\n333, 222 ;444'), ['111', '222', '333', '444']);
  assert.deepEqual(barcodeList(null, ''), []);
  assert.deepEqual(barcodeList('', ' 555 '), ['555']);
});

test('SKU from the item: make, model (or name initials), random tail', () => {
  const r = () => 0; // tail = "2222"
  assert.equal(skuFor({ make: 'Motorola', model: 'APX 6000', name: 'x' }, r), 'MOT-APX6000-2222');
  assert.equal(skuFor({ name: 'Antenna whip 450 MHz' }, r), 'AW450M-2222', 'no make/model: name initials, numbers kept');
  assert.match(skuFor({ name: 'Cable' }), /^C-[2-9A-HJ-NP-Z]{4}$/);
});

test('make found in the product name', () => {
  assert.equal(makeFromName('Motorola APX 6000 battery', ['Moto', 'Motorola', 'Cisco']), 'Motorola');
  assert.equal(makeFromName('Hytera PD-785', ['hytera']), 'hytera');
  assert.equal(makeFromName('Generic cable', ['Cisco']), null);
  assert.equal(makeFromName('Ciscoish thing', ['Cisco']), null, 'whole words only');
});
