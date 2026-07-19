import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  requestWorkerTermination,
  runProcessSupervisor,
} from '../../src/app/process-supervisor';

test('process supervisor applies bounded backoff and stops after repeated fast failures', async () => {
  let spawnCount = 0;
  const delays: number[] = [];

  await assert.rejects(
    runProcessSupervisor({
      spawnProcess: (() => {
        spawnCount += 1;
        const child = new EventEmitter() as EventEmitter & { kill(signal?: string): boolean };
        child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 1, null));
        return child as never;
      }) as never,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      now: () => 0,
    }),
    /consecutive restart limit/,
  );

  assert.equal(spawnCount, 5);
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000]);
});

test('worker termination escalates from SIGTERM to SIGKILL after its grace period', async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  requestWorkerTermination({
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
  }, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
