import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { AppServerClient } from './app-server-client';
import type { AppServerProtocolAdapter } from './app-server-protocol-adapter';
import {
  AppServerControlPlane,
  AppServerControlPlaneError,
} from './app-server-control-plane';
import {
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  parseAppServerUserAgentVersion,
  type AppServerProtocolProfile,
  type AppServerProtocolProfileId,
} from './app-server-protocol-registry';
import { APP_SERVER_PROTOCOL_V145 } from './app-server-protocol-v145';

export const REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS = Object.freeze([
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

export interface AppServerProtocolSmokeTarget {
  readonly codexBin: string;
  readonly codexVersionOutput: string;
  readonly codexVersion: string;
  readonly schemaDigest: string;
}

export interface AppServerProtocolSmokeOptions {
  readonly target: AppServerProtocolSmokeTarget;
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly temporaryRoot: string;
}

export interface OwnedStdioControlPlaneSmokeOptions {
  readonly codexBin: string;
  readonly protocolProfile: AppServerProtocolProfile;
  readonly adapter: AppServerProtocolAdapter;
  readonly temporaryRoot: string;
  readonly temporaryPrefix: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

export interface AppServerProtocolSmokeResult {
  readonly adapterProfileId: AppServerProtocolProfileId;
  readonly provenMethods: typeof REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS;
  readonly rateLimitsCapability: string;
  readonly compactCapability: 'not-attempted:model-operation-prohibited';
}

export type AppServerProtocolSmokeRunner = (
  options: AppServerProtocolSmokeOptions,
) => Promise<AppServerProtocolSmokeResult>;

export class AppServerProtocolSmokeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AppServerProtocolSmokeError';
  }
}

/** Runs the Bridge's non-model control-plane contract against an unknown App Server runtime. */
export async function runAppServerProtocolSmoke(
  options: AppServerProtocolSmokeOptions,
): Promise<AppServerProtocolSmokeResult> {
  const protocolProfile = smokeProfileForRuntime(options.target);
  return runOwnedStdioControlPlaneSmoke({
    codexBin: options.target.codexBin,
    protocolProfile,
    adapter: APP_SERVER_PROTOCOL_V145,
    temporaryRoot: options.temporaryRoot,
    temporaryPrefix: 'bridge-app-server-protocol-smoke-',
    sourceEnv: options.sourceEnv,
  });
}

/**
 * Proves the whitelisted App Server control-plane methods in an isolated Codex home.
 *
 * This deliberately avoids model-starting operations such as `turn/start` and
 * `thread/compact/start`; startup compatibility should prove transport and
 * control-plane shape without consuming user quota or mutating real workspaces.
 */
export async function runOwnedStdioControlPlaneSmoke(
  options: OwnedStdioControlPlaneSmokeOptions,
): Promise<AppServerProtocolSmokeResult> {
  const root = mkdtempSync(join(options.temporaryRoot, options.temporaryPrefix));
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
        ...(options.sourceEnv ?? process.env),
        HOME: root,
        CODEX_HOME: codexHome,
        TMPDIR: root,
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
    const initializedVersion = parseAppServerUserAgentVersion(initialized.userAgent).version;
    if (initializedVersion !== options.protocolProfile.codexVersion) {
      throw new AppServerProtocolSmokeError(
        'App Server initialize identity does not match CLI version',
      );
    }

    await controlPlane.request('thread/list', { limit: 5, archived: false, cwd: workspace });
    provenMethods.push('thread/list');

    const created = await controlPlane.request('thread/start', {
      threadSource: 'user',
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
    });
    const threadId = threadIdFromLifecycleResponse(created, 'thread/start');
    disposableThreadIds.push(threadId);
    provenMethods.push('thread/start');

    await controlPlane.request('thread/name/set', { threadId, name: 'Bridge protocol smoke' });
    provenMethods.push('thread/name/set');

    const read = await controlPlane.request('thread/read', { threadId, includeTurns: true });
    requireSameThread(read, threadId, 'thread/read');
    provenMethods.push('thread/read');

    const resumed = await controlPlane.request('thread/resume', {
      threadId,
      cwd: workspace,
      excludeTurns: false,
    });
    requireSameThread(resumed, threadId, 'thread/resume');
    provenMethods.push('thread/resume');

    const forked = await controlPlane.request('thread/fork', { threadId, threadSource: 'user' });
    disposableThreadIds.push(threadIdFromLifecycleResponse(forked, 'thread/fork'));
    provenMethods.push('thread/fork');

    await controlPlane.request('thread/goal/set', {
      threadId,
      objective: 'Validate isolated control plane',
      status: 'active',
    });
    provenMethods.push('thread/goal/set');

    const goal = await controlPlane.request('thread/goal/get', { threadId });
    requireGoalObjective(goal, 'Validate isolated control plane');
    provenMethods.push('thread/goal/get');

    const cleared = await controlPlane.request('thread/goal/clear', { threadId });
    requireClearedGoal(cleared);
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
      adapterProfileId: options.adapter.profileId,
      provenMethods: requireSmokeMethods(provenMethods),
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

function smokeProfileForRuntime(target: AppServerProtocolSmokeTarget): AppServerProtocolProfile {
  return Object.freeze({
    ...APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
    codexVersion: target.codexVersion,
    cliVersionOutput: target.codexVersionOutput,
    schemaDigest: target.schemaDigest,
    diagnosticLabel: `Codex App Server ${target.codexVersion} protocol smoke`,
  });
}

async function probeRateLimits(controlPlane: AppServerControlPlane): Promise<string> {
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

function threadIdFromLifecycleResponse(response: unknown, method: string): string {
  const lifecycle = requiredRecord(response, method);
  const thread = requiredRecord(lifecycle.thread, method);
  const threadId = requiredString(thread.id, method);
  return threadId;
}

function requireSameThread(response: unknown, threadId: string, method: string): void {
  const actualThreadId = threadIdFromLifecycleResponse(response, method);
  if (actualThreadId !== threadId) {
    throw new AppServerProtocolSmokeError(`${method} returned an unexpected thread id`);
  }
}

function requireGoalObjective(response: unknown, expectedObjective: string): void {
  const goalResponse = requiredRecord(response, 'thread/goal/get');
  const goal = requiredRecord(goalResponse.goal, 'thread/goal/get');
  const objective = requiredString(
    goal.objective,
    'thread/goal/get',
  );
  if (objective !== expectedObjective) {
    throw new AppServerProtocolSmokeError('thread/goal/get returned an unexpected objective');
  }
}

function requireClearedGoal(response: unknown): void {
  const cleared = requiredRecord(response, 'thread/goal/clear').cleared;
  if (cleared !== true) {
    throw new AppServerProtocolSmokeError('thread/goal/clear did not confirm goal cleanup');
  }
}

function requireSmokeMethods(
  provenMethods: readonly string[],
): typeof REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS {
  if (
    provenMethods.length !== REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS.length
    || provenMethods.some((method, index) => (
      method !== REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS[index]
    ))
  ) {
    throw new AppServerProtocolSmokeError('App Server protocol smoke did not prove the required method matrix');
  }
  return REQUIRED_APP_SERVER_PROTOCOL_SMOKE_METHODS;
}

function requiredRecord(value: unknown, method: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppServerProtocolSmokeError(`${method} returned an invalid response`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, method: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppServerProtocolSmokeError(`${method} returned an invalid response`);
  }
  return value;
}
