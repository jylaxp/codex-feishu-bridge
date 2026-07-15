import { randomUUID } from 'node:crypto';

import { AppServerClient } from './codex/app-server-client';
import { SUPPORTED_APP_SERVER_VERSION } from './codex/contract';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import {
  ServerNotification,
  Thread,
  ThreadListParams,
  ThreadListResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  TurnStartParams,
  TurnStartResponse,
} from './codex/protocol';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { runPreflight } from './preflight';

const DEFAULT_VALIDATION_TIMEOUT_MS = 120_000;

export interface UiSyncThreadCandidate {
  readonly threadId: string;
  readonly status: string;
  readonly updatedAt: number;
}

export interface UiSyncEvidence {
  readonly generatedAt: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly nonce: string;
  readonly observedMethods: readonly string[];
  readonly eventStreamConfirmed: boolean;
  readonly turnCompleted: boolean;
  readonly desktopPageSync: 'manual_verification_required';
  readonly verdict: 'bridge_stream_confirmed_desktop_unverified' | 'bridge_stream_incomplete';
}

export type UiSyncValidationResult =
  | { readonly mode: 'thread_list'; readonly threads: readonly UiSyncThreadCandidate[] }
  | { readonly mode: 'validation'; readonly evidence: UiSyncEvidence };

/**
 * Runs an isolated managed-proxy experiment. It never touches the production
 * bridge database and never claims Desktop rendering without human evidence.
 */
export async function runUiSyncValidator(
  env: NodeJS.ProcessEnv,
  threadId?: string,
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS,
): Promise<UiSyncValidationResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new RangeError('UI sync validation timeout must be between 1s and 10m');
  }
  const effectiveEnv = loadBridgeEnvironment(env);
  const preflight = runPreflight(parseEnvironment(effectiveEnv));
  const config = preflight.config;
  await verifyCodexRuntimeContract(config, effectiveEnv, preflight.runtimeDirectory.temporaryDir);
  const client = new AppServerClient({
    transport: {
      mode: 'managed_proxy',
      codexBin: config.codexBin,
      spawnCwd: config.codexCwd,
      env: effectiveEnv,
      ...(config.appServerSocketPath ? { socketPath: config.appServerSocketPath } : {}),
    },
    clientInfo: {
      name: 'lark_codex_ui_sync_validator',
      title: 'Lark Codex UI Sync Validator',
      version: '2.0.0',
    },
    expectedServerVersion: SUPPORTED_APP_SERVER_VERSION,
  });

  await client.start();
  try {
    if (!threadId) {
      const params: ThreadListParams = {
        limit: 20,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        cwd: config.codexCwd,
      };
      const response = await client.request<ThreadListResponse>('thread/list', params);
      return {
        mode: 'thread_list',
        threads: response.data.map(createUiSyncThreadCandidate),
      };
    }

    const resumeParams: ThreadResumeParams = {
      threadId,
      cwd: config.codexCwd,
      runtimeWorkspaceRoots: [config.codexCwd],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      excludeTurns: false,
    };
    const resumed = await client.request<ThreadResumeResponse>('thread/resume', resumeParams);
    if (resumed.thread.id !== threadId) {
      throw new Error('UI sync validator resumed a different thread');
    }

    const nonce = `LARK_UI_SYNC_${randomUUID()}`;
    const observer = observeValidationTurn(client, threadId, timeoutMs);
    const turnParams: TurnStartParams = {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{
        type: 'text',
        text: `UI sync validation. Reply with this nonce only: ${nonce}`,
        text_elements: [],
      }],
      cwd: config.codexCwd,
      runtimeWorkspaceRoots: [config.codexCwd],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    };
    let response: TurnStartResponse;
    let observation: { readonly methods: string[]; readonly completed: boolean };
    try {
      response = await client.request<TurnStartResponse>('turn/start', turnParams);
      observation = await observer.waitFor(response.turn.id);
    } finally {
      observer.stop();
    }
    const eventStreamConfirmed = observation.methods.some((method) => (
      method === 'turn/started'
      || method === 'item/agentMessage/delta'
      || method === 'item/completed'
    ));
    return {
      mode: 'validation',
      evidence: Object.freeze({
        generatedAt: new Date().toISOString(),
        threadId,
        turnId: response.turn.id,
        nonce,
        observedMethods: Object.freeze(observation.methods),
        eventStreamConfirmed,
        turnCompleted: observation.completed,
        desktopPageSync: 'manual_verification_required',
        verdict: eventStreamConfirmed
          ? 'bridge_stream_confirmed_desktop_unverified'
          : 'bridge_stream_incomplete',
      }),
    };
  } finally {
    await client.stop();
  }
}

/** Reduces a thread to the non-content metadata safe for CLI output. */
export function createUiSyncThreadCandidate(thread: Thread): UiSyncThreadCandidate {
  const updatedAt = thread.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new TypeError('App Server thread/list returned an invalid updatedAt value');
  }
  return Object.freeze({
    threadId: thread.id,
    status: thread.status.type,
    updatedAt,
  });
}

interface TurnObserver {
  waitFor(turnId: string): Promise<{ readonly methods: string[]; readonly completed: boolean }>;
  stop(): void;
}

function observeValidationTurn(
  client: AppServerClient,
  threadId: string,
  timeoutMs: number,
): TurnObserver {
  const notifications: ServerNotification[] = [];
  const unsubscribe = client.onNotification((notification) => {
    const params = asRecord(notification.params);
    if (params?.threadId === threadId) {
      notifications.push(notification);
    }
  });
  return {
    waitFor: async (turnId) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const matching = notifications.filter((notification) => (
          notificationTurnId(notification) === turnId
        ));
        const completed = matching.some((notification) => notification.method === 'turn/completed');
        if (completed) {
          return { methods: matching.map((notification) => notification.method), completed };
        }
        await delay(100);
      }
      const matching = notifications.filter((notification) => (
        notificationTurnId(notification) === turnId
      ));
      return { methods: matching.map((notification) => notification.method), completed: false };
    },
    stop: unsubscribe,
  };
}

function notificationTurnId(notification: ServerNotification): string | null {
  const params = asRecord(notification.params);
  if (typeof params?.turnId === 'string') {
    return params.turnId;
  }
  const turn = asRecord(params?.turn);
  return typeof turn?.id === 'string' ? turn.id : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
