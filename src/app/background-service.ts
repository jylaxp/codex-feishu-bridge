import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveConfigHome } from './config';
import { loadBridgeEnvironment } from './config-file';
import { readRuntimeHealth, type RuntimeHealthSnapshot } from './runtime-health';
import { WORKER_SHUTDOWN_GRACE_MS } from './process-supervisor';
import { isProcessAlive } from './process-liveness';

const STOP_WAIT_MS = WORKER_SHUTDOWN_GRACE_MS + 2_000;
const STOP_POLL_MS = 100;
const UPDATE_REPOSITORY = 'git+https://github.com/jylaxp/codex-feishu-bridge.git';

export type BackgroundCommand = 'start' | 'restart' | 'stop' | 'status' | 'update';

export interface BackgroundServiceOptions {
  readonly configHome?: string;
  readonly forceUpdate?: boolean;
  readonly entryPath?: string;
  readonly spawnProcess?: typeof spawn;
  readonly executeFile?: typeof execFileSync;
  readonly listProcesses?: () => readonly ProcessSnapshot[];
  readonly killProcess?: KillProcess;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly output?: { write(chunk: string): unknown };
  readonly jsonOutput?: boolean;
}

export interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number | null;
  readonly command: string;
}

export interface BackgroundServiceReport {
  readonly command: BackgroundCommand;
  readonly running: boolean;
  readonly pid: number | null;
  readonly loggingEnabled: boolean;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  readonly health: RuntimeHealthSnapshot | null;
}

/** Implements the original PID/log based background lifecycle. */
export async function runBackgroundCommand(
  command: BackgroundCommand,
  options: BackgroundServiceOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<BackgroundServiceReport> {
  const paths = servicePaths(options.configHome ?? resolveConfigHome(baseEnv));
  const output = options.output ?? process.stdout;
  const entryPath = options.entryPath ?? resolve(__dirname, 'cli.js');
  const lifecycle = createProcessLifecycle(options);
  if (command === 'status') {
    const report = statusReport(command, paths, baseEnv, lifecycle.isAlive);
    output.write(options.jsonOutput ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
    return report;
  }
  if (command === 'stop') {
    const report = await stopService(paths, baseEnv, entryPath, lifecycle);
    output.write(report.running ? '❌ Bridge 未能停止。\n' : '✅ Bridge 后台服务已停止。\n');
    return report;
  }
  if (command === 'restart') {
    await stopService(paths, baseEnv, entryPath, lifecycle);
    const report = startService(paths, options, baseEnv, 'restart');
    output.write(formatStarted(report, '重启'));
    return report;
  }
  if (command === 'update') {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '-g', UPDATE_REPOSITORY];
    if (options.forceUpdate) args.push('--force');
    (options.executeFile ?? execFileSync)(npm, args, { stdio: 'inherit' });
    await stopService(paths, baseEnv, entryPath, lifecycle);
    const report = startService(paths, options, baseEnv, 'update');
    output.write(formatStarted(report, '更新并重启'));
    return report;
  }
  const existing = statusReport('start', paths, baseEnv, lifecycle.isAlive);
  if (existing.running) {
    output.write(`ℹ️ Bridge 已在后台运行，PID: ${existing.pid}\n`);
    return existing;
  }
  const report = startService(paths, options, baseEnv, 'start');
  output.write(formatStarted(report, '启动'));
  return report;
}

interface ServicePaths {
  readonly configHome: string;
  readonly logsDir: string;
  readonly pidFile: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

function servicePaths(configHome: string): ServicePaths {
  const logsDir = join(configHome, 'logs');
  return {
    configHome,
    logsDir,
    pidFile: join(configHome, 'bridge.pid'),
    stdoutLog: join(logsDir, 'bridge_stdout.log'),
    stderrLog: join(logsDir, 'bridge_stderr.log'),
  };
}

function startService(
  paths: ServicePaths,
  options: BackgroundServiceOptions,
  baseEnv: NodeJS.ProcessEnv,
  command: BackgroundCommand,
): BackgroundServiceReport {
  const loggingEnabled = resolveLoggingEnabled(paths.configHome, baseEnv);
  let stdout: number | undefined;
  let stderr: number | undefined;
  let child: ChildProcess;
  try {
    if (loggingEnabled) {
      mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
      stdout = openSync(paths.stdoutLog, 'a', 0o600);
      stderr = openSync(paths.stderrLog, 'a', 0o600);
    }
    child = (options.spawnProcess ?? spawn)(
      process.execPath,
      [options.entryPath ?? resolve(__dirname, 'cli.js'), 'supervise'],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: loggingEnabled
          ? ['ignore', stdout!, stderr!]
          : ['ignore', 'ignore', 'ignore'],
        env: { ...baseEnv, BRIDGE_CONFIG_HOME: paths.configHome },
      },
    );
  } finally {
    if (stdout !== undefined) {
      closeSync(stdout);
    }
    if (stderr !== undefined) {
      closeSync(stderr);
    }
  }
  if (!child.pid) {
    throw new Error('无法获取 Bridge 后台进程 PID');
  }
  child.unref();
  writeFileSync(paths.pidFile, `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    command,
    running: true,
    pid: child.pid,
    loggingEnabled,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    health: null,
  };
}

async function stopService(
  paths: ServicePaths,
  baseEnv: NodeJS.ProcessEnv,
  entryPath: string,
  lifecycle: ProcessLifecycle,
): Promise<BackgroundServiceReport> {
  const pid = readPid(paths.pidFile);
  if (!pid || !lifecycle.isAlive(pid)) {
    removePidFile(paths.pidFile);
  } else {
    await terminateProcess(pid, lifecycle);
  }
  await stopAdditionalBridgeProcesses(entryPath, lifecycle);
  removePidFile(paths.pidFile);
  const report = statusReport('stop', paths, baseEnv, lifecycle.isAlive);
  const leftovers = currentEntryBridgeProcesses(entryPath, lifecycle.listProcesses())
    .filter((processInfo) => lifecycle.isAlive(processInfo.pid));
  return leftovers.length === 0 ? report : {
    ...report,
    running: true,
    pid: leftovers[0]?.pid ?? report.pid,
  };
}

async function terminateProcess(
  pid: number,
  lifecycle: ProcessLifecycle,
): Promise<void> {
  try {
    lifecycle.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline && lifecycle.isAlive(pid)) {
    await lifecycle.delay(STOP_POLL_MS);
  }
  if (lifecycle.isAlive(pid)) {
    try {
      lifecycle.kill(pid, 'SIGKILL');
    } catch {
      // The process may exit between the liveness check and the signal.
    }
  }
}

async function stopAdditionalBridgeProcesses(
  entryPath: string,
  lifecycle: ProcessLifecycle,
): Promise<void> {
  const candidates = currentEntryBridgeProcesses(entryPath, lifecycle.listProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid && lifecycle.isAlive(processInfo.pid));
  const ordered = [...candidates].sort((left, right) => processKindOrder(left.kind) - processKindOrder(right.kind));
  const seen = new Set<number>();
  for (const processInfo of ordered) {
    if (seen.has(processInfo.pid)) {
      continue;
    }
    seen.add(processInfo.pid);
    await terminateProcess(processInfo.pid, lifecycle);
  }
}

function statusReport(
  command: BackgroundCommand,
  paths: ServicePaths,
  baseEnv: NodeJS.ProcessEnv,
  isAlive: (pid: number) => boolean,
): BackgroundServiceReport {
  const pid = readPid(paths.pidFile);
  const running = pid !== null && isAlive(pid);
  if (pid !== null && !running) removePidFile(paths.pidFile);
  const health = running ? readRuntimeHealth(paths.configHome) : null;
  return {
    command,
    running,
    pid: running ? pid : null,
    loggingEnabled: resolveLoggingEnabled(paths.configHome, baseEnv),
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    health: health?.supervisorPid === pid && isAlive(health.pid) ? health : null,
  };
}

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => unknown;

interface ProcessLifecycle {
  readonly listProcesses: () => readonly ProcessSnapshot[];
  readonly kill: KillProcess;
  readonly isAlive: (pid: number) => boolean;
  readonly delay: (milliseconds: number) => Promise<void>;
}

interface BridgeProcessSnapshot extends ProcessSnapshot {
  readonly kind: 'supervise' | 'run';
}

function createProcessLifecycle(options: BackgroundServiceOptions): ProcessLifecycle {
  return {
    listProcesses: options.listProcesses ?? listSystemProcesses,
    kill: options.killProcess ?? process.kill,
    isAlive: options.isProcessAlive ?? isProcessAlive,
    delay: options.delay ?? delay,
  };
}

function listSystemProcesses(): readonly ProcessSnapshot[] {
  if (process.platform === 'win32') {
    return [];
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return output
    .split('\n')
    .map((line) => parseProcessLine(line))
    .filter((processInfo): processInfo is ProcessSnapshot => processInfo !== null);
}

function parseProcessLine(line: string): ProcessSnapshot | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
    return null;
  }
  return {
    pid,
    ppid,
    command: match[3] ?? '',
  };
}

function currentEntryBridgeProcesses(
  entryPath: string,
  processes: readonly ProcessSnapshot[],
): readonly BridgeProcessSnapshot[] {
  return processes.flatMap((processInfo) => {
    const kind = bridgeProcessKind(entryPath, processInfo.command);
    return kind ? [{ ...processInfo, kind }] : [];
  });
}

function bridgeProcessKind(entryPath: string, command: string): BridgeProcessSnapshot['kind'] | null {
  if (!/(?:^|[/\\\s])node(?:\.exe)?(?:\s|$)/i.test(command)) {
    return null;
  }
  if (commandRunsBridgeEntry(command, entryPath, 'supervise')) {
    return 'supervise';
  }
  if (commandRunsBridgeEntry(command, entryPath, 'run')) {
    return 'run';
  }
  return null;
}

function commandRunsBridgeEntry(command: string, entryPath: string, subcommand: string): boolean {
  const index = command.indexOf(entryPath);
  if (index < 0) {
    return false;
  }
  const afterEntry = command.slice(index + entryPath.length).trimStart();
  return afterEntry === subcommand || afterEntry.startsWith(`${subcommand} `);
}

function processKindOrder(kind: BridgeProcessSnapshot['kind']): number {
  return kind === 'supervise' ? 0 : 1;
}

function resolveLoggingEnabled(configHome: string, baseEnv: NodeJS.ProcessEnv): boolean {
  try {
    const env = loadBridgeEnvironment({
      ...baseEnv,
      BRIDGE_CONFIG_HOME: configHome,
    });
    return env.LOG_TO_FILE?.trim() === 'true';
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const value = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function removePidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // Missing or concurrently removed PID files are already clean.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function formatStatus(report: BackgroundServiceReport): string {
  const runtimeStatus = report.health?.status ?? 'unknown';
  return report.running
    ? report.loggingEnabled
      ? `🟢 Bridge 进程正在运行，PID: ${report.pid}\n运行状态: ${runtimeStatus}\n标准日志: ${report.stdoutLog}\n错误日志: ${report.stderrLog}\n`
      : `🟢 Bridge 进程正在运行，PID: ${report.pid}\n运行状态: ${runtimeStatus}\n日志: 已关闭\n`
    : '🔴 Bridge 当前未在后台运行。\n';
}

function formatStarted(report: BackgroundServiceReport, action: string): string {
  return report.loggingEnabled
    ? `✅ Bridge 已${action}，PID: ${report.pid}\n标准日志: ${report.stdoutLog}\n错误日志: ${report.stderrLog}\n`
    : `✅ Bridge 已${action}，PID: ${report.pid}\n日志: 已关闭\n`;
}
