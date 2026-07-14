/**
 * Platform boundary for Desktop-owned IPC. Business services only receive an
 * attested endpoint and must not infer transport details from process.platform.
 */
export type BridgePlatform = 'macos' | 'windows';

export type DesktopIpcTransport = 'unix_socket' | 'named_pipe';

export interface DesktopIpcEndpoint {
  readonly transport: DesktopIpcTransport;
  readonly address: string;
}

export class DesktopIpcEndpointError extends Error {
  public constructor(
    public readonly code:
      | 'DESKTOP_IPC_UNSUPPORTED_PLATFORM'
      | 'DESKTOP_IPC_UNAVAILABLE'
      | 'DESKTOP_IPC_INVALID_ENDPOINT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DesktopIpcEndpointError';
  }
}

export interface PlatformAdapter {
  readonly platform: BridgePlatform;

  /** Builds an endpoint candidate without touching the runtime. */
  desktopIpcEndpoint(addressOverride?: string): DesktopIpcEndpoint;

  /**
   * Verifies that the endpoint belongs to the current Desktop runtime before
   * the client writes any follower frame.
   */
  attestDesktopIpcEndpoint(endpoint: DesktopIpcEndpoint): Promise<void>;
}

export interface PlatformAdapterFactoryOptions {
  readonly platform?: NodeJS.Platform;
}
