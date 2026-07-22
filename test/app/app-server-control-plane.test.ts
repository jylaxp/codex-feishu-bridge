import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { AppServerClient } from '../../src/app/codex/app-server-client';
import type { AppServerProtocolAdapter } from '../../src/app/codex/app-server-protocol-adapter';
import {
  AppServerControlPlane,
  AppServerControlPlaneError,
  adapterForAppServerProfile,
  type AppServerRequestClient,
} from '../../src/app/codex/app-server-control-plane';
import {
  APP_SERVER_PROTOCOL_PROFILE_0_144_3,
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  parseAppServerUserAgentVersion,
  parseCodexCliVersion,
  type AppServerProtocolProfile,
} from '../../src/app/codex/app-server-protocol-registry';
import {
  builtInProtocolVersionConfig,
  profileForSupportedVersion,
} from '../../src/app/codex/protocol-version-config';
import { APP_SERVER_PROTOCOL_V144 } from '../../src/app/codex/app-server-protocol-v144';
import { APP_SERVER_PROTOCOL_V145 } from '../../src/app/codex/app-server-protocol-v145';

const projectRoot = resolve(__dirname, '../../..');
const fixtures = JSON.parse(readFileSync(resolve(
  projectRoot,
  'test/fixtures/app-server/0.145.0-alpha.18/control-plane-responses.json',
), 'utf8')) as Record<string, unknown>;
const fixtures144 = JSON.parse(readFileSync(resolve(
  projectRoot,
  'test/fixtures/app-server/0.144.3/control-plane-responses.json',
), 'utf8')) as Record<string, unknown>;

const methodFixtures = Object.freeze([
  ['thread/list', 'threadList'],
  ['thread/read', 'threadRead'],
  ['thread/resume', 'threadResume'],
  ['thread/start', 'threadStart'],
  ['thread/fork', 'threadFork'],
  ['thread/name/set', 'empty'],
  ['thread/archive', 'empty'],
  ['thread/goal/get', 'goalGet'],
  ['thread/goal/set', 'goalSet'],
  ['thread/goal/clear', 'goalClear'],
  ['thread/compact/start', 'empty'],
  ['skills/list', 'skillsList'],
  ['mcpServerStatus/list', 'mcpList'],
  ['account/rateLimits/read', 'rateLimits'],
  ['turn/start', 'turnStart'],
] as const);

test('profile adapter selection maps each exact profile and rejects unknown profiles', () => {
  assert.equal(
    adapterForAppServerProfile(APP_SERVER_PROTOCOL_PROFILE_0_144_3),
    APP_SERVER_PROTOCOL_V144,
  );
  assert.equal(
    adapterForAppServerProfile(APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18),
    APP_SERVER_PROTOCOL_V145,
  );
  const unknown = {
    ...APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
    id: 'app-server-unknown',
  } as unknown as typeof APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18;
  assert.throws(() => adapterForAppServerProfile(unknown), /Unsupported App Server protocol profile/);
});

test('request mapping removes every reviewed 145-only field from 144 without mutation', async () => {
  const cases = [
    {
      method: 'thread/start',
      params: { cwd: '/workspace', runtimeWorkspaceRoots: ['/workspace'] },
      expected144: { cwd: '/workspace' },
      response144: fixtures144.threadStart,
      response145: fixtures.threadStart,
    },
    {
      method: 'thread/fork',
      params: { threadId: 'thread-1', beforeTurnId: 'turn-1', deferGoalContinuation: true },
      expected144: { threadId: 'thread-1' },
      response144: fixtures144.threadFork,
      response145: fixtures.threadFork,
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
        runtimeWorkspaceRoots: ['/workspace'],
      },
      expected144: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      response144: fixtures144.turnStart,
      response145: fixtures.turnStart,
    },
  ] as const;

  for (const candidate of cases) {
    const client144 = new RecordingClient({ [candidate.method]: candidate.response144 });
    const client145 = new RecordingClient({ [candidate.method]: candidate.response145 });
    const original = structuredClone(candidate.params);

    await new AppServerControlPlane(client144, APP_SERVER_PROTOCOL_V144)
      .request(candidate.method, candidate.params);
    await new AppServerControlPlane(client145, APP_SERVER_PROTOCOL_V145)
      .request(candidate.method, candidate.params);

    assert.deepEqual(client144.calls, [{ method: candidate.method, params: candidate.expected144 }]);
    assert.deepEqual(client145.calls, [{ method: candidate.method, params: candidate.params }]);
    assert.deepEqual(candidate.params, original);
  }
});

test('request mapping failures are distinct and stop before transport', async () => {
  const client = new RecordingClient({});
  const controlPlane = new AppServerControlPlane(client, {
    ...APP_SERVER_PROTOCOL_V145,
    mapRequest: () => {
      throw new Error('mapping failed');
    },
  });

  await assert.rejects(
    controlPlane.request('thread/list', {}),
    (error: unknown) => (
      error instanceof AppServerControlPlaneError
      && error.code === 'INVALID_REQUEST'
    ),
  );
  assert.deepEqual(client.calls, []);
});

test('both adapters accept sparse legal turns and preserve the original response', async () => {
  for (const adapter of [APP_SERVER_PROTOCOL_V144, APP_SERVER_PROTOCOL_V145]) {
    const sparseTurn = {
      id: `turn-${adapter.profileId}`,
      items: [],
      status: 'inProgress',
      additiveField: true,
    };
    const turnStart = { turn: sparseTurn, additiveResponseField: true };
    const resume = {
      thread: { id: 'thread-1', turns: [sparseTurn] },
      model: 'gpt-test',
      additiveResponseField: true,
    };
    const client = new RecordingClient({
      'turn/start': turnStart,
      'thread/resume': resume,
    });
    const controlPlane = new AppServerControlPlane(client, adapter);

    assert.equal(await controlPlane.request('turn/start', {}), turnStart);
    assert.equal(await controlPlane.request('thread/resume', {}), resume);
  }
});

test('144 control plane validates every registered response and preserves additive fields', async () => {
  const client = new RecordingClient(Object.fromEntries(methodFixtures.map(([method, fixture]) => (
    [method, fixtures144[fixture]]
  ))));
  const controlPlane = new AppServerControlPlane(client, APP_SERVER_PROTOCOL_V144);

  for (const [method, fixture] of methodFixtures) {
    const result = await controlPlane.request<Record<string, unknown>>(method, { marker: method });
    assert.equal(result, fixtures144[fixture], method);
  }
  assert.equal(containsKeyDeep(fixtures144.threadResume, 'legacyExtension'), true);
  assert.equal(containsKeyDeep(fixtures144.rateLimits, 'legacyExtension'), true);
  assert.deepEqual(
    client.calls,
    methodFixtures.map(([method]) => ({ method, params: { marker: method } })),
  );
});

test('144 response validation rejects invalid consumed fields', async () => {
  const response = { ...recordFixtureFrom(fixtures144, 'threadList'), data: 'invalid' };
  const controlPlane = new AppServerControlPlane(
    new RecordingClient({ 'thread/list': response }),
    APP_SERVER_PROTOCOL_V144,
  );

  await assert.rejects(
    controlPlane.request('thread/list', {}),
    (error: unknown) => (
      error instanceof AppServerControlPlaneError
      && error.code === 'INVALID_RESPONSE'
    ),
  );
});

test('144 thread metadata accepts schema-optional name and additive fields', async () => {
  const response = structuredClone(recordFixtureFrom(fixtures144, 'threadList'));
  const thread = nestedRecord(response, 'data', 0);
  delete thread.name;
  thread.future144Field = { ignored: true };
  const controlPlane = new AppServerControlPlane(
    new RecordingClient({ 'thread/list': response }),
    APP_SERVER_PROTOCOL_V144,
  );

  assert.equal(await controlPlane.request('thread/list', {}), response);
});

test('145 control plane validates every registered response and preserves additive fields', async () => {
  const client = new RecordingClient(Object.fromEntries(methodFixtures.map(([method, fixture]) => (
    [method, fixtures[fixture]]
  ))));
  const controlPlane = new AppServerControlPlane(client, APP_SERVER_PROTOCOL_V145);
  const results = new Map<string, Record<string, unknown>>();

  for (const [method, fixture] of methodFixtures) {
    const result = await controlPlane.request<Record<string, unknown>>(method, { marker: method });
    assert.equal(result, fixtures[fixture], method);
    results.set(method, result);
  }
  assert.equal(containsKeyDeep(fixtures.threadResume, 'upstreamExtension'), true);
  assert.equal(containsKeyDeep(fixtures.rateLimits, 'upstreamExtension'), true);
  const resumedTurn = nestedRecord(results.get('thread/resume'), 'thread', 'turns', 0);
  assert.deepEqual(resumedTurn.input, [{
    type: 'skill',
    name: 'review',
    path: '/skills/review/SKILL.md',
  }]);
  assert.equal(nestedRecord(resumedTurn, 'tokenUsage').inputTokens, 120);
  assert.equal(nestedRecord(resumedTurn, 'items', 0).toolName, 'read_file');
  assert.deepEqual(
    client.calls,
    methodFixtures.map(([method]) => ({ method, params: { marker: method } })),
  );
});

test('145 response categories reject missing or wrongly typed consumed fields', async () => {
  const invalidByMethod: Readonly<Record<string, unknown>> = {
    'thread/list': { ...recordFixture('threadList'), data: 'not-an-array' },
    'thread/read': { ...recordFixture('threadRead'), thread: null },
    'thread/resume': { ...recordFixture('threadResume'), model: 145 },
    'thread/start': { ...recordFixture('threadStart'), thread: { id: null } },
    'thread/fork': { ...recordFixture('threadFork'), thread: { id: 12 } },
    'thread/name/set': null,
    'thread/archive': [],
    'thread/goal/get': { goal: { objective: 12 } },
    'thread/goal/set': { goal: null },
    'thread/goal/clear': { cleared: 'yes' },
    'thread/compact/start': 'done',
    'skills/list': { data: [{ cwd: '/workspace', skills: 'invalid' }] },
    'mcpServerStatus/list': { data: [{ name: 10 }], nextCursor: null },
    'account/rateLimits/read': { rateLimits: { primary: { usedPercent: '25' } } },
    'turn/start': { turn: { id: 'turn-new', items: [], status: 'unknown' } },
  };

  for (const [method, response] of Object.entries(invalidByMethod)) {
    const controlPlane = new AppServerControlPlane(
      new RecordingClient({ [method]: response }),
      APP_SERVER_PROTOCOL_V145,
    );
    await assert.rejects(
      controlPlane.request(method, {}),
      (error: unknown) => {
        assert.equal(error instanceof AppServerControlPlaneError, true);
        assert.equal((error as AppServerControlPlaneError).code, 'INVALID_RESPONSE');
        assert.equal(errorText(error).includes(JSON.stringify(response)), false);
        return true;
      },
      method,
    );
  }
});

test('unknown methods fail closed before reaching the request client', async () => {
  const client = new RecordingClient({});
  const controlPlane = new AppServerControlPlane(client, APP_SERVER_PROTOCOL_V145);

  await assert.rejects(
    controlPlane.request('config/read', {}),
    (error: unknown) => (
      error instanceof AppServerControlPlaneError
      && error.code === 'UNSUPPORTED_METHOD'
    ),
  );
  assert.deepEqual(client.calls, []);
});

test('transport and RPC failures are replaced with a stable non-sensitive error', async () => {
  const secret = 'token=secret-value /Users/private/work\nsecond line';
  const client: AppServerRequestClient = {
    request: async () => Promise.reject(new Error(secret)),
  };
  const controlPlane = new AppServerControlPlane(client, APP_SERVER_PROTOCOL_V145);

  await assert.rejects(
    controlPlane.request('thread/list', {}),
    (error: unknown) => {
      assert.equal(error instanceof AppServerControlPlaneError, true);
      assert.equal((error as AppServerControlPlaneError).code, 'REQUEST_FAILED');
      assert.equal(errorText(error).includes(secret), false);
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    },
  );
});

test('goal get accepts the explicit null state', async () => {
  const response = { goal: null, upstreamExtension: true };
  const controlPlane = new AppServerControlPlane(
    new RecordingClient({ 'thread/goal/get': response }),
    APP_SERVER_PROTOCOL_V145,
  );

  assert.equal(await controlPlane.request('thread/goal/get', {}), response);
});

test('exact 145 owned stdio proves the isolated non-model control-plane matrix', async (t) => {
  const codexBin = process.env.CODEX_145_BIN
    ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (!existsSync(codexBin)) {
    t.skip('configured or ChatGPT bundled Codex 0.145 binary is unavailable');
    return;
  }
  const cliVersion = execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim();
  const codexVersion = parseCodexCliVersion(cliVersion).version;
  const supportedVersion = builtInProtocolVersionConfig().supportedVersions.find(
    (entry) => entry.codexVersion === codexVersion,
  );
  assert.ok(supportedVersion, `${cliVersion} is not built into the support catalog`);
  const protocolProfile = profileForSupportedVersion(supportedVersion);
  const result = await runOwnedStdioControlPlaneSmoke({
    codexBin,
    protocolProfile,
    adapter: APP_SERVER_PROTOCOL_V145,
    temporaryPrefix: 'bridge-app-server-145-smoke-',
  });
  assert.deepEqual(result.provenMethods, REQUIRED_REAL_SMOKE_METHODS);
  assert.match(result.rateLimitsCapability, /^(available|unavailable:(REQUEST_FAILED|INVALID_RESPONSE))$/);
  assert.equal(result.compactCapability, 'not-attempted:model-operation-prohibited');
  t.diagnostic(`${codexVersion} rateLimits=${result.rateLimitsCapability}`);
});

test('exact 144 owned stdio proves the isolated non-model control-plane matrix', async (t) => {
  const codexBin = process.env.CODEX_144_BIN;
  if (codexBin === undefined || !existsSync(codexBin)) {
    t.skip('CODEX_144_BIN must explicitly select an available Codex 0.144.3 binary');
    return;
  }
  const result = await runOwnedStdioControlPlaneSmoke({
    codexBin,
    protocolProfile: APP_SERVER_PROTOCOL_PROFILE_0_144_3,
    adapter: APP_SERVER_PROTOCOL_V144,
    temporaryPrefix: 'bridge-app-server-144-smoke-',
  });
  assert.deepEqual(result.provenMethods, REQUIRED_REAL_SMOKE_METHODS);
  assert.match(result.rateLimitsCapability, /^(available|unavailable:(REQUEST_FAILED|INVALID_RESPONSE))$/);
  assert.equal(result.compactCapability, 'not-attempted:model-operation-prohibited');
  t.diagnostic(`144 rateLimits=${result.rateLimitsCapability}`);
});

const REQUIRED_REAL_SMOKE_METHODS = Object.freeze([
  'thread/list',
  'thread/start',
  'thread/name/set',
  'thread/read',
  'thread/resume',
  'thread/fork',
  'thread/goal/set',
  'thread/goal/get',
  'thread/goal/clear',
  'skills/list',
  'mcpServerStatus/list',
  'thread/archive',
] as const);

interface OwnedStdioSmokeOptions {
  readonly codexBin: string;
  readonly protocolProfile: AppServerProtocolProfile;
  readonly adapter: AppServerProtocolAdapter;
  readonly temporaryPrefix: string;
}

interface OwnedStdioSmokeResult {
  readonly provenMethods: readonly string[];
  readonly rateLimitsCapability: string;
  readonly compactCapability: 'not-attempted:model-operation-prohibited';
}

async function runOwnedStdioControlPlaneSmoke(
  options: OwnedStdioSmokeOptions,
): Promise<OwnedStdioSmokeResult> {
  const root = mkdtempSync(join(tmpdir(), options.temporaryPrefix));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  mkdirSync(codexHome);
  mkdirSync(workspace);
  const client = new AppServerClient({
    transport: {
      mode: 'owned_stdio',
      codexBin: options.codexBin,
      spawnCwd: workspace,
      env: {
        HOME: root,
        CODEX_HOME: codexHome,
        TMPDIR: root,
        PATH: process.env.PATH,
      },
    },
    protocolProfile: options.protocolProfile,
    clientInfo: {
      name: 'lark_codex_control_plane_smoke',
      title: 'Lark Codex Control Plane Smoke',
      version: '3.0.0',
    },
    requestTimeoutMs: 10_000,
    terminationGraceMs: 2_000,
  });
  const controlPlane = new AppServerControlPlane(client, options.adapter);
  const provenMethods: string[] = [];
  const disposableThreadIds: string[] = [];
  const archivedThreadIds = new Set<string>();
  let started = false;

  try {
    const initialized = await client.start();
    started = true;
    assert.equal(
      parseAppServerUserAgentVersion(initialized.userAgent).version,
      options.protocolProfile.codexVersion,
    );
    assert.equal(client.state, 'READY');

    const threads = await controlPlane.request<{ readonly data: readonly unknown[] }>(
      'thread/list',
      { limit: 5, archived: false, cwd: workspace },
    );
    assert.deepEqual(threads.data, []);
    provenMethods.push('thread/list');

    const created = await controlPlane.request<{ readonly thread: { readonly id: string } }>(
      'thread/start',
      { threadSource: 'user', cwd: workspace, runtimeWorkspaceRoots: [workspace] },
    );
    const threadId = created.thread.id;
    assert.equal(typeof threadId, 'string');
    disposableThreadIds.push(threadId);
    provenMethods.push('thread/start');

    await controlPlane.request('thread/name/set', { threadId, name: 'Bridge protocol smoke' });
    provenMethods.push('thread/name/set');
    const read = await controlPlane.request<{ readonly thread: { readonly id: string } }>(
      'thread/read',
      { threadId, includeTurns: true },
    );
    assert.equal(read.thread.id, threadId);
    provenMethods.push('thread/read');
    const resumed = await controlPlane.request<{ readonly thread: { readonly id: string } }>(
      'thread/resume',
      { threadId, cwd: workspace, excludeTurns: false },
    );
    assert.equal(resumed.thread.id, threadId);
    provenMethods.push('thread/resume');

    const forked = await controlPlane.request<{ readonly thread: { readonly id: string } }>(
      'thread/fork',
      { threadId, threadSource: 'user' },
    );
    const forkedThreadId = forked.thread.id;
    assert.equal(typeof forkedThreadId, 'string');
    disposableThreadIds.push(forkedThreadId);
    provenMethods.push('thread/fork');

    await controlPlane.request('thread/goal/set', {
      threadId,
      objective: 'Validate isolated control plane',
      status: 'active',
    });
    provenMethods.push('thread/goal/set');
    const goal = await controlPlane.request<{ readonly goal: { readonly objective: string } }>(
      'thread/goal/get',
      { threadId },
    );
    assert.equal(goal.goal.objective, 'Validate isolated control plane');
    provenMethods.push('thread/goal/get');
    const cleared = await controlPlane.request<{ readonly cleared: boolean }>(
      'thread/goal/clear',
      { threadId },
    );
    assert.equal(cleared.cleared, true);
    provenMethods.push('thread/goal/clear');

    await controlPlane.request('skills/list', { cwds: [workspace], forceReload: false });
    provenMethods.push('skills/list');
    await controlPlane.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
    provenMethods.push('mcpServerStatus/list');

    const rateLimitsCapability = await probeRateLimits(controlPlane);
    for (const disposableThreadId of [...disposableThreadIds].reverse()) {
      await controlPlane.request('thread/archive', { threadId: disposableThreadId });
      archivedThreadIds.add(disposableThreadId);
    }
    provenMethods.push('thread/archive');
    return Object.freeze({
      provenMethods: Object.freeze(provenMethods),
      rateLimitsCapability,
      compactCapability: 'not-attempted:model-operation-prohibited' as const,
    });
  } finally {
    if (started) {
      for (const threadId of disposableThreadIds) {
        if (!archivedThreadIds.has(threadId)) {
          await controlPlane.request('thread/archive', { threadId }).catch(() => undefined);
        }
      }
    }
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

async function probeRateLimits(
  controlPlane: AppServerControlPlane,
): Promise<string> {
  try {
    await controlPlane.request('account/rateLimits/read', {});
    return 'available';
  } catch (error) {
    if (
      error instanceof AppServerControlPlaneError
      && (error.code === 'REQUEST_FAILED' || error.code === 'INVALID_RESPONSE')
    ) {
      return `unavailable:${error.code}`;
    }
    throw error;
  }
}

class RecordingClient implements AppServerRequestClient {
  readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];

  constructor(private readonly responses: Readonly<Record<string, unknown>>) {}

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    return this.responses[method] as TResult;
  }
}

function recordFixture(name: string): Record<string, unknown> {
  return recordFixtureFrom(fixtures, name);
}

function recordFixtureFrom(
  source: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const fixture = source[name];
  assert.equal(typeof fixture, 'object');
  assert.notEqual(fixture, null);
  assert.equal(Array.isArray(fixture), false);
  return fixture as Record<string, unknown>;
}

function nestedRecord(
  root: unknown,
  ...path: readonly (string | number)[]
): Record<string, unknown> {
  let value = root;
  for (const part of path) {
    if (typeof part === 'number') {
      assert.equal(Array.isArray(value), true);
      value = (value as unknown[])[part];
    } else {
      assert.equal(value !== null && typeof value === 'object', true);
      value = (value as Record<string, unknown>)[part];
    }
  }
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true);
  return value as Record<string, unknown>;
}

function containsKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsKeyDeep(item, key));
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key)
    || Object.values(record).some((item) => containsKeyDeep(item, key));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
