import type { DesktopIpcHandshake } from './desktop-ipc-client';

export type DesktopIpcSupervisorState = 'STOPPED' | 'CONNECTING' | 'READY' | 'RECONNECTING';

export interface DesktopIpcLifecycleClient {
  start(): Promise<DesktopIpcHandshake>;
  stop(): Promise<void>;
  onConnectionLost(listener: (epoch: number) => void): () => void;
}

export interface DesktopIpcSupervisorOptions {
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
  readonly onDisconnected: (epoch: number) => void | Promise<void>;
  readonly onReady?: (handshake: DesktopIpcHandshake) => void;
  readonly onReconnectError?: (error: Error) => void;
}

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAXIMUM_DELAY_MS = 5_000;

/**
 * Owns one Desktop IPC connection epoch. On loss it abandons local work via
 * the supplied callback and reconnects only for future inbound tasks.
 */
export class DesktopIpcSupervisor {
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaximumDelayMs: number;
  private readonly unsubscribeConnectionLost: () => void;
  private currentState: DesktopIpcSupervisorState = 'STOPPED';
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs: number;
  private reconnecting = false;

  public constructor(
    private readonly client: DesktopIpcLifecycleClient,
    private readonly options: DesktopIpcSupervisorOptions,
  ) {
    this.reconnectInitialDelayMs = positiveDelay(
      options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      'reconnectInitialDelayMs',
    );
    this.reconnectMaximumDelayMs = positiveDelay(
      options.reconnectMaximumDelayMs ?? DEFAULT_RECONNECT_MAXIMUM_DELAY_MS,
      'reconnectMaximumDelayMs',
    );
    if (this.reconnectMaximumDelayMs < this.reconnectInitialDelayMs) {
      throw new RangeError('reconnectMaximumDelayMs must not be lower than reconnectInitialDelayMs');
    }
    this.reconnectDelayMs = this.reconnectInitialDelayMs;
    this.unsubscribeConnectionLost = client.onConnectionLost((epoch) => {
      void this.handleConnectionLost(epoch);
    });
  }

  public get state(): DesktopIpcSupervisorState {
    return this.currentState;
  }

  /** Connects once for startup. Later failures are handled by bounded retries. */
  public async start(): Promise<DesktopIpcHandshake> {
    if (!this.stopped) {
      throw new Error('Desktop IPC supervisor is already running');
    }
    this.stopped = false;
    this.currentState = 'CONNECTING';
    try {
      const handshake = await this.client.start();
      this.currentState = 'READY';
      this.reconnectDelayMs = this.reconnectInitialDelayMs;
      this.options.onReady?.(handshake);
      return handshake;
    } catch (error) {
      this.stopped = true;
      this.currentState = 'STOPPED';
      throw toError(error);
    }
  }

  /** Stops timers, unregisters the listener and closes the owned client. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.currentState = 'STOPPED';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.unsubscribeConnectionLost();
    await this.client.stop();
  }

  private async handleConnectionLost(epoch: number): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.currentState = 'RECONNECTING';
    try {
      await this.options.onDisconnected(epoch);
    } catch (error) {
      this.options.onReconnectError?.(toError(error));
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.reconnecting) {
      return;
    }
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectMaximumDelayMs,
      this.reconnectDelayMs * 2,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    let reconnectFailed = false;
    try {
      const handshake = await this.client.start();
      if (this.stopped) {
        return;
      }
      this.currentState = 'READY';
      this.reconnectDelayMs = this.reconnectInitialDelayMs;
      this.options.onReady?.(handshake);
    } catch (error) {
      this.options.onReconnectError?.(toError(error));
      reconnectFailed = true;
    } finally {
      this.reconnecting = false;
      if (reconnectFailed) {
        this.scheduleReconnect();
      }
    }
  }
}

function positiveDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
