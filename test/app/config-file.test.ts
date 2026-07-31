import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadBridgeEnvironment, writeBridgeConfigFile } from '../../src/app/config-file';

test('config loader migrates legacy .env to config.json when JSON config is missing', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-migrate-'));
  try {
    writeFileSync(join(configHome, '.env'), [
      'LARK_APP_ID=cli_1111111111111111',
      'LARK_APP_SECRET=secret',
      'LARK_TENANT_KEY=tenant',
      'ALLOWED_CHATS=chat-a,chat-b',
      'LOG_TO_FILE=true',
      'CODEX_BIN=/codex',
      '',
    ].join('\n'), { mode: 0o600 });

    const env = loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });

    assert.equal(env.LARK_APP_ID, 'cli_1111111111111111');
    assert.equal(env.ALLOWED_CHATS, 'chat-a,chat-b');
    assert.equal(env.LOG_TO_FILE, 'true');
    assert.equal(existsSync(join(configHome, 'config.json')), true);
    assert.equal(existsSync(join(configHome, 'lark-bots.json')), true);
    assert.equal(existsSync(join(configHome, '.env')), false);

    const document = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8')) as {
      readonly lark?: unknown;
      readonly logging: { readonly toFile: boolean };
    };
    assert.equal(document.lark, undefined);
    assert.equal(document.logging.toFile, true);
    const bots = JSON.parse(readFileSync(join(configHome, 'lark-bots.json'), 'utf8')) as {
      readonly bots: readonly {
        readonly appId: string;
        readonly appSecret: string;
        readonly allowedChats: readonly string[];
      }[];
    };
    assert.equal(bots.bots[0]?.appId, 'cli_1111111111111111');
    assert.equal(bots.bots[0]?.appSecret, 'secret');
    assert.deepEqual(bots.bots[0]?.allowedChats, ['chat-a', 'chat-b']);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config loader ignores legacy .env after config.json exists', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-current-'));
  try {
    writeBridgeConfigFile(configHome, {
      LARK_APP_ID: 'cli_1111111111111111',
      LARK_APP_SECRET: 'secret-json',
      ALLOWED_CHATS: 'chat-json',
      CODEX_BIN: '/codex',
    });
    writeFileSync(join(configHome, '.env'), [
      'LARK_APP_ID=cli_ffffffffffffffff',
      'LARK_APP_SECRET=secret-env',
      'ALLOWED_CHATS=chat-env',
      '',
    ].join('\n'), { mode: 0o600 });

    const env = loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });

    assert.equal(env.LARK_APP_ID, undefined);
    assert.equal(env.LARK_APP_SECRET, undefined);
    assert.equal(env.ALLOWED_CHATS, undefined);
    assert.equal(existsSync(join(configHome, '.env')), false);
    const document = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8')) as {
      readonly lark?: unknown;
    };
    assert.equal(document.lark, undefined);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config loader moves legacy config lark credentials into lark-bots.json', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-legacy-lark-'));
  try {
    writeFileSync(join(configHome, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      lark: {
        appId: 'cli_2222222222222222',
        appSecret: 'legacy-secret',
        tenantKey: 'tenant',
        allowedChats: ['chat-json'],
        authorizedUsers: ['owner'],
        allowedApprovers: ['approver'],
        allowGroupUserMentions: true,
        allowExternalGroupUserMentions: true,
        allowGroupBotMentions: true,
      },
      approval: { summaryMode: false },
      appServer: { mode: 'owned_stdio', socketPath: null },
      codex: {
        bin: '/codex',
        cwd: '/workspace',
        allowedShellCommands: ['ls', 'pwd'],
      },
      card: { maxTextLength: 10000, updateIntervalMs: 1500 },
      queue: { maxQueuedTasks: 100 },
      usage: { rateLimitQueryIntervalMs: 300000 },
      logging: { toFile: false, filePath: 'bridge.log' },
      files: { enableAutoFileUpload: false },
    }, null, 2), { mode: 0o600 });

    const env = loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });

    assert.equal(env.LARK_APP_ID, 'cli_2222222222222222');
    assert.equal(env.LARK_APP_SECRET, 'legacy-secret');
    const configDocument = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8')) as {
      readonly lark?: unknown;
    };
    assert.equal(configDocument.lark, undefined);
    const botDocument = JSON.parse(readFileSync(join(configHome, 'lark-bots.json'), 'utf8')) as {
      readonly bots: readonly {
        readonly appId: string;
        readonly appSecret: string;
        readonly tenantKey: string;
        readonly allowedChats: readonly string[];
      }[];
    };
    assert.equal(botDocument.bots[0]?.appId, 'cli_2222222222222222');
    assert.equal(botDocument.bots[0]?.appSecret, 'legacy-secret');
    assert.equal(botDocument.bots[0]?.tenantKey, 'tenant');
    assert.deepEqual(botDocument.bots[0]?.allowedChats, ['chat-json']);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config loader materializes placeholders for blank legacy required values', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-blank-required-'));
  try {
    writeFileSync(join(configHome, '.env'), [
      'LARK_APP_ID=',
      'LARK_APP_SECRET=',
      'CODEX_BIN=',
      '',
    ].join('\n'), { mode: 0o600 });

    loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });
    const reloaded = loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });

    assert.equal(reloaded.LARK_APP_ID, undefined);
    assert.equal(reloaded.LARK_APP_SECRET, undefined);
    assert.equal(reloaded.CODEX_BIN, '/absolute/path/to/codex');
    assert.equal(existsSync(join(configHome, '.env')), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config loader rejects group-readable config.json files', { skip: process.platform === 'win32' }, () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-permission-'));
  try {
    writeBridgeConfigFile(configHome, {
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      CODEX_BIN: '/codex',
    });
    chmodSync(join(configHome, 'config.json'), 0o644);

    assert.throws(
      () => loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome }),
      /config\.json must not be readable or writable by group or others/,
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config writer refuses a pre-existing symlink temp file', { skip: process.platform === 'win32' }, () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-temp-symlink-'));
  const target = join(configHome, 'target.txt');
  try {
    writeFileSync(target, 'original', { mode: 0o600 });
    symlinkSync(target, join(configHome, 'config.json.tmp'));

    assert.throws(
      () => writeBridgeConfigFile(configHome, {
        LARK_APP_ID: 'cli_0123456789abcdef',
        LARK_APP_SECRET: 'secret',
        CODEX_BIN: '/codex',
      }),
      /config\.json could not be written/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'original');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config example matches the runtime JSON schema', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-json-example-'));
  try {
    const example = readFileSync(resolve('config.example.json'), 'utf8');
    writeFileSync(join(configHome, 'config.json'), example, { mode: 0o600 });

    const env = loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome });

    assert.equal(env.LARK_APP_ID, undefined);
    assert.equal(env.LARK_APP_SECRET, undefined);
    assert.equal(env.CODEX_BIN, '/absolute/path/to/codex');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
