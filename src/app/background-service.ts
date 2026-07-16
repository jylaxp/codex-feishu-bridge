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

const STOP_WAIT_MS = 2_000;
const STOP_POLL_MS = 100;
const UPDATE_REPOSITORY = 'git+https://github.com/jylaxp/codex-feishu-bridge.git';

export type BackgroundCommand = 'start' | 'restart' | 'stop' | 'status' | 'update';

export interface BackgroundServiceOptions {
  readonly configHome?: string;
  readonly forceUpdate?: boolean;
  readonly entryPath?: string;
  readonly spawnProcess?: typeof spawn;
  readonly executeFile?: typeof execFileSync;
  readonly output?: { write(chunk: string): unknown };
}

export interface BackgroundServiceReport {
  readonly command: BackgroundCommand;
  readonly running: boolean;
  readonly pid: number | null;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

/** Implements the original PID/log based background lifecycle. */
export async function runBackgroundCommand(
  command: BackgroundCommand,
  options: BackgroundServiceOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<BackgroundServiceReport> {
  const paths = servicePaths(options.configHome ?? resolveConfigHome(baseEnv));
  const output = options.output ?? process.stdout;
  if (command === 'status') {
    const report = statusReport(command, paths);
    output.write(formatStatus(report));
    return report;
  }
  if (command === 'stop') {
    const report = await stopService(paths);
    output.write(report.running ? '❌ Bridge 未能停止。\n' : '✅ Bridge 后台服务已停止。\n');
    return report;
  }
  if (command === 'restart') {
    await stopService(paths);
    const report = startService(paths, options, baseEnv, 'restart');
    output.write(formatStarted(report, '重启'));
    return report;
  }
  if (command === 'update') {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '-g', UPDATE_REPOSITORY];
    if (options.forceUpdate) args.push('--force');
    (options.executeFile ?? execFileSync)(npm, args, { stdio: 'inherit' });
    await stopService(paths);
    const report = startService(paths, options, baseEnv, 'update');
    output.write(formatStarted(report, '更新并重启'));
    return report;
  }
  const existing = statusReport('start', paths);
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
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(paths.stdoutLog, 'a', 0o600);
  const stderr = openSync(paths.stderrLog, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(
      process.execPath,
      [options.entryPath ?? resolve(__dirname, 'cli.js'), 'run'],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', stdout, stderr],
        env: { ...baseEnv, BRIDGE_CONFIG_HOME: paths.configHome },
      },
    );
  } finally {
    closeSync(stdout);
    closeSync(stderr);
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
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  };
}

async function stopService(paths: ServicePaths): Promise<BackgroundServiceReport> {
  const pid = readPid(paths.pidFile);
  if (!pid || !isPidRunning(pid)) {
    removePidFile(paths.pidFile);
    return statusReport('stop', paths);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePidFile(paths.pidFile);
    return statusReport('stop', paths);
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline && isPidRunning(pid)) {
    await delay(STOP_POLL_MS);
  }
  if (isPidRunning(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process may exit between the liveness check and the signal.
    }
  }
  removePidFile(paths.pidFile);
  return statusReport('stop', paths);
}

function statusReport(command: BackgroundCommand, paths: ServicePaths): BackgroundServiceReport {
  const pid = readPid(paths.pidFile);
  const running = pid !== null && isPidRunning(pid);
  if (pid !== null && !running) removePidFile(paths.pidFile);
  return {
    command,
    running,
    pid: running ? pid : null,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  };
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const value = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  return report.running
    ? `🟢 Bridge 正在运行，PID: ${report.pid}\n标准日志: ${report.stdoutLog}\n错误日志: ${report.stderrLog}\n`
    : '🔴 Bridge 当前未在后台运行。\n';
}

function formatStarted(report: BackgroundServiceReport, action: string): string {
  return `✅ Bridge 已${action}，PID: ${report.pid}\n标准日志: ${report.stdoutLog}\n错误日志: ${report.stderrLog}\n`;
}
