import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparison, Entry, lines, locationLines, parseRefs, isHtml, plainText, sanitizeCss, sanitizeHtml, specPairs } from './catalog';

test('one-per-line text parsing', () => {
  assert.deepEqual(lines('- Rugged IP67\n\n• 5W output\r\n  AES-256 '), ['Rugged IP67', '5W output', 'AES-256']);
  assert.deepEqual(specPairs('Frequency: 30–512 MHz\nWeight = 1.2 kg\nMIL-STD-810G compliant'), [['Frequency', '30–512 MHz'], ['Weight', '1.2 kg'], ['', 'MIL-STD-810G compliant']]);
});

test('parseRefs keeps order, dedupes, defaults to catalog items', () => {
  assert.deepEqual(parseRefs('c:a, p:b,a,c:a,p:b,x'), [{ type: 'c', id: 'a' }, { type: 'p', id: 'b' }, { type: 'c', id: 'x' }]);
  assert.deepEqual(parseRefs(''), []);
});

test('comparison keeps shared spec labels (case-insensitive) and fills gaps', () => {
  const e = (name: string, specs: [string, string][]) => ({ name, specs } as Entry);
  const rows = comparison([e('A', [['Range', '30 km'], ['Weight', '1 kg'], ['Only A', 'x']]), e('B', [['range', '50 km'], ['Power', '20 W']]), e('C', [['Weight', '2 kg']])]);
  assert.deepEqual(rows, [{ label: 'Range', values: ['30 km', '50 km', '—'] }, { label: 'Weight', values: ['1 kg', '—', '2 kg'] }]);
});

test('location lines: name | address | phone | email, parts optional', () => {
  assert.deepEqual(locationLines('Head Office | Blue Area, Islamabad | +92 51 111 | info@x.pk\nLahore Branch | Gulberg III'), [
    { name: 'Head Office', address: 'Blue Area, Islamabad', phone: '+92 51 111', email: 'info@x.pk' },
    { name: 'Lahore Branch', address: 'Gulberg III', phone: '', email: '' },
  ]);
});


test('one-per-line text parsing', () => {
  assert.deepEqual(lines('- Rugged IP67\n\n• 5W output\r\n  AES-256 '), ['Rugged IP67', '5W output', 'AES-256']);
  assert.deepEqual(specPairs('Frequency: 30–512 MHz\nWeight = 1.2 kg\nMIL-STD-810G compliant'), [['Frequency', '30–512 MHz'], ['Weight', '1.2 kg'], ['', 'MIL-STD-810G compliant']]);
});

test('parseRefs keeps order, dedupes, defaults to catalog items', () => {
  assert.deepEqual(parseRefs('c:a, p:b,a,c:a,p:b,x'), [{ type: 'c', id: 'a' }, { type: 'p', id: 'b' }, { type: 'c', id: 'x' }]);
  assert.deepEqual(parseRefs(''), []);
});

test('comparison keeps shared spec labels (case-insensitive) and fills gaps', () => {
  const e = (name: string, specs: [string, string][]) => ({ name, specs } as Entry);
  const rows = comparison([e('A', [['Range', '30 km'], ['Weight', '1 kg'], ['Only A', 'x']]), e('B', [['range', '50 km'], ['Power', '20 W']]), e('C', [['Weight', '2 kg']])]);
  assert.deepEqual(rows, [{ label: 'Range', values: ['30 km', '50 km', '—'] }, { label: 'Weight', values: ['1 kg', '—', '2 kg'] }]);
});

test('location lines: name | address | phone | email, parts optional', () => {
  assert.deepEqual(locationLines('Head Office | Blue Area, Islamabad | +92 51 111 | info@x.pk\nLahore Branch | Gulberg III'), [
    { name: 'Head Office', address: 'Blue Area, Islamabad', phone: '+92 51 111', email: 'info@x.pk' },
    { name: 'Lahore Branch', address: 'Gulberg III', phone: '', email: '' },
  ]);
});

test('custom brochure HTML/CSS is display-only', () => {
  const h = sanitizeHtml('<h2 onclick="x()" style="color:red">Hi</h2><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a><iframe src="http://10.0.0.1"></iframe><SCRIPT src=//e></SCRIPT><p>ok</p>');
  assert.equal(h, '<h2 style="color:red">Hi</h2><img src=x><a >l</a><p>ok</p>');
  assert.equal(sanitizeCss('@import url(http://evil/a.css); h2{color:red}</style><script>'), ' h2{color:red}><script>'); // only </style could end the block
});

test('rich text: detect HTML, plain text for PowerPoint', () => {
  assert.equal(isHtml('Just words < 5'), false);
  assert.equal(isHtml('<p>Hi</p>'), true);
  assert.equal(plainText('<p><b>Rugged</b> &amp; light</p><ul><li>IP67</li><li>2 kg</li></ul>'), 'Rugged & light\nIP67\n2 kg');
});
