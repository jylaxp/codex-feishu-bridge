import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import type { TrackedRequestIdentity } from './app-server-client';
import { macosDesktopIpcSocketPath } from '../platform/macos-platform-adapter';
import { createPlatformAdapter } from '../platform/create-platform-adapter';
import {
  DesktopIpcEndpointError,
  type DesktopIpcEndpoint,
  type PlatformAdapter,
} from '../platform/platform-adapter';
import type {
  Turn,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from './protocol';
import {
  approvalResponseMethod,
  type DesktopApprovalKind,
} from './desktop-approval-adapter';
import { DESKTOP_IPC_CONTRACT } from './desktop-ipc-contract';
import { DESKTOP_THREAD_STREAM_PROTOCOL_VERSION } from './desktop-thread-stream-normalizer';

export type DesktopIpcConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'INITIALIZING'
  | 'READY'
  | 'CLOSING'
  | 'CLOSED'
  | 'FAILED';

export type DesktopIpcDeliveryDisposition =
  | 'PROVABLY_UNSENT'
  | 'DEFINITIVE_FAILURE'
  | 'OUTCOME_UNKNOWN';

export type DesktopIpcErrorCode =
  | 'DESKTOP_IPC_SOCKET_NOT_FOUND'
  | 'DESKTOP_IPC_INVALID_SOCKET'
  | 'DESKTOP_IPC_CONNECT_FAILED'
  | 'DESKTOP_IPC_CONNECT_TIMEOUT'
  | 'DESKTOP_IPC_INITIALIZE_FAILED'
  | 'DESKTOP_IPC_NOT_READY'
  | 'DESKTOP_IPC_REMOTE_REJECTED'
  | 'DESKTOP_IPC_REQUEST_TIMEOUT'
  | 'DESKTOP_IPC_CONNECTION_LOST'
  | 'DESKTOP_IPC_INVALID_RESPONSE'
  | 'DESKTOP_IPC_PROTOCOL_ERROR'
  | 'DESKTOP_IPC_UNSUPPORTED_METHOD'
  | 'DESKTOP_IPC_CLIENT_STOPPED';

/** Error with an explicit delivery boundary used to prevent duplicate turns. */
export class DesktopIpcRequestError extends Error {
  public constructor(
    public readonly code: DesktopIpcErrorCode,
    public readonly disposition: DesktopIpcDeliveryDisposition,
    public readonly epoch: number,
    public readonly method: string | null = null,
    public readonly requestId: string | null = null,
    options?: ErrorOptions,
    /** A recognized remote rejection that is safe for a caller to handle explicitly. */
    public readonly remoteError: 'no-client-found' | null = null,
  ) {
    super(code, options);
    this.name = 'DesktopIpcRequestError';
  }
}

export interface DesktopIpcHandshake {
  readonly clientId: string;
  readonly epoch: number;
  readonly socketPath: string;
  readonly transport: DesktopIpcEndpoint['transport'];
}

export interface DesktopJsonPatch {
  readonly op: 'add' | 'replace' | 'remove';
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
}

export interface DesktopThreadStreamBroadcast extends Readonly<Record<string, unknown>> {
  readonly type: 'broadcast';
  readonly method: 'thread-stream-state-changed';
  readonly sourceClientId?: string;
  readonly version: number;
  readonly params: {
    readonly conversationId: string;
    readonly change:
      | {
          readonly type: 'snapshot';
          readonly conversationState: Readonly<Record<string, unknown>>;
        }
      | {
          readonly type: 'patches';
          readonly patches: readonly DesktopJsonPatch[];
        };
  };
}

export interface DesktopIpcClientOptions {
  readonly socketPath?: string;
  readonly endpoint?: DesktopIpcEndpoint;
  readonly platformAdapter?: PlatformAdapter;
  readonly connectTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly requestIdFactory?: () => string;
  /** Test seam for framed transport behavior; production always uses createConnection. */
  readonly connectSocket?: (address: string) => Socket;
  /** Test seam for follower recovery timing; production uses the bounded backoff schedule. */
  readonly followingRetryDelaysMs?: readonly number[];
}

export interface DesktopApprovalResponse {
  readonly threadId: string;
  readonly requestId: string | number;
  readonly kind: DesktopApprovalKind;
  readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}

type WireRecord = Readonly<Record<string, unknown>>;

interface PendingRequest {
  readonly epoch: number;
  readonly method: string;
  readonly requestId: string;
  readonly sent: boolean;
  readonly resolve: (response: WireRecord) => void;
  readonly reject: (error: DesktopIpcRequestError) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ThreadFollowingWaiter {
  readonly epoch: number;
  readonly resolve: (available: boolean) => void;
  readonly timeout: NodeJS.Timeout;
}

interface SendRequestOptions {
  readonly method: string;
  readonly params: unknown;
  readonly version?: number;
  readonly timeoutMs: number;
  readonly allowInitializing?: boolean;
  readonly beforeSend?: (identity: TrackedRequestIdentity) => void;
}

type ThreadStreamListener = (message: DesktopThreadStreamBroadcast, epoch: number) => void;
type ConnectionLossListener = (epoch: number) => void;

const DESKTOP_THREAD_FOLLOWING_PROTOCOL_VERSION = DESKTOP_IPC_CONTRACT.followingProtocolVersion;
const DESKTOP_HOST_ID = 'local';
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const THREAD_FOLLOWING_RETRY_DELAYS_MS = Object.freeze([
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
]);
const MIN_TIMEOUT_MS = 1;

/**
 * Compatibility export for callers which need the established macOS socket
 * path. New code should obtain an attested endpoint from PlatformAdapter.
 */
export function desktopIpcSocketPath(
  temporaryDirectory?: string,
  uid = process.getuid?.(),
): string {
  return macosDesktopIpcSocketPath(temporaryDirectory, uid);
}

/** Length-prefixed client for ChatGPT Desktop's local follower IPC router. */
export class DesktopIpcClient {
  private readonly endpoint: DesktopIpcEndpoint;
  private readonly platformAdapter: PlatformAdapter;
  private readonly connectTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly requestIdFactory: () => string;
  private readonly connectSocket: (address: string) => Socket;
  private readonly followingRetryDelaysMs: readonly number[];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly threadStreamListeners = new Set<ThreadStreamListener>();
  private readonly connectionLossListeners = new Set<ConnectionLossListener>();
  private readonly followedThreadIds = new Set<string>();
  private readonly confirmedFollowedThreadIds = new Set<string>();
  private readonly followingRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly threadFollowingWaiters = new Map<string, Set<ThreadFollowingWaiter>>();
  private socket: Socket | undefined;
  private startPromise: Promise<DesktopIpcHandshake> | undefined;
  private handshake: DesktopIpcHandshake | undefined;
  private readBuffer = Buffer.alloc(0);
  private currentState: DesktopIpcConnectionState = 'DISCONNECTED';
  private epoch = 0;
  private stopping = false;

  public constructor(options: DesktopIpcClientOptions = {}) {
    if (options.endpoint && options.socketPath) {
      throw new RangeError('endpoint and socketPath cannot both be configured');
    }
    this.platformAdapter = options.platformAdapter ?? createPlatformAdapter();
    this.endpoint = options.endpoint
      ?? this.platformAdapter.desktopIpcEndpoint(options.socketPath);
    this.connectTimeoutMs = positiveTimeout(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    );
    this.initializeTimeoutMs = positiveTimeout(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      'initializeTimeoutMs',
    );
    this.requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.maxFrameBytes = positiveFrameLimit(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    );
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.connectSocket = options.connectSocket ?? createConnection;
    this.followingRetryDelaysMs = Object.freeze(
      (options.followingRetryDelaysMs ?? THREAD_FOLLOWING_RETRY_DELAYS_MS)
        .map((delayMs) => positiveTimeout(delayMs, 'followingRetryDelaysMs')),
    );
    if (this.followingRetryDelaysMs.length === 0) {
      throw new RangeError('followingRetryDelaysMs must contain at least one delay');
    }
  }

  public get state(): DesktopIpcConnectionState {
    return this.currentState;
  }

  public get connectionEpoch(): number {
    return this.epoch;
  }

  public get activeSocketPath(): string {
    return this.endpoint.address;
  }

  /** Opens one connection and completes the vscode-client handshake. */
  public start(): Promise<DesktopIpcHandshake> {
    if (this.handshake && this.currentState === 'READY') {
      return Promise.resolve(this.handshake);
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.stopping = false;
    const operation = this.connectAndInitialize();
    this.startPromise = operation;
    void operation.finally(() => {
      if (this.startPromise === operation) {
        this.startPromise = undefined;
      }
    }).catch(() => undefined);
    return operation;
  }

  /** Closes the connection and rejects every pending request without retrying it. */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.currentState = 'CLOSING';
    this.clearAllThreadFollowingRecovery();
    const socket = this.socket;
    this.socket = undefined;
    this.handshake = undefined;
    this.rejectPending(
      'DESKTOP_IPC_CLIENT_STOPPED',
      (pending) => pending.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
    );
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.end();
        setImmediate(() => {
          if (!socket.destroyed) {
            socket.destroy();
          }
        });
      });
    }
    this.readBuffer = Buffer.alloc(0);
    this.currentState = 'CLOSED';
  }

  /** Subscribes to raw thread state broadcasts emitted by the Desktop owner. */
  public onThreadStreamStateChanged(listener: ThreadStreamListener): () => void {
    this.threadStreamListeners.add(listener);
    return () => this.threadStreamListeners.delete(listener);
  }

  /** Notifies lifecycle owners after an established Desktop connection closes. */
  public onConnectionLost(listener: ConnectionLossListener): () => void {
    this.connectionLossListeners.add(listener);
    return () => this.connectionLossListeners.delete(listener);
  }

  /** Registers this IPC client as a state-stream follower for one Desktop thread. */
  public async followThread(threadId: string): Promise<void> {
    const normalizedThreadId = requireThreadId(threadId);
    this.followedThreadIds.add(normalizedThreadId);
    if (this.currentState === 'READY') {
      await this.beginThreadFollowing(normalizedThreadId);
    }
  }

  /** Stops state-stream delivery for a thread while preserving other subscriptions. */
  public async unfollowThread(threadId: string): Promise<void> {
    const normalizedThreadId = requireThreadId(threadId);
    if (!this.followedThreadIds.delete(normalizedThreadId)) {
      return;
    }
    this.clearThreadFollowingRecovery(normalizedThreadId);
    if (this.currentState === 'READY') {
      await this.sendThreadFollowing(normalizedThreadId, false);
    }
  }

  /** Reconciles the desired Desktop thread subscriptions as one logical set. */
  public async syncFollowedThreads(threadIds: Iterable<string>): Promise<void> {
    const desiredThreadIds = new Set<string>();
    for (const threadId of threadIds) {
      desiredThreadIds.add(requireThreadId(threadId));
    }
    const removedThreadIds = [...this.followedThreadIds]
      .filter((threadId) => !desiredThreadIds.has(threadId));
    const addedThreadIds = [...desiredThreadIds]
      .filter((threadId) => !this.followedThreadIds.has(threadId));
    this.followedThreadIds.clear();
    for (const threadId of desiredThreadIds) {
      this.followedThreadIds.add(threadId);
    }
    for (const threadId of removedThreadIds) {
      this.clearThreadFollowingRecovery(threadId);
    }
    if (this.currentState !== 'READY') {
      return;
    }
    for (const threadId of removedThreadIds) {
      await this.sendThreadFollowing(threadId, false);
    }
    for (const threadId of addedThreadIds) {
      await this.beginThreadFollowing(threadId);
    }
  }

  /**
   * Waits until the Desktop owner confirms one followed thread with a full
   * snapshot in the current connection epoch. Patches alone are insufficient
   * because they cannot prove whether a Desktop-owned turn is still active.
   */
  public waitForThreadFollowingSnapshot(threadId: string, timeoutMs: number): Promise<boolean> {
    const normalizedThreadId = requireThreadId(threadId);
    const normalizedTimeoutMs = positiveTimeout(timeoutMs, 'timeoutMs');
    if (
      this.currentState !== 'READY'
      || !this.followedThreadIds.has(normalizedThreadId)
    ) {
      return Promise.resolve(false);
    }
    if (this.confirmedFollowedThreadIds.has(normalizedThreadId)) {
      return Promise.resolve(true);
    }
    const epoch = this.epoch;
    return new Promise<boolean>((resolve) => {
      const waiters = this.threadFollowingWaiters.get(normalizedThreadId) ?? new Set();
      const waiter: ThreadFollowingWaiter = {
        epoch,
        resolve,
        timeout: setTimeout(() => {
          this.settleThreadFollowingWaiter(normalizedThreadId, waiter, false);
        }, normalizedTimeoutMs),
      };
      waiters.add(waiter);
      this.threadFollowingWaiters.set(normalizedThreadId, waiters);
    });
  }

  /** Requests a new authoritative snapshot without changing follower ownership. */
  public requestThreadFollowingSnapshot(threadId: string): Promise<void> {
    const normalizedThreadId = requireThreadId(threadId);
    if (
      this.currentState !== 'READY'
      || !this.followedThreadIds.has(normalizedThreadId)
    ) {
      return Promise.reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_NOT_READY',
        'PROVABLY_UNSENT',
        this.epoch,
        'thread-stream-following-changed',
      ));
    }
    return this.sendThreadFollowing(normalizedThreadId, true);
  }

  /** Implements the tracked execution contract consumed by TaskOrchestrator. */
  public async requestTracked<TResult>(
    method: string,
    params: unknown,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<TResult> {
    if (method === 'turn/start') {
      const turn = await this.startTurnTracked(
        requireTurnStartParams(params, this.epoch),
        beforeSend,
        timeoutMs,
      );
      return { turn } as TResult;
    }
    if (method === 'turn/steer') {
      const turnId = await this.steerTurnTracked(
        requireTurnSteerParams(params, this.epoch),
        beforeSend,
        timeoutMs,
      );
      return { turnId } as TResult;
    }
    if (method === 'turn/interrupt') {
      await this.interruptTurnTracked(
        requireTurnInterruptParams(params, this.epoch),
        beforeSend,
        timeoutMs,
      );
      return {} as TResult;
    }
    throw new DesktopIpcRequestError(
      'DESKTOP_IPC_UNSUPPORTED_METHOD',
      'PROVABLY_UNSENT',
      this.epoch,
      method,
    );
  }

  /** Starts a turn in the Desktop-owned runtime with durable before-send tracking. */
  public async startTurnTracked(
    params: TurnStartParams,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Turn> {
    await this.followThread(params.threadId);
    const response = await this.sendRequest({
      method: 'thread-follower-start-turn',
      params: {
        conversationId: params.threadId,
        turnStartParams: params,
      },
      version: 1,
      timeoutMs: positiveTimeout(timeoutMs, 'timeoutMs'),
      beforeSend,
    });
    const turn = nestedTurn(response);
    if (!turn) {
      throw new DesktopIpcRequestError(
        'DESKTOP_IPC_INVALID_RESPONSE',
        'OUTCOME_UNKNOWN',
        this.epoch,
        'thread-follower-start-turn',
        responseRequestId(response),
      );
    }
    return turn;
  }

  /** Adds input to the active Desktop-owned turn without crossing runtimes. */
  public async steerTurnTracked(
    params: TurnSteerParams,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<string> {
    await this.sendRequest({
      method: 'thread-follower-steer-turn',
      params: {
        conversationId: params.threadId,
        expectedTurnId: params.expectedTurnId,
        clientUserMessageId: params.clientUserMessageId ?? null,
        input: params.input,
      },
      version: 1,
      timeoutMs: positiveTimeout(timeoutMs, 'timeoutMs'),
      beforeSend,
    });
    return params.expectedTurnId;
  }

  /** Interrupts the active Desktop-owned turn. */
  public async interruptTurnTracked(
    params: TurnInterruptParams,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<void> {
    await this.sendRequest({
      method: 'thread-follower-interrupt-turn',
      params: {
        conversationId: params.threadId,
        turnId: params.turnId,
      },
      version: 2,
      timeoutMs: positiveTimeout(timeoutMs, 'timeoutMs'),
      beforeSend,
    });
  }

  /**
   * Sends one approval decision back to the same live Desktop epoch. The
   * caller must never retry an outcome-unknown response on a replacement
   * connection because the owner may already have applied it.
   */
  public async respondToApproval(
    approval: DesktopApprovalResponse,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<void> {
    const method = approvalResponseMethod(approval.kind);
    const baseParams: Record<string, unknown> = {
      conversationId: approval.threadId,
      requestId: approval.requestId,
    };
    if (approval.kind === 'permissions') {
      baseParams.response = { decision: approval.decision };
    } else {
      baseParams.decision = approval.decision;
    }
    await this.sendRequest({
      method,
      params: baseParams,
      version: 1,
      timeoutMs: positiveTimeout(timeoutMs, 'timeoutMs'),
      beforeSend,
    });
  }

  private async connectAndInitialize(): Promise<DesktopIpcHandshake> {
    this.currentState = 'CONNECTING';
    try {
      await this.platformAdapter.attestDesktopIpcEndpoint(this.endpoint);
    } catch (error) {
      this.currentState = 'FAILED';
      if (error instanceof DesktopIpcEndpointError) {
        throw endpointErrorToRequestError(error, this.epoch);
      }
      throw error;
    }

    const socket = this.connectSocket(this.endpoint.address);
    this.socket = socket;
    this.epoch += 1;
    const epoch = this.epoch;
    this.attachSocket(socket, epoch);

    try {
      await waitForConnect(socket, this.connectTimeoutMs, epoch);
      if (this.stopping || this.socket !== socket) {
        throw new DesktopIpcRequestError(
          'DESKTOP_IPC_CLIENT_STOPPED',
          'PROVABLY_UNSENT',
          epoch,
        );
      }
      this.currentState = 'INITIALIZING';
      const response = await this.sendRequest({
        method: 'initialize',
        params: { clientType: 'vscode' },
        timeoutMs: this.initializeTimeoutMs,
        allowInitializing: true,
      });
      const clientId = initializeClientId(response);
      if (!clientId) {
        throw new DesktopIpcRequestError(
          'DESKTOP_IPC_INITIALIZE_FAILED',
          'PROVABLY_UNSENT',
          epoch,
          'initialize',
          responseRequestId(response),
        );
      }
      const handshake = Object.freeze({
        clientId,
        epoch,
        socketPath: this.endpoint.address,
        transport: this.endpoint.transport,
      });
      this.handshake = handshake;
      this.currentState = 'READY';
      await this.restoreThreadFollowing();
      return handshake;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.handshake = undefined;
      socket.destroy();
      this.currentState = 'FAILED';
      if (error instanceof DesktopIpcEndpointError) {
        throw endpointErrorToRequestError(error, epoch);
      }
      if (error instanceof DesktopIpcRequestError) {
        if (error.method === 'initialize') {
          throw new DesktopIpcRequestError(
            'DESKTOP_IPC_INITIALIZE_FAILED',
            'PROVABLY_UNSENT',
            epoch,
            'initialize',
            error.requestId,
            { cause: error },
          );
        }
        throw error;
      }
      throw new DesktopIpcRequestError(
        'DESKTOP_IPC_CONNECT_FAILED',
        'PROVABLY_UNSENT',
        epoch,
        null,
        null,
        { cause: error },
      );
    }
  }

  private attachSocket(socket: Socket, epoch: number): void {
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket && this.epoch === epoch) {
        this.consumeData(chunk, epoch);
      }
    });
    socket.on('error', () => {
      // The close handler owns state convergence and pending-request rejection.
    });
    socket.on('close', () => {
      if (this.socket !== socket || this.epoch !== epoch) {
        return;
      }
      this.socket = undefined;
      this.handshake = undefined;
      this.readBuffer = Buffer.alloc(0);
      this.clearAllThreadFollowingRecovery();
      this.rejectPending(
        'DESKTOP_IPC_CONNECTION_LOST',
        (pending) => pending.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
        epoch,
      );
      if (!this.stopping) {
        this.currentState = 'DISCONNECTED';
        for (const listener of this.connectionLossListeners) {
          listener(epoch);
        }
      }
    });
  }

  private consumeData(chunk: Buffer, epoch: number): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 4) {
      const frameLength = this.readBuffer.readUInt32LE(0);
      if (frameLength === 0 || frameLength > this.maxFrameBytes) {
        this.failProtocol(epoch);
        return;
      }
      if (this.readBuffer.length < 4 + frameLength) {
        return;
      }
      const payload = this.readBuffer.subarray(4, 4 + frameLength);
      this.readBuffer = this.readBuffer.subarray(4 + frameLength);
      let message: unknown;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        this.failProtocol(epoch);
        return;
      }
      this.handleMessage(message, epoch);
    }
  }

  private handleMessage(message: unknown, epoch: number): void {
    const record = asRecord(message);
    if (!record) {
      return;
    }
    if (isThreadStreamBroadcastEnvelope(record)) {
      if (
        record.version !== DESKTOP_THREAD_STREAM_PROTOCOL_VERSION
        || !isThreadStreamBroadcast(record)
      ) {
        this.failProtocol(epoch);
        return;
      }
      try {
        for (const listener of this.threadStreamListeners) {
          listener(record, epoch);
        }
      } catch {
        this.failProtocol(epoch);
        return;
      }
      if (record.params.change.type === 'snapshot') {
        this.confirmThreadFollowing(record.params.conversationId);
      }
      return;
    }
    if (record.type !== 'response' || typeof record.requestId !== 'string') {
      return;
    }
    const pending = this.pendingRequests.get(record.requestId);
    if (!pending || pending.epoch !== epoch) {
      return;
    }
    this.pendingRequests.delete(record.requestId);
    clearTimeout(pending.timeout);
    if (record.resultType !== 'success') {
      const remoteError = recognizedRemoteError(record.error);
      pending.reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_REMOTE_REJECTED',
        remoteErrorDisposition(record.error),
        epoch,
        pending.method,
        pending.requestId,
        undefined,
        remoteError,
      ));
      return;
    }
    if (record.method !== pending.method) {
      pending.reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_INVALID_RESPONSE',
        pending.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
        epoch,
        pending.method,
        pending.requestId,
      ));
      return;
    }
    pending.resolve(record);
  }

  private sendRequest(options: SendRequestOptions): Promise<WireRecord> {
    const socket = this.socket;
    const ready = this.currentState === 'READY'
      || (options.allowInitializing && this.currentState === 'INITIALIZING');
    if (!socket || socket.destroyed || !ready) {
      return Promise.reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_NOT_READY',
        'PROVABLY_UNSENT',
        this.epoch,
        options.method,
      ));
    }
    const requestId = this.requestIdFactory();
    const epoch = this.epoch;
    return new Promise<WireRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending || pending.epoch !== epoch) {
          return;
        }
        this.pendingRequests.delete(requestId);
        pending.reject(new DesktopIpcRequestError(
          'DESKTOP_IPC_REQUEST_TIMEOUT',
          pending.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
          epoch,
          options.method,
          requestId,
        ));
      }, options.timeoutMs);
      let sent = false;
      const pending: PendingRequest = {
        epoch,
        method: options.method,
        requestId,
        get sent() {
          return sent;
        },
        resolve,
        reject,
        timeout,
      };
      this.pendingRequests.set(requestId, pending);
      try {
        options.beforeSend?.({ id: requestId, epoch });
        sent = true;
        const envelope: Record<string, unknown> = {
          type: 'request',
          requestId,
          ...(this.handshake ? { sourceClientId: this.handshake.clientId } : {}),
          ...(options.version === undefined ? {} : { version: options.version }),
          method: options.method,
          params: options.params,
          ...(options.version === undefined ? {} : { timeoutMs: options.timeoutMs }),
        };
        socket.write(encodeFrame(envelope), (error) => {
          if (!error) {
            return;
          }
          const current = this.pendingRequests.get(requestId);
          if (!current || current.epoch !== epoch) {
            return;
          }
          this.pendingRequests.delete(requestId);
          clearTimeout(current.timeout);
          current.reject(new DesktopIpcRequestError(
            'DESKTOP_IPC_CONNECTION_LOST',
            current.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
            epoch,
            options.method,
            requestId,
            { cause: error },
          ));
        });
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(error instanceof DesktopIpcRequestError
          ? error
          : new DesktopIpcRequestError(
              'DESKTOP_IPC_NOT_READY',
              sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
              epoch,
              options.method,
              requestId,
              { cause: error },
            ));
      }
    });
  }

  private async restoreThreadFollowing(): Promise<void> {
    this.clearAllThreadFollowingRecovery();
    for (const threadId of this.followedThreadIds) {
      await this.beginThreadFollowing(threadId);
    }
  }

  private async beginThreadFollowing(threadId: string): Promise<void> {
    this.clearThreadFollowingRecovery(threadId);
    const epoch = this.epoch;
    await this.sendThreadFollowing(threadId, true);
    this.scheduleThreadFollowingRetry(threadId, 0, epoch);
  }

  private scheduleThreadFollowingRetry(
    threadId: string,
    retryIndex: number,
    epoch: number,
  ): void {
    if (
      this.epoch !== epoch
      || !this.followedThreadIds.has(threadId)
      || this.confirmedFollowedThreadIds.has(threadId)
      || this.currentState !== 'READY'
      || this.followingRetryTimers.has(threadId)
    ) {
      return;
    }
    const delayIndex = Math.min(retryIndex, this.followingRetryDelaysMs.length - 1);
    const delayMs = this.followingRetryDelaysMs[delayIndex]!;
    const timer = setTimeout(() => {
      if (this.followingRetryTimers.get(threadId) !== timer) {
        return;
      }
      this.followingRetryTimers.delete(threadId);
      void this.retryThreadFollowing(threadId, retryIndex + 1, epoch);
    }, delayMs);
    timer.unref();
    this.followingRetryTimers.set(threadId, timer);
  }

  private async retryThreadFollowing(
    threadId: string,
    nextRetryIndex: number,
    epoch: number,
  ): Promise<void> {
    if (
      this.epoch !== epoch
      || !this.followedThreadIds.has(threadId)
      || this.confirmedFollowedThreadIds.has(threadId)
      || this.currentState !== 'READY'
    ) {
      return;
    }
    try {
      await this.sendThreadFollowing(threadId, true);
    } catch (error) {
      if (this.epoch === epoch && this.currentState === 'READY') {
        this.socket?.destroy(error instanceof Error ? error : undefined);
      }
      return;
    }
    this.scheduleThreadFollowingRetry(threadId, nextRetryIndex, epoch);
  }

  private confirmThreadFollowing(threadId: string): void {
    if (!this.followedThreadIds.has(threadId)) {
      return;
    }
    this.confirmedFollowedThreadIds.add(threadId);
    const timer = this.followingRetryTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.followingRetryTimers.delete(threadId);
    }
    this.settleThreadFollowingWaiters(threadId, this.epoch, true);
  }

  private clearThreadFollowingRecovery(threadId: string): void {
    this.confirmedFollowedThreadIds.delete(threadId);
    const timer = this.followingRetryTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.followingRetryTimers.delete(threadId);
    }
    this.settleThreadFollowingWaiters(threadId, undefined, false);
  }

  private clearAllThreadFollowingRecovery(): void {
    this.confirmedFollowedThreadIds.clear();
    for (const timer of this.followingRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.followingRetryTimers.clear();
    for (const threadId of this.threadFollowingWaiters.keys()) {
      this.settleThreadFollowingWaiters(threadId, undefined, false);
    }
  }

  private settleThreadFollowingWaiters(
    threadId: string,
    epoch: number | undefined,
    available: boolean,
  ): void {
    const waiters = this.threadFollowingWaiters.get(threadId);
    if (!waiters) {
      return;
    }
    for (const waiter of [...waiters]) {
      if (epoch !== undefined && waiter.epoch !== epoch) {
        continue;
      }
      this.settleThreadFollowingWaiter(threadId, waiter, available);
    }
  }

  private settleThreadFollowingWaiter(
    threadId: string,
    waiter: ThreadFollowingWaiter,
    available: boolean,
  ): void {
    const waiters = this.threadFollowingWaiters.get(threadId);
    if (!waiters?.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timeout);
    if (waiters.size === 0) {
      this.threadFollowingWaiters.delete(threadId);
    }
    waiter.resolve(available);
  }

  private sendThreadFollowing(threadId: string, following: boolean): Promise<void> {
    const socket = this.socket;
    if (
      !socket
      || socket.destroyed
      || this.currentState !== 'READY'
      || !this.handshake
    ) {
      return Promise.reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_NOT_READY',
        'PROVABLY_UNSENT',
        this.epoch,
        'thread-stream-following-changed',
      ));
    }
    const epoch = this.epoch;
    const envelope: Record<string, unknown> = {
      type: 'broadcast',
      sourceClientId: this.handshake.clientId,
      version: DESKTOP_THREAD_FOLLOWING_PROTOCOL_VERSION,
      method: 'thread-stream-following-changed',
      params: {
        conversationId: threadId,
        hostId: DESKTOP_HOST_ID,
        following,
      },
    };
    return new Promise<void>((resolve, reject) => {
      socket.write(encodeFrame(envelope), (error) => {
        if (!error) {
          resolve();
          return;
        }
        reject(new DesktopIpcRequestError(
          'DESKTOP_IPC_CONNECTION_LOST',
          'OUTCOME_UNKNOWN',
          epoch,
          'thread-stream-following-changed',
          null,
          { cause: error },
        ));
      });
    });
  }

  private failProtocol(epoch: number): void {
    this.rejectPending(
      'DESKTOP_IPC_PROTOCOL_ERROR',
      (pending) => pending.sent ? 'OUTCOME_UNKNOWN' : 'PROVABLY_UNSENT',
      epoch,
    );
    this.socket?.destroy();
    this.currentState = 'FAILED';
  }

  private rejectPending(
    code: DesktopIpcErrorCode,
    disposition: (pending: PendingRequest) => DesktopIpcDeliveryDisposition,
    epoch = this.epoch,
  ): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.epoch !== epoch) {
        continue;
      }
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new DesktopIpcRequestError(
        code,
        disposition(pending),
        epoch,
        pending.method,
        pending.requestId,
      ));
    }
  }
}

function endpointErrorToRequestError(
  error: DesktopIpcEndpointError,
  epoch: number,
): DesktopIpcRequestError {
  const code = error.code === 'DESKTOP_IPC_INVALID_ENDPOINT'
    ? 'DESKTOP_IPC_INVALID_SOCKET'
    : error.code === 'DESKTOP_IPC_UNAVAILABLE'
      ? 'DESKTOP_IPC_SOCKET_NOT_FOUND'
      : 'DESKTOP_IPC_CONNECT_FAILED';
  return new DesktopIpcRequestError(
    code,
    'PROVABLY_UNSENT',
    epoch,
    null,
    null,
    { cause: error },
  );
}

function waitForConnect(socket: Socket, timeoutMs: number, epoch: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_CONNECT_TIMEOUT',
        'PROVABLY_UNSENT',
        epoch,
      ));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new DesktopIpcRequestError(
        'DESKTOP_IPC_CONNECT_FAILED',
        'PROVABLY_UNSENT',
        epoch,
        null,
        null,
        { cause: error },
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function encodeFrame(message: WireRecord): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveFrameLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_FRAME_BYTES) {
    throw new RangeError(`maxFrameBytes must be between 1 and ${DEFAULT_MAX_FRAME_BYTES}`);
  }
  return value;
}

function asRecord(value: unknown): WireRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as WireRecord;
}

function responseRequestId(response: WireRecord): string | null {
  return typeof response.requestId === 'string' ? response.requestId : null;
}

function initializeClientId(response: WireRecord): string | null {
  const result = asRecord(response.result);
  return result && typeof result.clientId === 'string' && result.clientId
    ? result.clientId
    : null;
}

function requireTurnStartParams(value: unknown, epoch: number): TurnStartParams {
  const record = requireTurnParamsRecord(value, epoch, 'turn/start');
  if (!Array.isArray(record.input)) {
    throw invalidTrackedParams(epoch, 'turn/start');
  }
  return value as TurnStartParams;
}

function requireTurnSteerParams(value: unknown, epoch: number): TurnSteerParams {
  const record = requireTurnParamsRecord(value, epoch, 'turn/steer');
  if (!Array.isArray(record.input) || typeof record.expectedTurnId !== 'string') {
    throw invalidTrackedParams(epoch, 'turn/steer');
  }
  return value as TurnSteerParams;
}

function requireTurnInterruptParams(value: unknown, epoch: number): TurnInterruptParams {
  const record = requireTurnParamsRecord(value, epoch, 'turn/interrupt');
  if (typeof record.turnId !== 'string' || !record.turnId) {
    throw invalidTrackedParams(epoch, 'turn/interrupt');
  }
  return value as TurnInterruptParams;
}

function requireTurnParamsRecord(
  value: unknown,
  epoch: number,
  method: string,
): WireRecord {
  const record = asRecord(value);
  if (!record || typeof record.threadId !== 'string' || !record.threadId) {
    throw invalidTrackedParams(epoch, method);
  }
  return record;
}

function requireThreadId(value: string): string {
  const threadId = value.trim();
  if (!threadId) {
    throw new RangeError('Desktop thread ID must not be blank');
  }
  return threadId;
}

function invalidTrackedParams(epoch: number, method: string): DesktopIpcRequestError {
  return new DesktopIpcRequestError(
    'DESKTOP_IPC_PROTOCOL_ERROR',
    'PROVABLY_UNSENT',
    epoch,
    method,
  );
}

function nestedTurn(response: WireRecord): Turn | null {
  const outerResult = asRecord(response.result);
  const innerResult = asRecord(outerResult?.result);
  const turn = asRecord(innerResult?.turn);
  if (!turn || typeof turn.id !== 'string' || !turn.id || typeof turn.status !== 'string') {
    return null;
  }
  return turn as unknown as Turn;
}

function isThreadStreamBroadcast(record: WireRecord): record is DesktopThreadStreamBroadcast {
  if (
    record.type !== 'broadcast'
    || record.method !== 'thread-stream-state-changed'
    || typeof record.version !== 'number'
  ) {
    return false;
  }
  const params = asRecord(record.params);
  const change = asRecord(params?.change);
  return Boolean(
    params
    && typeof params.conversationId === 'string'
    && change
    && (change.type === 'snapshot' || change.type === 'patches'),
  );
}

function isThreadStreamBroadcastEnvelope(record: WireRecord): record is WireRecord & {
  readonly version?: unknown;
} {
  return record.type === 'broadcast'
    && record.method === 'thread-stream-state-changed';
}

function recognizedRemoteError(error: unknown): 'no-client-found' | null {
  return error === 'no-client-found' ? error : null;
}

function remoteErrorDisposition(error: unknown): DesktopIpcDeliveryDisposition {
  if (error === 'no-client-found') {
    return 'PROVABLY_UNSENT';
  }
  if (
    error === 'client-disconnected'
    || error === 'request-timeout'
    || error === 'server-closed'
  ) {
    return 'OUTCOME_UNKNOWN';
  }
  return 'DEFINITIVE_FAILURE';
}
