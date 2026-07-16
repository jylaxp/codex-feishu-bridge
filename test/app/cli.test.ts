import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../../src/app/cli';

test('rejects the removed --env option before loading runtime configuration', async () => {
  await assert.rejects(
    runCli(['run', '--env', '/tmp/bridge.env'], {}),
    /Unknown CLI argument: --env/,
  );
});

test('help documents the private configuration file and process overrides', async () => {
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

  assert.match(output, /\.codex-feishu-bridge\/.env/);
  assert.match(output, /environment values override/);
  assert.doesNotMatch(output, /--env/);
  assert.match(output, /config reset/);
  assert.match(output, /setup/);
  assert.match(output, /rebind/);
  assert.match(output, /\binit\b/);
  assert.match(output, /\bstart\b/);
  assert.match(output, /\brestart\b/);
  assert.match(output, /\bstop\b/);
  assert.match(output, /\bstatus\b/);
  assert.match(output, /\bupdate\b/);
});

test('init creates the editable configuration skeleton without QR registration', async () => {
  const calls: unknown[] = [];
  await runCli(['init', '--config-home', '/tmp/bridge-init-cli'], {}, {
    initializeSetupFiles: (configHome, env) => {
      calls.push({ configHome, env });
      return {
        configHome: configHome ?? '',
        envPath: '/tmp/bridge-init-cli/.env',
        appId: '',
        qrRegistered: false,
        missingRequiredValues: ['LARK_APP_ID', 'LARK_APP_SECRET'],
      };
    },
  });

  assert.deepEqual(calls, [{
    configHome: '/tmp/bridge-init-cli',
    env: { BRIDGE_CONFIG_HOME: '/tmp/bridge-init-cli' },
  }]);
});

test('setup delegates to the setup runner without loading runtime configuration', async () => {
  const calls: unknown[] = [];
  await runCli(['setup', '--config-home', '/tmp/bridge-setup-cli'], {}, {
    runSetup: async (options, env) => {
      calls.push({ options, env });
      return {
        configHome: options.configHome ?? '',
        envPath: '/tmp/bridge-setup-cli/.env',
        appId: 'cli_1111222233334444',
        qrRegistered: true,
        missingRequiredValues: [],
      };
    },
  });

  assert.deepEqual(calls, [{
    options: {
      configHome: '/tmp/bridge-setup-cli',
      rebind: false,
    },
    env: { BRIDGE_CONFIG_HOME: '/tmp/bridge-setup-cli' },
  }]);
});

test('start initializes credentials before starting the detached background service', async () => {
  const calls: string[] = [];
  await runCli(['start', '--config-home', '/tmp/bridge-start-cli'], {}, {
    runSetup: async (options, env) => {
      calls.push(`setup:${options.configHome}:${env.BRIDGE_CONFIG_HOME}`);
      return {
        configHome: options.configHome ?? '',
        envPath: '/tmp/bridge-start-cli/.env',
        appId: 'cli_1111222233334444',
        qrRegistered: false,
        missingRequiredValues: [],
      };
    },
    runBackgroundCommand: async (command, options, env) => {
      calls.push(`background:${command}:${options.configHome}:${env.BRIDGE_CONFIG_HOME}`);
      return {
        command,
        running: true,
        pid: 123,
        stdoutLog: '/tmp/stdout.log',
        stderrLog: '/tmp/stderr.log',
      };
    },
  });

  assert.deepEqual(calls, [
    'setup:/tmp/bridge-start-cli:/tmp/bridge-start-cli',
    'background:start:/tmp/bridge-start-cli:/tmp/bridge-start-cli',
  ]);
});

test('status and forced update route to the background lifecycle without QR setup', async () => {
  const calls: string[] = [];
  const background = async (
    command: 'start' | 'restart' | 'stop' | 'status' | 'update',
    options: { readonly configHome?: string; readonly forceUpdate?: boolean },
  ) => {
    calls.push(`${command}:${options.forceUpdate === true}`);
    return {
      command,
      running: false,
      pid: null,
      stdoutLog: '/tmp/stdout.log',
      stderrLog: '/tmp/stderr.log',
    };
  };
  await runCli(['status'], {}, { runBackgroundCommand: background });
  await runCli(['update', '--force'], {}, { runBackgroundCommand: background });

  assert.deepEqual(calls, ['status:false', 'update:true']);
});

test('rebind forces the setup runner to replace Feishu app credentials', async () => {
  let rebind: boolean | undefined;
  await runCli(['rebind', '--config-home', '/tmp/bridge-rebind-cli'], {}, {
    runSetup: async (options) => {
      rebind = options.rebind;
      return {
        configHome: options.configHome ?? '',
        envPath: '/tmp/bridge-rebind-cli/.env',
        appId: 'cli_1111222233334444',
        qrRegistered: true,
        missingRequiredValues: [],
      };
    },
  });

  assert.equal(rebind, true);
});

test('config reset defaults to a read-only dry run and requires explicit confirmation', async () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(['config', 'reset', '--config-home', '/tmp/cli-reset-dry-run'], {});
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /reset_required/);
  assert.match(output, /requiresConfirmation/);
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
