import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_FILE_NAME = 'bridge.lock';
const RECOVERY_MUTEX_FILE_NAME = 'bridge.lock.recovery';
const MAX_ACQUIRE_ATTEMPTS = 3;

export class BridgeProcessLockError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BridgeProcessLockError';
  }
}

interface LockFilePayload {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

export interface BridgeProcessLockOptions {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly token?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/**
 * Holds the process-level ownership boundary for one Bridge data directory.
 * A stale lock is removed only when its recorded process is provably absent.
 */
export class BridgeProcessLock {
  private readonly lockPath: string;
  private readonly recoveryMutexPath: string;
  private readonly pid: number;
  private readonly token: string;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private descriptor: number | undefined;

  public constructor(
    dataDirectory: string,
    options: BridgeProcessLockOptions = {},
  ) {
    this.lockPath = join(dataDirectory, LOCK_FILE_NAME);
    this.recoveryMutexPath = join(dataDirectory, RECOVERY_MUTEX_FILE_NAME);
    this.pid = options.pid ?? process.pid;
    this.token = options.token ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
  }

  /** Acquires exclusive ownership or fails closed when another owner is live. */
  public acquire(): void {
    if (this.descriptor !== undefined) {
      throw new BridgeProcessLockError('Bridge process lock is already held');
    }

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        const descriptor = openSync(
          this.lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          chmodSync(this.lockPath, 0o600);
          writeFileSync(descriptor, JSON.stringify(this.payload()), { encoding: 'utf8' });
          fsyncSync(descriptor);
          this.descriptor = descriptor;
          return;
        } catch (error) {
          closeSync(descriptor);
          safelyUnlink(this.lockPath);
          throw error;
        }
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw new BridgeProcessLockError('Bridge process lock could not be acquired');
        }
        if (!this.removeProvablyStaleLock()) {
          throw new BridgeProcessLockError(
            'Another Bridge process already owns this data directory',
          );
        }
      }
    }
    throw new BridgeProcessLockError('Bridge process lock could not be acquired safely');
  }

  /** Releases only the lock file carrying this instance's unguessable token. */
  public release(): void {
    const descriptor = this.descriptor;
    this.descriptor = undefined;
    if (descriptor === undefined) {
      return;
    }
    try {
      const payload = readTrustedPayload(this.lockPath);
      const heldStat = fstatSync(descriptor);
      const pathStat = statSync(this.lockPath);
      if (
        payload.token === this.token
        && payload.pid === this.pid
        && heldStat.dev === pathStat.dev
        && heldStat.ino === pathStat.ino
      ) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Never delete a file whose ownership can no longer be proven.
    } finally {
      closeSync(descriptor);
    }
  }

  private payload(): LockFilePayload {
    return {
      pid: this.pid,
      token: this.token,
      startedAt: this.now().toISOString(),
    };
  }

  private removeProvablyStaleLock(): boolean {
    const recoveryDescriptor = this.acquireRecoveryMutex();
    if (recoveryDescriptor === undefined) {
      return false;
    }
    try {
      let payload: LockFilePayload;
      try {
        payload = readTrustedPayload(this.lockPath);
      } catch (error) {
        if (!existsSync(this.lockPath)) {
          return true;
        }
        throw error;
      }
      if (this.isProcessAlive(payload.pid)) {
        return false;
      }
      try {
        unlinkSync(this.lockPath);
        return true;
      } catch (error) {
        if (isNotFoundError(error)) {
          return true;
        }
        throw new BridgeProcessLockError('Stale Bridge process lock could not be removed');
      }
    } finally {
      this.releaseRecoveryMutex(recoveryDescriptor);
    }
  }

  private acquireRecoveryMutex(): number | undefined {
    try {
      const descriptor = openSync(
        this.recoveryMutexPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        chmodSync(this.recoveryMutexPath, 0o600);
        writeFileSync(descriptor, JSON.stringify(this.payload()), { encoding: 'utf8' });
        fsyncSync(descriptor);
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        safelyUnlink(this.recoveryMutexPath);
        throw error;
      }
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return undefined;
      }
      throw new BridgeProcessLockError('Bridge process lock recovery mutex could not be acquired');
    }
  }

  private releaseRecoveryMutex(descriptor: number): void {
    try {
      const payload = readTrustedPayload(this.recoveryMutexPath);
      const heldStat = fstatSync(descriptor);
      const pathStat = statSync(this.recoveryMutexPath);
      if (
        payload.token === this.token
        && payload.pid === this.pid
        && heldStat.dev === pathStat.dev
        && heldStat.ino === pathStat.ino
      ) {
        unlinkSync(this.recoveryMutexPath);
      }
    } catch {
      // Never delete a recovery mutex whose ownership can no longer be proven.
    } finally {
      closeSync(descriptor);
    }
  }
}

function readTrustedPayload(lockPath: string): LockFilePayload {
  if (!existsSync(lockPath)) {
    throw new BridgeProcessLockError('Bridge process lock disappeared during validation');
  }
  const linkStat = lstatSync(lockPath);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new BridgeProcessLockError('Bridge process lock must be a regular non-symlink file');
  }
  const fileStat = statSync(lockPath);
  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
    throw new BridgeProcessLockError('Bridge process lock must be owned by the current user');
  }
  if ((fileStat.mode & 0o077) !== 0) {
    throw new BridgeProcessLockError('Bridge process lock must not be group/world accessible');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown;
  } catch {
    throw new BridgeProcessLockError('Bridge process lock payload is invalid');
  }
  if (!isLockFilePayload(parsed)) {
    throw new BridgeProcessLockError('Bridge process lock payload is invalid');
  }
  return parsed;
}

function isLockFilePayload(value: unknown): value is LockFilePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Number.isSafeInteger(record.pid)
    && Number(record.pid) > 0
    && typeof record.token === 'string'
    && record.token.length >= 16
    && typeof record.startedAt === 'string'
    && Number.isFinite(Date.parse(record.startedAt));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function safelyUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Preserve the original acquisition error.
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return nodeErrorCode(error) === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return nodeErrorCode(error) === 'ENOENT';
}

function isNoSuchProcessError(error: unknown): boolean {
  return nodeErrorCode(error) === 'ESRCH';
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as Error & { readonly code?: string }).code
    : undefined;
}
