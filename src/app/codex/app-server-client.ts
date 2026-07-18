import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type {
  InitializeParams,
  InitializeResponse,
  RequestId,
  RpcError,
  RpcNotification,
  RpcRequest,
  ServerNotification,
  ServerRequest,
} from './protocol';
import { buildCodexEnvironment } from './environment';
import {
  parseAppServerUserAgentVersion,
  type AppServerProtocolProfile,
} from './app-server-protocol-registry';

export type AppServerConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'INITIALIZING'
  | 'READY'
  | 'CLOSED'
  | 'FAILED';

interface BaseTransportOptions {
  codexBin: string;
  env?: NodeJS.ProcessEnv;
  spawnCwd?: string;
}

export interface OwnedStdioTransportOptions extends BaseTransportOptions {
  mode: 'owned_stdio';
  appServerArgs?: string[];
}

export interface ManagedProxyTransportOptions extends BaseTransportOptions {
  mode: 'managed_proxy';
  socketPath?: string;
  proxyArgs?: string[];
}

export type AppServerTransportOptions =
  | OwnedStdioTransportOptions
  | ManagedProxyTransportOptions;

export interface AppServerChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type AppServerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => AppServerChildProcess;

export interface AppServerClientOptions {
  transport: AppServerTransportOptions;
  protocolProfile: AppServerProtocolProfile;
  clientInfo?: InitializeParams['clientInfo'];
  initializeCapabilities?: NonNullable<InitializeParams['capabilities']>;
  requestTimeoutMs?: number;
  terminationGraceMs?: number;
  maxLineBytes?: number;
  spawnProcess?: AppServerSpawn;
}

export type AppServerIdentityAssurance =
  | 'owned_binary_exact_profile'
  | 'operator_trusted_managed_proxy';

export interface TrackedRequestIdentity {
  id: RequestId;
  epoch: number;
}

export type BeforeTrackedRequestSend = (identity: TrackedRequestIdentity) => void;

export interface AppServerProtocolDiagnostic {
  epoch: number;
  reason:
    | 'invalid_json'
    | 'invalid_envelope'
    | 'invalid_response'
    | 'unknown_response'
    | 'line_too_large';
}

export type AppServerClientEvent =
  | { type: 'state'; state: AppServerConnectionState; epoch: number }
  | { type: 'notification'; notification: ServerNotification; epoch: number }
  | { type: 'serverRequest'; request: ServerRequest; epoch: number }
  | { type: 'protocolError'; diagnostic: AppServerProtocolDiagnostic }
  | { type: 'stderr'; text: string; epoch: number }
  | {
      type: 'exit';
      code: number | null;
      signal: NodeJS.Signals | null;
      epoch: number;
    };

type EventListener = (event: AppServerClientEvent) => void;
type NotificationListener = (notification: ServerNotification, epoch: number) => void;
type ServerRequestListener = (request: ServerRequest, epoch: number) => void;

interface PendingRequest {
  epoch: number;
  method: string;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface ReaderContext {
  epoch: number;
  child: AppServerChildProcess;
  buffer: string;
  decoder: StringDecoder;
  discardingOversizedLine: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Error returned by an App Server JSON-RPC error response. */
export class AppServerRpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, rpcError: RpcError) {
    super('App Server RPC request failed');
    this.name = 'AppServerRpcError';
    this.code = rpcError.code;
    this.method = method;
  }
}

/**
 * Describes what an initialize identity can prove for the configured mode.
 *
 * An owned process is the same configured binary whose complete schema was
 * hashed during preflight. A managed proxy can only corroborate its reported
 * version; the operator is responsible for pinning that daemon to the selected
 * profile. The bridge never invents a remote schema digest.
 */
export function appServerIdentityAssurance(
  mode: AppServerTransportOptions['mode'],
): AppServerIdentityAssurance {
  return mode === 'owned_stdio'
    ? 'owned_binary_exact_profile'
    : 'operator_trusted_managed_proxy';
}

/** Error returned when the active child connection cannot complete an operation. */
export class AppServerConnectionError extends Error {
  readonly epoch: number;

  constructor(message: string, epoch: number) {
    super(message);
    this.name = 'AppServerConnectionError';
    this.epoch = epoch;
  }
}

/** Error returned when a business RPC is attempted before the handshake is ready. */
export class AppServerNotReadyError extends Error {
  constructor(state: AppServerConnectionState) {
    super(`App Server is not ready; current state is ${state}`);
    this.name = 'AppServerNotReadyError';
  }
}

/**
 * Owns a Codex App Server JSON-lines child transport and its initialize handshake.
 */
export class AppServerClient {
  private readonly options: Required<
    Pick<AppServerClientOptions, 'requestTimeoutMs' | 'terminationGraceMs' | 'maxLineBytes'>
  > &
    Omit<AppServerClientOptions, 'requestTimeoutMs' | 'terminationGraceMs' | 'maxLineBytes'>;
  private readonly spawnProcess: AppServerSpawn;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly exitedChildren = new WeakSet<AppServerChildProcess>();
  private readonly childTerminations = new WeakMap<AppServerChildProcess, Promise<void>>();
  private child: AppServerChildProcess | undefined;
  private startPromise: Promise<InitializeResponse> | undefined;
  private terminationBarrier: Promise<void> | undefined;
  private nextRequestId = 1;
  private epoch = 0;
  private lifecycleGeneration = 0;
  private currentState: AppServerConnectionState = 'DISCONNECTED';

  constructor(options: AppServerClientOptions) {
    if (
      options.terminationGraceMs !== undefined
      && (!Number.isFinite(options.terminationGraceMs) || options.terminationGraceMs <= 0)
    ) {
      throw new Error('App Server termination grace period must be a positive finite number');
    }
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      terminationGraceMs: options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    };
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
  }

  /** Current connection lifecycle state. */
  get state(): AppServerConnectionState {
    return this.currentState;
  }

  /** Monotonically increasing child connection generation. */
  get connectionEpoch(): number {
    return this.epoch;
  }

  /**
   * Spawn the configured child, complete `initialize -> initialized`, and enter READY.
   */
  async start(): Promise<InitializeResponse> {
    if (this.currentState === 'READY') {
      throw new Error('App Server client is already started');
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const promise = this.startConnection(this.lifecycleGeneration);
    this.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) {
        this.startPromise = undefined;
      }
    }
  }

  /**
   * Send a business RPC. Requests are rejected until the initialize handshake is READY.
   */
  request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult> {
    if (this.currentState !== 'READY' || !this.child) {
      return Promise.reject(new AppServerNotReadyError(this.currentState));
    }
    return this.requestOnConnection<TResult>(
      method,
      params,
      timeoutMs ?? this.options.requestTimeoutMs,
      this.epoch,
    );
  }

  /**
   * Send a business RPC after synchronously persisting its assigned request identity.
   * The callback runs after allocating the real id/epoch and before any transport write.
   */
  requestTracked<TResult>(
    method: string,
    params: unknown,
    beforeSend: BeforeTrackedRequestSend,
    timeoutMs?: number,
  ): Promise<TResult> {
    if (this.currentState !== 'READY' || !this.child) {
      return Promise.reject(new AppServerNotReadyError(this.currentState));
    }
    return this.requestOnConnection<TResult>(
      method,
      params,
      timeoutMs ?? this.options.requestTimeoutMs,
      this.epoch,
      beforeSend,
    );
  }

  /**
   * Respond to a server-initiated request on the active connection.
   * Passing the request epoch prevents an approval from being answered on a newer connection.
   */
  async respond(id: RequestId, result: unknown, expectedEpoch = this.epoch): Promise<void> {
    this.assertReadyEpoch(expectedEpoch);
    await this.writeMessage({ id, result }, expectedEpoch);
  }

  /** Respond to a server-initiated request with a JSON-RPC error. */
  async respondError(
    id: RequestId,
    error: RpcError,
    expectedEpoch = this.epoch,
  ): Promise<void> {
    this.assertReadyEpoch(expectedEpoch);
    await this.writeMessage({ id, error }, expectedEpoch);
  }

  /**
   * Close the owned child or proxy command and reject all requests for its epoch.
   */
  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    const child = this.child;
    const stoppedEpoch = this.epoch;
    this.child = undefined;

    this.rejectPendingForEpoch(
      stoppedEpoch,
      new AppServerConnectionError('App Server client stopped', stoppedEpoch),
    );
    this.transition('CLOSED');

    if (!child) {
      await this.terminationBarrier;
      return;
    }

    await this.terminateChild(child, true);
  }

  /** Subscribe to all lifecycle and transport events. */
  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribe to App Server notifications. */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Subscribe to server-initiated requests, including command/file approvals. */
  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  private async startConnection(lifecycleGeneration: number): Promise<InitializeResponse> {
    const priorTermination = this.terminationBarrier;
    if (priorTermination) {
      await priorTermination;
    }
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      throw new AppServerConnectionError(
        'App Server start was cancelled by stop',
        this.epoch,
      );
    }
    const epoch = this.epoch + 1;
    this.epoch = epoch;
    this.transition('CONNECTING');

    let child: AppServerChildProcess;
    try {
      const invocation = buildInvocation(this.options.transport);
      child = this.spawnProcess(invocation.command, invocation.args, {
        cwd: this.options.transport.spawnCwd,
        env: { ...buildCodexEnvironment(this.options.transport.env ?? process.env) },
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.transition('FAILED');
      throw toConnectionError(error, 'Failed to spawn App Server', epoch);
    }

    this.child = child;
    this.attachChild(child, epoch);
    this.transition('INITIALIZING');

    try {
      const initializeResult = await this.requestOnConnection<InitializeResponse>(
        'initialize',
        this.buildInitializeParams(),
        this.options.requestTimeoutMs,
        epoch,
      );
      this.validateInitializeResult(initializeResult, epoch);
      await this.writeMessage({ method: 'initialized' }, epoch);
      if (!this.isCurrentConnection(child, epoch)) {
        throw new AppServerConnectionError(
          'App Server connection changed during initialization',
          epoch,
        );
      }
      this.transition('READY');
      return initializeResult;
    } catch (error) {
      if (this.isCurrentConnection(child, epoch)) {
        this.child = undefined;
        this.rejectPendingForEpoch(epoch, toError(error));
        const termination = this.terminateChild(child, true);
        this.transition('FAILED');
        await termination;
      }
      throw error;
    }
  }

  private buildInitializeParams(): InitializeParams {
    return {
      clientInfo: this.options.clientInfo ?? {
        name: 'lark_codex_gateway',
        title: 'Lark Codex Gateway',
        version: '0.1.0',
      },
      capabilities: this.options.initializeCapabilities ?? {
        experimentalApi: true,
        requestAttestation: false,
      },
    };
  }

  private validateInitializeResult(result: InitializeResponse, epoch: number): void {
    if (
      !isRecord(result)
      || typeof result.userAgent !== 'string'
      || typeof result.codexHome !== 'string'
      || typeof result.platformFamily !== 'string'
      || typeof result.platformOs !== 'string'
    ) {
      throw new AppServerConnectionError('App Server initialize response is invalid', epoch);
    }
    let actualVersion: string;
    try {
      actualVersion = parseAppServerUserAgentVersion(result.userAgent).version;
    } catch {
      throw new AppServerConnectionError('App Server runtime identity is unsupported', epoch);
    }
    if (actualVersion !== this.options.protocolProfile.codexVersion) {
      throw new AppServerConnectionError('App Server runtime version is unsupported', epoch);
    }
  }

  private attachChild(child: AppServerChildProcess, epoch: number): void {
    const reader: ReaderContext = {
      epoch,
      child,
      buffer: '',
      decoder: new StringDecoder('utf8'),
      discardingOversizedLine: false,
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(reader, chunk);
    });
    child.stdout.on('error', (error: Error) => {
      this.failCurrentConnection(child, epoch, toConnectionError(error, 'App Server stdout failed', epoch));
    });
    child.stdin.on('error', (error: Error) => {
      this.failCurrentConnection(child, epoch, toConnectionError(error, 'App Server stdin failed', epoch));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (!this.isCurrentConnection(child, epoch)) {
        return;
      }
      this.publish({ type: 'stderr', text: summarizeStderr(chunk), epoch });
    });
    child.on('error', (error) => {
      this.failCurrentConnection(child, epoch, toConnectionError(error, 'App Server child failed', epoch));
    });
    child.on('exit', (code, signal) => {
      this.exitedChildren.add(child);
      if (!this.isCurrentConnection(child, epoch)) {
        return;
      }
      this.publish({ type: 'exit', code, signal, epoch });
      this.failCurrentConnection(
        child,
        epoch,
        new AppServerConnectionError(
          `App Server exited (code=${String(code)}, signal=${String(signal)})`,
          epoch,
        ),
      );
    });
    child.on('close', (code, signal) => {
      this.exitedChildren.add(child);
      if (!this.isCurrentConnection(child, epoch)) {
        return;
      }
      this.publish({ type: 'exit', code, signal, epoch });
      this.failCurrentConnection(
        child,
        epoch,
        new AppServerConnectionError(
          `App Server closed (code=${String(code)}, signal=${String(signal)})`,
          epoch,
        ),
      );
    });
  }

  private consumeStdout(reader: ReaderContext, chunk: Buffer | string): void {
    if (!this.isCurrentConnection(reader.child, reader.epoch)) {
      return;
    }

    reader.buffer += typeof chunk === 'string' ? chunk : reader.decoder.write(chunk);
    let newlineIndex = reader.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      if (!this.isCurrentConnection(reader.child, reader.epoch)) {
        return;
      }
      const line = reader.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      reader.buffer = reader.buffer.slice(newlineIndex + 1);

      if (reader.discardingOversizedLine) {
        reader.discardingOversizedLine = false;
      } else if (Buffer.byteLength(line, 'utf8') > this.options.maxLineBytes) {
        this.protocolError(reader.epoch, 'line_too_large');
      } else if (line.trim().length > 0) {
        this.routeLine(line, reader.epoch);
      }
      newlineIndex = reader.buffer.indexOf('\n');
    }

    if (!this.isCurrentConnection(reader.child, reader.epoch)) {
      return;
    }
    if (Buffer.byteLength(reader.buffer, 'utf8') > this.options.maxLineBytes) {
      reader.buffer = '';
      reader.discardingOversizedLine = true;
      this.protocolError(reader.epoch, 'line_too_large');
    }
  }

  private routeLine(line: string, epoch: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolError(epoch, 'invalid_json');
      return;
    }

    if (!isRecord(parsed)) {
      this.protocolError(epoch, 'invalid_envelope');
      return;
    }

    const hasId = hasOwn(parsed, 'id');
    const hasMethod = hasOwn(parsed, 'method');
    if (hasId && !hasMethod) {
      this.routeResponse(parsed, epoch);
      return;
    }
    if (hasId && hasMethod && isRequestId(parsed.id) && typeof parsed.method === 'string') {
      this.publishServerRequest(parsed as unknown as ServerRequest, epoch);
      return;
    }
    if (!hasId && hasMethod && typeof parsed.method === 'string') {
      this.publishNotification(parsed as unknown as RpcNotification, epoch);
      return;
    }
    this.protocolError(epoch, 'invalid_envelope');
  }

  private routeResponse(message: Record<string, unknown>, epoch: number): void {
    if (!isRequestId(message.id)) {
      this.protocolError(epoch, 'invalid_response');
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending || pending.epoch !== epoch) {
      this.protocolError(epoch, 'unknown_response');
      return;
    }

    const hasResult = hasOwn(message, 'result');
    const hasError = hasOwn(message, 'error');
    if (hasResult === hasError) {
      this.protocolError(epoch, 'invalid_response');
      return;
    }

    if (hasError) {
      const rpcError = parseRpcError(message.error);
      if (!rpcError) {
        this.protocolError(epoch, 'invalid_response');
        return;
      }
      this.settlePending(message.id, pending, new AppServerRpcError(pending.method, rpcError));
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
  }

  private requestOnConnection<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    epoch: number,
    beforeSend?: BeforeTrackedRequestSend,
  ): Promise<TResult> {
    if (!this.child || this.epoch !== epoch) {
      return Promise.reject(
        new AppServerConnectionError('App Server connection is not active', epoch),
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('RPC timeout must be a positive finite number'));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request: RpcRequest = { id, method };
    if (params !== undefined) {
      request.params = params;
    }

    if (beforeSend) {
      try {
        const callbackResult: unknown = beforeSend({ id, epoch });
        if (isPromiseLike(callbackResult)) {
          void Promise.resolve(callbackResult).catch(() => undefined);
          return Promise.reject(new TypeError('beforeSend must complete synchronously'));
        }
      } catch (error) {
        return Promise.reject(toError(error));
      }
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (!current || current.epoch !== epoch) {
          return;
        }
        this.pending.delete(id);
        reject(new Error('App Server RPC request timed out'));
      }, timeoutMs);

      const pending: PendingRequest = {
        epoch,
        method,
        timer,
        resolve: (result) => resolve(result as TResult),
        reject,
      };
      this.pending.set(id, pending);

      this.writeMessage(request, epoch).catch((error) => {
        const current = this.pending.get(id);
        if (current === pending) {
          this.settlePending(id, pending, toError(error));
        }
      });
    });
  }

  private writeMessage(message: object, epoch: number): Promise<void> {
    const child = this.child;
    if (!child || this.epoch !== epoch) {
      return Promise.reject(
        new AppServerConnectionError('Cannot write to a stale App Server connection', epoch),
      );
    }

    const line = `${JSON.stringify(message)}\n`;
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(line, (error?: Error | null) => {
          if (error) {
            const connectionError = toConnectionError(
              error,
              'Failed to write to App Server',
              epoch,
            );
            this.failCurrentConnection(child, epoch, connectionError);
            reject(connectionError);
            return;
          }
          resolve();
        });
      } catch (error) {
        const connectionError = toConnectionError(
          error,
          'Failed to write to App Server',
          epoch,
        );
        this.failCurrentConnection(child, epoch, connectionError);
        reject(connectionError);
      }
    });
  }

  private assertReadyEpoch(expectedEpoch: number): void {
    if (
      this.currentState !== 'READY' ||
      !this.child ||
      expectedEpoch !== this.epoch
    ) {
      throw new AppServerNotReadyError(this.currentState);
    }
  }

  private failCurrentConnection(
    child: AppServerChildProcess,
    epoch: number,
    error: Error,
  ): void {
    if (!this.isCurrentConnection(child, epoch)) {
      return;
    }
    this.child = undefined;
    this.rejectPendingForEpoch(epoch, error);
    const termination = this.terminateChild(child, true);
    this.transition('FAILED');
    // Transport callbacks cannot await process shutdown. Consume only this
    // detached branch; callers awaiting the original barrier still receive a
    // bounded termination failure.
    void termination.catch(() => undefined);
  }

  private terminateChild(child: AppServerChildProcess, closeStdin: boolean): Promise<void> {
    const existing = this.childTerminations.get(child);
    if (existing) {
      return existing;
    }
    const termination = this.performChildTermination(child, closeStdin);
    this.childTerminations.set(child, termination);
    this.terminationBarrier = termination;
    const clearBarrierAfterTermination = (): void => {
      if (this.terminationBarrier === termination) {
        this.terminationBarrier = undefined;
      }
    };
    // A rejected termination has not proven the old child is gone. Keep that
    // settled rejection as a fail-closed gate so later starts fail immediately
    // instead of spawning a second App Server process. The rejection handler
    // consumes only this detached branch; awaiters still receive the error.
    void termination.then(clearBarrierAfterTermination, () => undefined);
    return termination;
  }

  private async performChildTermination(
    child: AppServerChildProcess,
    closeStdin: boolean,
  ): Promise<void> {
    if (this.exitedChildren.has(child)) {
      return;
    }
    const terminationPromise = new Promise<void>((resolve) => {
      const terminated = (): void => {
        this.exitedChildren.add(child);
        resolve();
      };
      child.on('exit', terminated);
      child.on('close', terminated);
    });
    if (closeStdin) {
      try {
        child.stdin.end();
      } catch {
        // The process may already have closed stdin.
      }
    }
    const termSent = safelyKill(child, 'SIGTERM');
    if (
      termSent
      && await resolvesWithin(terminationPromise, this.options.terminationGraceMs)
    ) {
      return;
    }
    safelyKill(child, 'SIGKILL');
    if (await resolvesWithin(terminationPromise, this.options.terminationGraceMs)) {
      return;
    }
    throw new AppServerConnectionError(
      'App Server child did not terminate after SIGKILL',
      this.epoch,
    );
  }

  private rejectPendingForEpoch(epoch: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== epoch) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private settlePending(id: RequestId, pending: PendingRequest, error: Error): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private publishNotification(notification: ServerNotification, epoch: number): void {
    for (const listener of this.notificationListeners) {
      safeCall(() => listener(notification, epoch));
    }
    this.publish({ type: 'notification', notification, epoch });
  }

  private publishServerRequest(request: ServerRequest, epoch: number): void {
    for (const listener of this.serverRequestListeners) {
      safeCall(() => listener(request, epoch));
    }
    this.publish({ type: 'serverRequest', request, epoch });
  }

  private protocolError(
    epoch: number,
    reason: AppServerProtocolDiagnostic['reason'],
  ): void {
    this.publish({ type: 'protocolError', diagnostic: { epoch, reason } });
    if (reason === 'unknown_response') {
      return;
    }

    const child = this.child;
    if (!child || this.epoch !== epoch) {
      return;
    }
    this.failCurrentConnection(
      child,
      epoch,
      new AppServerConnectionError(`App Server protocol error: ${reason}`, epoch),
    );
  }

  private transition(state: AppServerConnectionState): void {
    this.currentState = state;
    this.publish({ type: 'state', state, epoch: this.epoch });
  }

  private publish(event: AppServerClientEvent): void {
    for (const listener of this.eventListeners) {
      safeCall(() => listener(event));
    }
  }

  private isCurrentConnection(child: AppServerChildProcess, epoch: number): boolean {
    return this.child === child && this.epoch === epoch;
  }
}

interface CommandInvocation {
  command: string;
  args: string[];
}

function buildInvocation(transport: AppServerTransportOptions): CommandInvocation {
  if (transport.mode === 'owned_stdio') {
    return {
      command: transport.codexBin,
      args: ['app-server', '--stdio', ...(transport.appServerArgs ?? [])],
    };
  }

  const socketArgs = transport.socketPath ? ['--sock', transport.socketPath] : [];
  return {
    command: transport.codexBin,
    args: ['app-server', 'proxy', ...socketArgs, ...(transport.proxyArgs ?? [])],
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): AppServerChildProcess {
  return spawn(command, [...args], options) as AppServerChildProcess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && 'then' in value && typeof value.then === 'function';
}

function parseRpcError(value: unknown): RpcError | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== 'number' ||
    !Number.isFinite(value.code) ||
    typeof value.message !== 'string'
  ) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(hasOwn(value, 'data') ? { data: value.data } : {}),
  };
}

function toConnectionError(
  _value: unknown,
  prefix: string,
  epoch: number,
): AppServerConnectionError {
  return new AppServerConnectionError(prefix, epoch);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safeCall(callback: () => void): void {
  try {
    callback();
  } catch {
    // A consumer callback must never break the transport reader.
  }
}

function safelyKill(child: AppServerChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function summarizeStderr(chunk: Buffer | string): string {
  const byteLength = Buffer.isBuffer(chunk)
    ? chunk.byteLength
    : Buffer.byteLength(chunk, 'utf8');
  return `App Server stderr received (${byteLength} bytes; content redacted)`;
}
