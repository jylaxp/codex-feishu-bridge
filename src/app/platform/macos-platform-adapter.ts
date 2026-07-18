import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  type DesktopIpcEndpoint,
  DesktopIpcEndpointError,
  type PlatformAdapter,
} from './platform-adapter';

export interface MacosPlatformAdapterOptions {
  readonly temporaryDirectory?: string;
  readonly codexHome?: string;
  readonly uid?: number | undefined;
  readonly endpointExists?: (path: string) => boolean;
  readonly lstatEndpoint?: (path: string) => Promise<Stats>;
}

/**
 * Attests accepted macOS ChatGPT Desktop follower socket layouts.
 * Electron's SingletonSocket is deliberately never accepted as a substitute.
 */
export class MacosPlatformAdapter implements PlatformAdapter {
  public readonly platform = 'macos' as const;

  private readonly temporaryDirectory: string;
  private readonly codexHome: string;
  private readonly uid: number | undefined;
  private readonly endpointExists: (path: string) => boolean;
  private readonly lstatEndpoint: (path: string) => Promise<Stats>;

  public constructor(options: MacosPlatformAdapterOptions = {}) {
    this.temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    this.codexHome = options.codexHome ?? join(homedir(), '.codex');
    this.uid = options.uid ?? process.getuid?.();
    this.endpointExists = options.endpointExists ?? existsSync;
    this.lstatEndpoint = options.lstatEndpoint ?? lstat;
  }

  public desktopIpcEndpoint(addressOverride?: string): DesktopIpcEndpoint {
    const codexHomeSocket = macosCodexHomeIpcSocketPath(this.codexHome);
    return Object.freeze({
      transport: 'unix_socket',
      address: addressOverride
        ?? (this.endpointExists(codexHomeSocket)
          ? codexHomeSocket
          : macosDesktopIpcSocketPath(this.temporaryDirectory, this.uid)),
    });
  }

  public async attestDesktopIpcEndpoint(endpoint: DesktopIpcEndpoint): Promise<void> {
    if (endpoint.transport !== 'unix_socket') {
      throw invalidEndpoint('macOS Desktop IPC must use a Unix socket');
    }
    const socketName = basename(endpoint.address);
    if (socketName !== 'ipc.sock' && !/^ipc-\d+\.sock$/.test(socketName)) {
      throw invalidEndpoint('Desktop IPC socket name is not recognized');
    }
    if (basename(dirname(endpoint.address)) === 'com.openai.codex') {
      throw invalidEndpoint('Electron SingletonSocket is not a Desktop follower endpoint');
    }
    try {
      const stats = await this.lstatEndpoint(endpoint.address);
      if (!stats.isSocket() || stats.isSymbolicLink()) {
        throw invalidEndpoint('Desktop IPC endpoint must be a real socket');
      }
      if (this.uid !== undefined && stats.uid !== this.uid) {
        throw invalidEndpoint('Desktop IPC endpoint must be owned by the current user');
      }
    } catch (error) {
      if (error instanceof DesktopIpcEndpointError) {
        throw error;
      }
      throw new DesktopIpcEndpointError(
        'DESKTOP_IPC_UNAVAILABLE',
        'Desktop IPC socket is unavailable',
        { cause: error },
      );
    }
  }
}

/** Returns the established UID-scoped macOS follower socket path. */
export function macosDesktopIpcSocketPath(
  temporaryDirectory: string = tmpdir(),
  uid: number | undefined = process.getuid?.(),
): string {
  const socketName = uid ? `ipc-${uid}.sock` : 'ipc.sock';
  return join(temporaryDirectory, 'codex-ipc', socketName);
}

/** Returns the current ChatGPT Desktop follower socket under the user's Codex home. */
export function macosCodexHomeIpcSocketPath(codexHome: string = join(homedir(), '.codex')): string {
  return join(codexHome, 'ipc', 'ipc.sock');
}

function invalidEndpoint(message: string): DesktopIpcEndpointError {
  return new DesktopIpcEndpointError('DESKTOP_IPC_INVALID_ENDPOINT', message);
}
