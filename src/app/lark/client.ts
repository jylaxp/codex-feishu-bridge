import * as Lark from '@larksuiteoapi/node-sdk';

import { BridgeConfig } from '../domain';

const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_WEBSOCKET_READY_TIMEOUT_MS = 20_000;

export type FetchLike = typeof fetch;

export interface TenantTokenProvider {
  getToken(): Promise<string>;
  invalidateToken?(rejectedToken: string): void;
}

export interface LarkRuntimeClients {
  readonly api: Lark.Client;
  readonly websocket: LarkRuntimeWebsocketClient;
}

export interface LarkRuntimeWebsocketClient {
  start(params: Parameters<Lark.WSClient['start']>[0]): Promise<void>;
  close(params?: Parameters<Lark.WSClient['close']>[0]): void;
  connectionSnapshot(): LarkWebsocketConnectionSnapshot;
}

export type LarkWebsocketConnectionState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'terminal'
  | 'closed';

export interface LarkWebsocketConnectionSnapshot {
  readonly state: LarkWebsocketConnectionState;
  readonly reconnectCount: number;
  readonly connectedAtMs: number | null;
}

export type LarkSdkLogLevel = 'error' | 'warn';
export type LarkSdkLogSink = (level: LarkSdkLogLevel) => void;
type LarkClientOptions = ConstructorParameters<typeof Lark.Client>[0];
type LarkWebsocketOptions = ConstructorParameters<typeof Lark.WSClient>[0];

export interface LarkRuntimeClientFactories {
  readonly createClient: (options: LarkClientOptions) => Lark.Client;
  readonly createWebsocketClient: (options: LarkWebsocketOptions) => Lark.WSClient;
}

export interface LarkRuntimeClientOptions {
  readonly logSink?: LarkSdkLogSink;
  readonly factories?: LarkRuntimeClientFactories;
  readonly websocketReadyTimeoutMs?: number;
  readonly onTerminalWebsocketError?: (error: Error) => void;
  readonly onWebsocketStateChanged?: (snapshot: LarkWebsocketConnectionSnapshot) => void;
}

const DEFAULT_LARK_CLIENT_FACTORIES: LarkRuntimeClientFactories = Object.freeze({
  createClient: (options: LarkClientOptions) => new Lark.Client(options),
  createWebsocketClient: (options: LarkWebsocketOptions) => new Lark.WSClient(options),
});

interface TokenResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly tenant_access_token?: string;
  readonly expire?: number;
}

export class LarkAuthenticationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LarkAuthenticationError';
  }
}

export class LarkWebsocketStartupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LarkWebsocketStartupError';
  }
}

export class LarkWebsocketTerminalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LarkWebsocketTerminalError';
  }
}

class ReadyLarkWebsocketClient implements LarkRuntimeWebsocketClient {
  private readonly rawClient: Lark.WSClient;
  private startPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readyReached = false;
  private closed = false;
  private terminalErrorReported = false;
  private state: LarkWebsocketConnectionState = 'idle';
  private reconnectCount = 0;
  private connectedAtMs: number | null = null;

  public constructor(
    options: LarkWebsocketOptions,
    factory: LarkRuntimeClientFactories['createWebsocketClient'],
    private readonly readyTimeoutMs: number,
    private readonly onTerminalError: (error: Error) => void,
    private readonly onStateChanged: (snapshot: LarkWebsocketConnectionSnapshot) => void,
  ) {
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
      throw new RangeError('Lark WebSocket ready timeout must be a positive safe integer');
    }
    this.rawClient = factory({
      ...options,
      autoReconnect: true,
      handshakeTimeoutMs: Math.min(10_000, readyTimeoutMs),
      onReady: () => {
        this.readyReached = true;
        this.transition('ready');
        this.readyResolve?.();
      },
      onError: () => this.handleConnectionError(),
      onReconnecting: () => {
        if (this.closed || this.terminalErrorReported) {
          return;
        }
        this.reconnectCount += 1;
        this.transition('reconnecting');
      },
      onReconnected: () => {
        if (this.closed || this.terminalErrorReported) {
          return;
        }
        this.transition('ready');
      },
    });
  }

  public start(params: Parameters<Lark.WSClient['start']>[0]): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.transition('connecting');
    const start = this.startAndWait(params);
    this.startPromise = start;
    return start;
  }

  public close(params?: Parameters<Lark.WSClient['close']>[0]): void {
    this.closed = true;
    this.transition('closed');
    this.readyReject?.(new LarkWebsocketStartupError('Lark WebSocket startup was cancelled'));
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.rawClient.close(params);
  }

  public connectionSnapshot(): LarkWebsocketConnectionSnapshot {
    return Object.freeze({
      state: this.state,
      reconnectCount: this.reconnectCount,
      connectedAtMs: this.connectedAtMs,
    });
  }

  private handleConnectionError(): void {
    if (!this.readyReached) {
      this.transition('terminal');
      this.readyReject?.(new LarkWebsocketStartupError('Lark WebSocket connection failed'));
      return;
    }
    if (this.closed || this.terminalErrorReported) {
      return;
    }
    this.terminalErrorReported = true;
    this.transition('terminal');
    this.onTerminalError(
      new LarkWebsocketTerminalError('Lark WebSocket connection terminated'),
    );
  }

  private transition(state: LarkWebsocketConnectionState): void {
    this.state = state;
    this.connectedAtMs = state === 'ready' ? Date.now() : null;
    this.onStateChanged(this.connectionSnapshot());
  }

  private async startAndWait(params: Parameters<Lark.WSClient['start']>[0]): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      timeout = setTimeout(() => {
        reject(new LarkWebsocketStartupError('Lark WebSocket ready timeout'));
      }, this.readyTimeoutMs);
    });
    try {
      await this.rawClient.start(params);
      await ready;
    } catch {
      // If raw start itself rejected before `ready` was awaited, settle the
      // auxiliary promise so its timer cannot later create an unhandled rejection.
      this.readyResolve?.();
      this.rawClient.close({ force: true });
      if (this.state !== 'terminal') {
        this.transition('terminal');
      }
      throw new LarkWebsocketStartupError('Lark WebSocket could not become ready');
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.readyResolve = undefined;
      this.readyReject = undefined;
    }
  }
}

/**
 * Creates an SDK logger that deliberately discards every third-party argument.
 * Axios errors can contain request bodies and Authorization headers, so only a
 * fixed severity marker may cross into the bridge logging boundary.
 */
export function createRedactedLarkSdkLogger(
  sink: LarkSdkLogSink = () => undefined,
): Lark.Logger {
  return Object.freeze({
    error: (..._messages: unknown[]) => sink('error'),
    warn: (..._messages: unknown[]) => sink('warn'),
    info: (..._messages: unknown[]) => undefined,
    debug: (..._messages: unknown[]) => undefined,
    trace: (..._messages: unknown[]) => undefined,
  });
}

/** Fetches and caches a bot tenant token without logging credentials or tokens. */
export class CachedTenantTokenProvider implements TenantTokenProvider {
  private token = '';
  private expiresAtMs = 0;
  private inFlight: Promise<string> | undefined;

  public constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  public getToken(): Promise<string> {
    if (this.token && this.expiresAtMs > Date.now() + 60_000) {
      return Promise.resolve(this.token);
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchToken();
    this.inFlight = request;
    return request.finally(() => {
      if (this.inFlight === request) {
        this.inFlight = undefined;
      }
    });
  }

  /** Invalidates only the token that an API has proven unusable. */
  public invalidateToken(rejectedToken: string): void {
    if (this.token !== rejectedToken) {
      return;
    }
    this.token = '';
    this.expiresAtMs = 0;
  }

  private async fetchToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LarkAuthenticationError('Lark tenant token request failed');
    }
    if (!response.ok) {
      throw new LarkAuthenticationError(`Lark tenant token HTTP status ${response.status}`);
    }

    const rawBody = await response.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new LarkAuthenticationError('Lark tenant token response is too large');
    }

    let payload: TokenResponse;
    try {
      payload = JSON.parse(rawBody) as TokenResponse;
    } catch {
      throw new LarkAuthenticationError('Lark tenant token response is invalid JSON');
    }
    if (
      payload.code !== 0
      || typeof payload.tenant_access_token !== 'string'
      || !payload.tenant_access_token
    ) {
      throw new LarkAuthenticationError(
        `Lark tenant token rejected: ${payload.msg ?? 'unknown error'}`,
      );
    }

    const expiresInSeconds = Number.isFinite(payload.expire) && (payload.expire ?? 0) > 0
      ? payload.expire as number
      : 7_200;
    this.token = payload.tenant_access_token;
    this.expiresAtMs = Date.now() + expiresInSeconds * 1_000;
    return this.token;
  }
}

/** Constructs SDK clients only; it never auto-registers an application. */
export function createLarkRuntimeClients(
  config: BridgeConfig,
  options: LarkRuntimeClientOptions = {},
): LarkRuntimeClients {
  const logSink = options.logSink ?? (() => undefined);
  const factories = options.factories ?? DEFAULT_LARK_CLIENT_FACTORIES;
  const websocketReadyTimeoutMs = options.websocketReadyTimeoutMs
    ?? DEFAULT_WEBSOCKET_READY_TIMEOUT_MS;
  const logger = createRedactedLarkSdkLogger(logSink);
  const clientOptions: LarkClientOptions = {
    appId: config.larkAppId,
    appSecret: config.larkAppSecret,
    logger,
  };
  const websocketOptions: LarkWebsocketOptions = {
    appId: config.larkAppId,
    appSecret: config.larkAppSecret,
    logger,
  };
  return Object.freeze({
    api: factories.createClient(clientOptions),
    websocket: new ReadyLarkWebsocketClient(
      websocketOptions,
      factories.createWebsocketClient,
      websocketReadyTimeoutMs,
      options.onTerminalWebsocketError ?? (() => undefined),
      options.onWebsocketStateChanged ?? (() => undefined),
    ),
  });
}
