import {
  type DesktopIpcEndpoint,
  DesktopIpcEndpointError,
  type PlatformAdapter,
} from './platform-adapter';

export interface WindowsDesktopProbe {
  /**
   * Returns an endpoint only after proving current-user SID, interactive
   * session, owner process and protocol compatibility. A Node-only fallback
   * is intentionally not provided because named-pipe enumeration cannot make
   * those guarantees.
   */
  discoverAttestedEndpoint(): Promise<DesktopIpcEndpoint | null>;

  /** Rechecks ownership immediately before the Bridge opens the pipe. */
  attestEndpoint(endpoint: DesktopIpcEndpoint): Promise<boolean>;
}

/**
 * Windows adapter with a deliberate native-probe seam. Until a signed probe
 * is supplied, Desktop execution is unavailable rather than guessing a common
 * pipe name such as \\.\pipe\codex-ipc.
 */
export class WindowsPlatformAdapter implements PlatformAdapter {
  public readonly platform = 'windows' as const;

  public constructor(private readonly probe: WindowsDesktopProbe | null = null) {}

  public desktopIpcEndpoint(addressOverride?: string): DesktopIpcEndpoint {
    if (addressOverride) {
      return Object.freeze({ transport: 'named_pipe', address: addressOverride });
    }
    throw new DesktopIpcEndpointError(
      'DESKTOP_IPC_UNAVAILABLE',
      'Windows Desktop IPC requires an attested native probe',
    );
  }

  public async discoverDesktopIpcEndpoint(): Promise<DesktopIpcEndpoint> {
    if (!this.probe) {
      throw new DesktopIpcEndpointError(
        'DESKTOP_IPC_UNAVAILABLE',
        'Windows Desktop IPC requires an attested native probe',
      );
    }
    const endpoint = await this.probe.discoverAttestedEndpoint();
    if (!endpoint || endpoint.transport !== 'named_pipe') {
      throw new DesktopIpcEndpointError(
        'DESKTOP_IPC_UNAVAILABLE',
        'No attested Windows Desktop IPC endpoint is available',
      );
    }
    return endpoint;
  }

  public async attestDesktopIpcEndpoint(endpoint: DesktopIpcEndpoint): Promise<void> {
    if (endpoint.transport !== 'named_pipe' || !this.probe) {
      throw new DesktopIpcEndpointError(
        'DESKTOP_IPC_UNAVAILABLE',
        'Windows Desktop IPC endpoint cannot be attested',
      );
    }
    if (!(await this.probe.attestEndpoint(endpoint))) {
      throw new DesktopIpcEndpointError(
        'DESKTOP_IPC_INVALID_ENDPOINT',
        'Windows Desktop IPC endpoint failed owner/session attestation',
      );
    }
  }
}
