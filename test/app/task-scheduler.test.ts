import assert from 'node:assert/strict';
import test from 'node:test';

import { ThreadTaskScheduler } from '../../src/app/task-scheduler';

test('thread task scheduler enforces ownership, queue capacity, and FIFO handoff', () => {
  const scheduler = new ThreadTaskScheduler<object, string>();
  const active = {};
  scheduler.activate('thread-1', active);

  assert.equal(scheduler.enqueue('thread-1', 'second', 1), true);
  assert.equal(scheduler.enqueue('thread-1', 'rejected', 1), false);
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.queuedCount, 1);
  assert.equal(scheduler.release('thread-1', {}), false);
  assert.equal(scheduler.release('thread-1', active), true);
  assert.equal(scheduler.takeNext('thread-1'), 'second');
  assert.equal(scheduler.queuedCount, 0);
});
