import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const MAX_CONSECUTIVE_FAILURES = 5;
const STABLE_RUNTIME_MS = 60_000;
const INITIAL_RESTART_DELAY_MS = 500;
const MAXIMUM_RESTART_DELAY_MS = 10_000;
export const WORKER_SHUTDOWN_GRACE_MS = 5_000;

export interface ProcessSupervisorOptions {
  readonly entryPath?: string;
  readonly spawnProcess?: typeof spawn;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** Supervises the foreground worker without persisting or replaying any task state. */
export async function runProcessSupervisor(
  options: ProcessSupervisorOptions = {},
): Promise<void> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const wait = options.delay ?? delay;
  const now = options.now ?? Date.now;
  const entryPath = options.entryPath ?? resolve(__dirname, 'cli.js');
  let worker: ChildProcess | undefined;
  let stopping = false;
  let consecutiveFailures = 0;
  let restartDelayMs = INITIAL_RESTART_DELAY_MS;
  let cancelForcedTermination: (() => void) | undefined;

  const stop = (): void => {
    stopping = true;
    if (worker && !cancelForcedTermination) {
      cancelForcedTermination = requestWorkerTermination(worker);
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      const startedAtMs = now();
      worker = spawnProcess(process.execPath, [entryPath, 'run'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
      });
      await waitForExit(worker);
      cancelForcedTermination?.();
      cancelForcedTermination = undefined;
      worker = undefined;
      if (stopping) {
        return;
      }
      if (now() - startedAtMs >= STABLE_RUNTIME_MS) {
        consecutiveFailures = 0;
        restartDelayMs = INITIAL_RESTART_DELAY_MS;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error('Bridge worker exceeded the consecutive restart limit');
      }
      await wait(restartDelayMs);
      restartDelayMs = Math.min(MAXIMUM_RESTART_DELAY_MS, restartDelayMs * 2);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    cancelForcedTermination?.();
    if (worker) {
      requestWorkerTermination(worker);
    }
  }
}

/** Forwards graceful shutdown, then guarantees termination after the bounded grace period. */
export function requestWorkerTermination(
  child: Pick<ChildProcess, 'kill'>,
  graceMs: number = WORKER_SHUTDOWN_GRACE_MS,
): () => void {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit, reject) => {
    child.once('exit', () => resolveExit());
    child.once('error', reject);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
