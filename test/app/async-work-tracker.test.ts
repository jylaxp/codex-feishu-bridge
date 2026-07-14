import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AsyncWorkTracker,
  AsyncWorkTrackerCapacityError,
  AsyncWorkTrackerClosedError,
} from '../../src/app/async-work-tracker';

test('drains accepted handlers and rejects work after close', async () => {
  const tracker = new AsyncWorkTracker();
  let release: (() => void) | undefined;
  const blocked = tracker.track(() => new Promise<void>((resolve) => {
    release = resolve;
  }));

  tracker.close();
  const drain = tracker.drain();
  await assert.rejects(
    tracker.track(() => Promise.resolve()),
    AsyncWorkTrackerClosedError,
  );
  release?.();
  await blocked;
  await drain;
});

test('rejects burst work above the configured concurrency boundary', async () => {
  const tracker = new AsyncWorkTracker(1);
  let release: (() => void) | undefined;
  const first = tracker.track(() => new Promise<void>((resolve) => {
    release = resolve;
  }));

  await assert.rejects(
    tracker.track(() => Promise.resolve()),
    AsyncWorkTrackerCapacityError,
  );
  release?.();
  await first;

  await tracker.track(() => Promise.resolve());
  tracker.close();
  await tracker.drain();
});

test('drain waits for rejected handlers without rethrowing their failure', async () => {
  const tracker = new AsyncWorkTracker();
  const rejected = tracker.track(() => Promise.reject(new Error('expected failure')));
  tracker.close();

  await assert.rejects(rejected, /expected failure/);
  await tracker.drain();
});
