import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCodexEnvironment } from '../../src/app/codex/environment';

test('retains only the explicit Codex subprocess environment allowlist', () => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    HOME: '/Users/tester',
    USER: 'tester',
    LOGNAME: 'tester',
    PATH: '/opt/codex/bin:/usr/bin',
    SHELL: '/bin/zsh',
    TMPDIR: '/private/tmp/tester',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    LC_CTYPE: 'UTF-8',
    TERM: 'xterm-256color',
    CODEX_HOME: '/Users/tester/.codex',
    HTTP_PROXY: 'http://proxy.internal:8080',
    HTTPS_PROXY: 'http://proxy.internal:8080',
    ALL_PROXY: 'socks5://proxy.internal:1080',
    https_proxy: 'http://proxy.internal:8080',
    http_proxy: 'http://proxy.internal:8080',
    all_proxy: 'socks5://proxy.internal:1080',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    SSL_CERT_DIR: '/etc/ssl/certs',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/internal.pem',
    CURL_CA_BUNDLE: '/etc/ssl/curl.pem',
    REQUESTS_CA_BUNDLE: '/etc/ssl/requests.pem',
  };

  const result = buildCodexEnvironment(sourceEnvironment);

  assert.deepEqual(result, sourceEnvironment);
  assert.ok(Object.isFrozen(result));
});

test('removes Bridge credentials, policy and unrelated deployment secrets', () => {
  const result = buildCodexEnvironment({
    PATH: '/usr/bin',
    LARK_APP_ID: 'cli_sensitive',
    LARK_APP_SECRET: 'lark-secret',
    LARK_TENANT_KEY: 'tenant-secret',
    ALLOWED_CHATS: 'oc_sensitive',
    AUTHORIZED_USERS: 'ou_sensitive',
    ALLOWED_APPROVERS: 'ou_sensitive',
    BRIDGE_DATA_DIR: '/private/bridge-data',
    APP_SERVER_MODE: 'owned_stdio',
    APP_SERVER_SOCKET_PATH: '/private/app-server.sock',
    AWS_ACCESS_KEY_ID: 'aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
    AWS_SESSION_TOKEN: 'aws-session-token',
    OPENAI_API_KEY: 'openai-secret',
    DATABASE_URL: 'postgres://user:password@example.invalid/database',
    NODE_OPTIONS: '--require=/tmp/untrusted.js',
    LC_DATABASE_PASSWORD: 'locale-prefix-must-not-bypass-allowlist',
    HTTP_PROXY: 'http://proxy-user:proxy-password@proxy.internal:8080',
  });

  assert.deepEqual(result, { PATH: '/usr/bin' });
});

test('does not mutate the source and returns an immutable copy', () => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    LANG: '',
    LARK_APP_SECRET: 'must-not-leak',
  };
  const originalEntries = Object.entries(sourceEnvironment);

  const result = buildCodexEnvironment(sourceEnvironment);

  assert.notStrictEqual(result, sourceEnvironment);
  assert.deepEqual(Object.entries(sourceEnvironment), originalEntries);
  assert.deepEqual(result, { PATH: '/usr/bin', LANG: '' });
  assert.throws(() => {
    (result as NodeJS.ProcessEnv).PATH = '/tmp/replaced';
  }, TypeError);
});
