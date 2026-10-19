import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeList, cellText, importRow, makeFromName, modelFromName, skuFor } from './inventory';

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

test('import: loose headers map to fields; kind from the sheet or the list it was imported into', () => {
  const h = ['Item Name', 'Make', 'Model', 'Item Code', 'Sale Price', 'Type', 'Track serial', 'Other barcodes', 'Ignored col'];
  assert.deepEqual(importRow(h, ['APX battery', 'Motorola', 'NNTN8128', '', '4,500', 'Spare part', 'no', 'B1 B2', 'x'], 'product'),
    { name: 'APX battery', brand: 'Motorola', model: 'NNTN8128', price: '4,500', kind: 'part', serialized: 'no', barcodes: 'B1 B2' });
  assert.equal(importRow(['name'], ['Cable'], 'part').kind, 'part', 'no Type column: the list kind');
  assert.equal(importRow(['name', 'type'], ['Radio', 'Product'], 'part').kind, 'product');
});

test('import: Excel rich text, formulas and links read as their text; part/product told apart', () => {
  assert.equal(cellText({ richText: [{ text: 'Spare ' }, { text: 'part' }] }), 'Spare part');
  assert.equal(cellText({ formula: '"Part"', result: 'Part' }), 'Part');
  assert.equal(cellText({ text: 'Hytera', hyperlink: 'x' }), 'Hytera');
  const kind = (v: unknown) => importRow(['Name', 'Item Type'], ['x', v], 'product').kind;
  assert.deepEqual([kind({ richText: [{ text: 'Spare part' }] }), kind('Parts'), kind('SP'), kind('Component'), kind('Product'), kind('Spare')], ['part', 'part', 'part', 'part', 'product', 'part']);
});

test('model follows the name, without a leading brand', () => {
  assert.equal(modelFromName('Kenwood NX-1200', 'Kenwood'), 'NX-1200');
  assert.equal(modelFromName('NX-1200', 'Kenwood'), 'NX-1200', 'no brand in front: the name itself');
  assert.equal(modelFromName('kenwood  NX-1200 ', 'Kenwood'), 'NX-1200');
  assert.equal(modelFromName('Kenwoodish radio', 'Kenwood'), 'Kenwoodish radio', 'whole word only');
});
