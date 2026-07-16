import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeSetupFiles, runSetup } from '../../src/app/setup';

test('init creates a manual configuration skeleton without invoking QR registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-init-'));
  try {
    const configHome = join(root, 'config');
    const report = initializeSetupFiles(configHome, {});
    const env = readFileSync(join(configHome, '.env'), 'utf8');

    assert.equal(report.qrRegistered, false);
    assert.match(env, /^LARK_APP_ID=cli_0123456789abcdef$/m);
    assert.match(env, /^LARK_APP_SECRET=replace_me$/m);
    assert.match(env, /^LARK_TENANT_KEY=$/m);
    assert.match(env, /^ALLOWED_CHATS=$/m);
    assert.match(env, /^AUTHORIZED_USERS=$/m);
    assert.match(env, /^ALLOWED_APPROVERS=$/m);
    assert.equal(existsSync(join(configHome, 'bindings.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup scans a QR code, writes app credentials and preserves existing env entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-setup-'));
  const output: string[] = [];
  const qrUrls: string[] = [];
  try {
    const configHome = join(root, 'config');
    await runSetup({
      configHome,
      stdout: { write: (chunk: string | Uint8Array) => output.push(chunk.toString()) },
      qrRenderer: (url) => {
        qrUrls.push(url);
      },
      registerApp: async (options) => {
        options.onQRCodeReady({ url: 'https://open.feishu.cn/qr', expireIn: 300 });
        options.onStatusChange?.({ status: 'polling' });
        assert.equal(options.appPreset?.name, 'Codex Control Bot ({user})');
        return {
          client_id: 'cli_1111222233334444',
          client_secret: 'registered-secret',
          user_info: { open_id: 'ou_scanner' },
        };
      },
    }, {});

    const envPath = join(configHome, '.env');
    assert.equal(existsSync(envPath), true);
    assert.equal(existsSync(join(configHome, 'bindings.json')), true);
    const env = readFileSync(envPath, 'utf8');
    assert.match(env, /^LARK_APP_ID=cli_1111222233334444$/m);
    assert.match(env, /^LARK_APP_SECRET=registered-secret$/m);
    assert.match(env, /^LARK_TENANT_KEY=$/m);
    assert.match(env, /^ALLOWED_CHATS=$/m);
    assert.match(env, /^AUTHORIZED_USERS=$/m);
    assert.match(env, /^ALLOWED_APPROVERS=$/m);
    assert.match(env, /^BRIDGE_CONFIG_VERSION=2$/m);
    assert.deepEqual(qrUrls, ['https://open.feishu.cn/qr']);
    assert.match(output.join(''), /飞书应用扫码绑定已完成/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup keeps valid credentials and only fills missing defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-setup-existing-'));
  try {
    const configHome = join(root, 'config');
    const envPath = join(configHome, '.env');
    mkdirSync(configHome);
    const customized = [
      '# keep this comment',
      'LARK_APP_ID=cli_aaaabbbbccccdddd',
      'LARK_APP_SECRET=existing-secret',
      'CUSTOM_KEY=custom',
    ].join('\n');
    writeFileSync(envPath, customized);

    const report = await runSetup({
      configHome,
      stdout: { write: () => true },
      registerApp: async () => {
        throw new Error('registerApp should not be called');
      },
    }, {});

    const env = readFileSync(envPath, 'utf8');
    assert.equal(report.qrRegistered, false);
    assert.match(env, /^# keep this comment$/m);
    assert.match(env, /^CUSTOM_KEY=custom$/m);
    assert.match(env, /^LARK_APP_ID=cli_aaaabbbbccccdddd$/m);
    assert.match(env, /^LARK_APP_SECRET=existing-secret$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup persists valid process credentials when creating a new env file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-setup-process-env-'));
  try {
    const configHome = join(root, 'config');
    await runSetup({
      configHome,
      stdout: { write: () => true },
      registerApp: async () => {
        throw new Error('registerApp should not be called');
      },
    }, {
      LARK_APP_ID: 'cli_aaaabbbbccccdddd',
      LARK_APP_SECRET: 'process-secret',
    });

    const env = readFileSync(join(configHome, '.env'), 'utf8');
    const bindings = readFileSync(join(configHome, 'bindings.json'), 'utf8');
    assert.match(env, /^LARK_APP_ID=cli_aaaabbbbccccdddd$/m);
    assert.match(env, /^LARK_APP_SECRET=process-secret$/m);
    assert.match(bindings, /"bindings": \[\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup --rebind replaces existing app credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-setup-rebind-'));
  try {
    const configHome = join(root, 'config');
    await runSetup({
      configHome,
      stdout: { write: () => true },
      registerApp: async (options) => {
        options.onQRCodeReady({ url: 'https://open.feishu.cn/first', expireIn: 300 });
        return { client_id: 'cli_aaaabbbbccccdddd', client_secret: 'old-secret' };
      },
      qrRenderer: () => undefined,
    }, {});

    await runSetup({
      configHome,
      rebind: true,
      stdout: { write: () => true },
      registerApp: async (options) => {
        options.onQRCodeReady({ url: 'https://open.feishu.cn/second', expireIn: 300 });
        return { client_id: 'cli_1111222233334444', client_secret: 'new-secret' };
      },
      qrRenderer: () => undefined,
    }, {});

    const env = readFileSync(join(configHome, '.env'), 'utf8');
    assert.match(env, /^LARK_APP_ID=cli_1111222233334444$/m);
    assert.match(env, /^LARK_APP_SECRET=new-secret$/m);
    assert.doesNotMatch(env, /old-secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
