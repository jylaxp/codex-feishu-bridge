import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseEnvironment, ConfigurationError } from '../../src/app/config';
import {
  assertSupportedNodeVersion,
  prepareDataDirectory,
  PreflightError,
  runPreflight,
  spawnCodexProcess,
} from '../../src/app/preflight';

function validEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    LARK_APP_ID: 'cli_0123456789abcdef',
    LARK_APP_SECRET: 'test-secret-value',
    LARK_TENANT_KEY: 'tenant-test',
    ALLOWED_CHATS: 'oc_chat_1',
    AUTHORIZED_USERS: 'ou_user_1',
    ALLOWED_APPROVERS: 'ou_approver_1',
    CODEX_BIN: path.join(root, 'codex'),
    CODEX_CWD: path.join(root, 'workspace'),
    ALLOWED_WORKSPACE_ROOTS: path.join(root, 'workspace'),
    BRIDGE_DATA_DIR: path.join(root, 'data'),
    MAX_TEXT_LENGTH: '10000',
    CARD_UPDATE_INTERVAL_MS: '1500',
  };
}

function expectThrows(action: () => unknown, expected: new (...args: never[]) => Error): void {
  assert.throws(action, (error: unknown) => error instanceof expected);
}

function waitForExit(child: ReturnType<typeof spawnCodexProcess>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-test-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const codexBin = path.join(root, 'codex');
    fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

    const env = validEnvironment(root);
    const before = JSON.stringify(env);
    const config = parseEnvironment(env);
    assert.strictEqual(JSON.stringify(env), before, 'parseEnvironment must not mutate env');
    assert.strictEqual(config.maxTextLength, 10_000);
    assert.strictEqual(config.cardUpdateIntervalMs, 1_500);
    assert.strictEqual(config.maxQueuedTasks, 100);
    assert.strictEqual(config.appServerMode, 'owned_stdio');
    assert.strictEqual(config.appServerSocketPath, null);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.allowedChats));

    const requiredKeys = [
      'LARK_APP_ID',
      'LARK_APP_SECRET',
      'LARK_TENANT_KEY',
      'ALLOWED_CHATS',
      'AUTHORIZED_USERS',
      'ALLOWED_APPROVERS',
      'CODEX_BIN',
      'CODEX_CWD',
      'ALLOWED_WORKSPACE_ROOTS',
      'BRIDGE_DATA_DIR',
    ];
    for (const key of requiredKeys) {
      const missing = { ...env };
      delete missing[key];
      expectThrows(() => parseEnvironment(missing), ConfigurationError);
    }

    expectThrows(
      () => parseEnvironment({ ...env, ALLOWED_CHATS: ' , ' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, LARK_APP_ID: 'cli_invalid' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, CODEX_BIN: 'codex' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, MAX_TEXT_LENGTH: '999' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, CARD_UPDATE_INTERVAL_MS: '999' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, MAX_QUEUED_TASKS: '0' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({ ...env, APP_SERVER_MODE: 'legacy_ipc' }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({
        ...env,
        APP_SERVER_MODE: 'managed_proxy',
        APP_SERVER_SOCKET_PATH: 'relative.sock',
      }),
      ConfigurationError,
    );
    expectThrows(
      () => parseEnvironment({
        ...env,
        APP_SERVER_MODE: 'owned_stdio',
        APP_SERVER_SOCKET_PATH: path.join(root, 'unused.sock'),
      }),
      ConfigurationError,
    );

    assertSupportedNodeVersion('24.18.0');
    assertSupportedNodeVersion('24.99.0');
    expectThrows(() => assertSupportedNodeVersion('24.17.9'), PreflightError);
    expectThrows(() => assertSupportedNodeVersion('25.0.0'), PreflightError);

    const result = runPreflight(config, { nodeVersion: '24.18.0' });
    assert.strictEqual(result.config.codexBin, fs.realpathSync.native(codexBin));
    assert.strictEqual(result.config.codexCwd, fs.realpathSync.native(workspace));
    assert.strictEqual(result.dataDirectory.rootDir, fs.realpathSync.native(path.join(root, 'data')));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(result.dataDirectory.rootDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(result.dataDirectory.logDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(result.dataDirectory.temporaryDir).mode & 0o777, 0o700);
    }

    const shellMarker = path.join(root, 'shell-marker');
    const child = spawnCodexProcess(result, [`$(touch ${shellMarker})`]);
    assert.strictEqual(await waitForExit(child), 0);
    assert.ok(!fs.existsSync(shellMarker), 'Codex arguments must never be evaluated by a shell');

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const escapeLink = path.join(workspace, 'escape');
    fs.symlinkSync(outside, escapeLink, 'dir');
    const escapedConfig = parseEnvironment({ ...env, CODEX_CWD: escapeLink });
    expectThrows(
      () => runPreflight(escapedConfig, { nodeVersion: '24.18.0' }),
      PreflightError,
    );

    const symlinkData = path.join(root, 'symlink-data');
    fs.symlinkSync(path.join(root, 'data'), symlinkData, 'dir');
    expectThrows(() => prepareDataDirectory(symlinkData), PreflightError);

    const ordinaryPath = path.join(root, 'not-a-socket');
    fs.writeFileSync(ordinaryPath, 'not a socket');
    expectThrows(
      () => runPreflight(parseEnvironment({
        ...env,
        APP_SERVER_MODE: 'managed_proxy',
        APP_SERVER_SOCKET_PATH: ordinaryPath,
      }), { nodeVersion: '24.18.0' }),
      PreflightError,
    );
    const socketLink = path.join(root, 'app-server-link.sock');
    fs.symlinkSync(ordinaryPath, socketLink);
    expectThrows(
      () => runPreflight(parseEnvironment({
        ...env,
        APP_SERVER_MODE: 'managed_proxy',
        APP_SERVER_SOCKET_PATH: socketLink,
      }), { nodeVersion: '24.18.0' }),
      PreflightError,
    );

    fs.chmodSync(codexBin, 0o600);
    expectThrows(
      () => runPreflight(config, { nodeVersion: '24.18.0' }),
      PreflightError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run()
  .then(() => console.log('config.test.ts passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
