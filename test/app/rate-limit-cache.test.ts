import assert from 'node:assert/strict';
import test from 'node:test';

import { RateLimitCache } from '../../src/app/rate-limit-cache';

test('shares one in-flight quota read and refreshes only after the configured TTL', async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new RateLimitCache(async () => ({ version: ++calls }), 100, () => now);
  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.deepEqual(first, { version: 1 });
  assert.deepEqual(second, { version: 1 });
  assert.equal(calls, 1);
  now += 99;
  assert.deepEqual(await cache.get(), { version: 1 });
  now += 1;
  assert.deepEqual(await cache.get(), { version: 2 });
  assert.equal(calls, 2);
});
