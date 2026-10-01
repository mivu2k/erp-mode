import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HooksService } from './hooks';

test('same hooks registered by two instances of a class run once; different hooks both run', async () => {
  const h = new HooksService();
  let calls = 0;
  class Mod { constructor(hs: HooksService) { hs.on('x.y', { afterCreate: () => { calls++; } }); } }
  new Mod(h);
  new Mod(h);
  h.on('x.y', { afterCreate: () => { calls += 10; } });
  await h.run('x.y', 'afterCreate', {} as never, {});
  assert.equal(calls, 11);
});
