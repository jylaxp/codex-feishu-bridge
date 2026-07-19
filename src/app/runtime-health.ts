import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { AppServerProtocolProfileId } from './codex/app-server-protocol-registry';
import type { DesktopIpcSupervisorState } from './codex/desktop-ipc-supervisor';
import type { DesktopIpcContract } from './codex/desktop-ipc-contract';
import type { LarkWebsocketConnectionSnapshot } from './lark/client';

const HEALTH_FILE_NAME = 'runtime-health.json';

export interface RuntimeTaskHealth {
  readonly active: number;
  readonly queued: number;
  readonly pendingCardDeliveries: number;
}

export interface RuntimeHealthSnapshot {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly supervisorPid: number;
  readonly updatedAt: string;
  readonly status: 'starting' | 'ready' | 'degraded' | 'stopped';
  readonly appServer: {
    readonly state: 'starting' | 'ready' | 'stopped';
    readonly protocolContractId: AppServerProtocolProfileId;
    readonly schemaDigest: string;
    readonly artifactSha256: string;
  };
  readonly desktop: {
    readonly state: DesktopIpcSupervisorState;
    readonly epoch: number | null;
    readonly contractId: DesktopIpcContract['id'];
  };
  readonly lark: LarkWebsocketConnectionSnapshot;
  readonly tasks: RuntimeTaskHealth;
}

/** Persists a content-free, atomically replaced runtime health snapshot. */
export class RuntimeHealthStore {
  public readonly filePath: string;

  public constructor(private readonly configHome: string) {
    this.filePath = join(configHome, HEALTH_FILE_NAME);
  }

  public write(snapshot: RuntimeHealthSnapshot): void {
    mkdirSync(this.configHome, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}

/** Coalesces bursty task updates while allowing lifecycle boundaries to flush immediately. */
export class RuntimeHealthPublisher {
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly publish: () => void,
    private readonly delayMs: number = 250,
  ) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1) {
      throw new RangeError('Runtime health publish delay must be a positive safe integer');
    }
  }

  public request(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publish();
    }, this.delayMs);
    this.timer.unref();
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.publish();
  }
}

export function readRuntimeHealth(configHome: string): RuntimeHealthSnapshot | null {
  const filePath = join(configHome, HEALTH_FILE_NAME);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeHealthSnapshot;
    return value.schemaVersion === 1
      && Number.isSafeInteger(value.pid)
      && Number.isSafeInteger(value.supervisorPid)
      ? value
      : null;
  } catch {
    return null;
  }
}
