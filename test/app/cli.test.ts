import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../../src/app/cli';

test('rejects the removed --env option before loading runtime configuration', async () => {
  await assert.rejects(
    runCli(['run', '--env', '/tmp/bridge.env'], {}),
    /Unknown CLI argument: --env/,
  );
});

test('help documents process-environment configuration only', async () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(['help'], {});
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /read only from the process environment/);
  assert.doesNotMatch(output, /--env|\.env/);
});

test('registers shutdown signals before starting Bridge and preserves an early signal', async () => {
  const order: string[] = [];
  let signalShutdown: (() => void) | undefined;
  let finishStartup: (() => void) | undefined;
  let stopped = false;
  const startup = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const runPromise = runCli(['run'], {}, {
    createShutdownSignalWaiter: () => {
      order.push('signals:registered');
      return {
        wait: new Promise<void>((resolve) => {
          signalShutdown = resolve;
        }),
        dispose: () => order.push('signals:disposed'),
      };
    },
    startBridge: async () => {
      order.push('bridge:starting');
      await startup;
      order.push('bridge:started');
      return {
        failure: new Promise<Error>(() => undefined),
        stop: async () => {
          stopped = true;
          order.push('bridge:stopped');
        },
      };
    },
  });

  assert.deepEqual(order, ['signals:registered', 'bridge:starting']);
  assert.ok(signalShutdown);
  signalShutdown();
  assert.ok(finishStartup);
  finishStartup();
  await runPromise;

  assert.equal(stopped, true);
  assert.deepEqual(order, [
    'signals:registered',
    'bridge:starting',
    'bridge:started',
    'bridge:stopped',
    'signals:disposed',
  ]);
});

test('stops and fails the process when the runtime reports a terminal error', async () => {
  const terminalError = new Error('Lark WebSocket connection terminated');
  let reportFailure!: (error: Error) => void;
  let stopped = false;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });
  const runPromise = runCli(['run'], {}, {
    createShutdownSignalWaiter: () => ({
      wait: new Promise<void>(() => undefined),
      dispose: () => undefined,
    }),
    startBridge: async () => ({
      failure,
      stop: async () => {
        stopped = true;
      },
    }),
  });

  reportFailure(terminalError);

  await assert.rejects(runPromise, terminalError);
  assert.equal(stopped, true);
});
