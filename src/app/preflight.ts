import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_NODE_MAJOR_EXCLUSIVE,
  MIN_NODE_VERSION,
} from './config';
import {
  BridgeConfig,
  PreflightResult,
  RuntimeDirectoryLayout,
} from './domain';
import { buildCodexEnvironment } from './codex/environment';

export class PreflightError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface PreflightOptions {
  readonly nodeVersion?: string;
}

export interface CodexSpawnOptions {
  readonly env?: NodeJS.ProcessEnv;
}

function parseNodeVersion(value: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new PreflightError(`Unsupported Node.js version format: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function assertSupportedNodeVersion(nodeVersion: string = process.versions.node): void {
  const actual = parseNodeVersion(nodeVersion);
  const minimum = parseNodeVersion(MIN_NODE_VERSION);
  if (compareVersion(actual, minimum) < 0 || actual.major >= MAX_NODE_MAJOR_EXCLUSIVE) {
    const supportedRange = `>=${MIN_NODE_VERSION} <${MAX_NODE_MAJOR_EXCLUSIVE}.0.0`;
    throw new PreflightError(
      `Node.js ${supportedRange} is required; got ${nodeVersion}`,
    );
  }
}

function assertAbsolutePath(value: string, fieldName: string): void {
  if (!path.isAbsolute(value)) {
    throw new PreflightError(`${fieldName} must be an absolute path`);
  }
}

function canonicalDirectory(value: string, fieldName: string): string {
  assertAbsolutePath(value, fieldName);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(value);
  } catch (error) {
    throw new PreflightError(`${fieldName} cannot be resolved: ${(error as Error).message}`);
  }
  const stat = fs.statSync(canonicalPath);
  if (!stat.isDirectory()) {
    throw new PreflightError(`${fieldName} must resolve to a directory`);
  }
  return canonicalPath;
}

function canonicalExecutable(value: string): string {
  assertAbsolutePath(value, 'CODEX_BIN');
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(value);
    const stat = fs.statSync(canonicalPath);
    if (!stat.isFile()) {
      throw new PreflightError('CODEX_BIN must resolve to a regular file');
    }
    fs.accessSync(canonicalPath, fs.constants.X_OK);
  } catch (error) {
    if (error instanceof PreflightError) {
      throw error;
    }
    throw new PreflightError(`CODEX_BIN must resolve to an executable file: ${(error as Error).message}`);
  }
  return canonicalPath;
}

function canonicalManagedSocket(value: string): string {
  assertAbsolutePath(value, 'APP_SERVER_SOCKET_PATH');
  const socketPath = path.normalize(value);
  const parentPath = path.dirname(socketPath);
  try {
    const socketLstat = fs.lstatSync(socketPath);
    if (socketLstat.isSymbolicLink() || !socketLstat.isSocket()) {
      throw new PreflightError('APP_SERVER_SOCKET_PATH must be a Unix socket, not a symlink');
    }
    const socketStat = fs.statSync(socketPath);
    const parentStat = fs.statSync(parentPath);
    if (typeof process.getuid === 'function') {
      const currentUid = process.getuid();
      if (socketStat.uid !== currentUid || parentStat.uid !== currentUid) {
        throw new PreflightError('APP_SERVER_SOCKET_PATH must be owned by the current user');
      }
    }
    if ((socketStat.mode & 0o077) !== 0) {
      throw new PreflightError('APP_SERVER_SOCKET_PATH must not be group/world accessible');
    }
    if ((parentStat.mode & 0o022) !== 0) {
      throw new PreflightError('APP_SERVER_SOCKET_PATH parent must not be group/world writable');
    }
    return fs.realpathSync.native(socketPath);
  } catch (error) {
    if (error instanceof PreflightError) {
      throw error;
    }
    throw new PreflightError(
      `APP_SERVER_SOCKET_PATH cannot be trusted: ${(error as Error).message}`,
    );
  }
}

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath));
}

function ensurePrivateDirectory(directoryPath: string): void {
  if (fs.existsSync(directoryPath)) {
    const stat = fs.lstatSync(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PreflightError(`${directoryPath} must be a real directory, not a symlink`);
    }
  } else {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(directoryPath, 0o700);
  }
  if (typeof process.getuid === 'function') {
    const stat = fs.statSync(directoryPath);
    if (stat.uid !== process.getuid()) {
      throw new PreflightError(`${directoryPath} must be owned by the current user`);
    }
  }
}

/** Prepares only the minimal config home used by the current runtime. */
export function prepareConfigHome(configHome: string): string {
  assertAbsolutePath(configHome, 'BRIDGE_CONFIG_HOME');
  ensurePrivateDirectory(configHome);
  return fs.realpathSync.native(configHome);
}

/**
 * Validates runtime/filesystem prerequisites and returns a canonical immutable
 * configuration. No legacy state is read or migrated.
 */
export function runPreflight(
  config: BridgeConfig,
  options: PreflightOptions = {},
): PreflightResult {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  assertSupportedNodeVersion(nodeVersion);

  const configHome = prepareConfigHome(config.configHome ?? '');
  const codexBin = canonicalExecutable(config.codexBin);
  const codexCwd = canonicalDirectory(config.codexCwd, 'CODEX_CWD');
  const appServerSocketPath = config.appServerSocketPath
    ? canonicalManagedSocket(config.appServerSocketPath)
    : null;

  const runtimeDirectory: RuntimeDirectoryLayout = Object.freeze({
    rootDir: configHome,
    temporaryDir: fs.realpathSync.native(os.tmpdir()),
  });

  const canonicalConfig: BridgeConfig = Object.freeze({
    ...config,
    codexBin,
    codexCwd,
    appServerSocketPath,
    configHome,
  });

  return Object.freeze({
    config: canonicalConfig,
    configHome,
    runtimeDirectory,
    nodeVersion,
  });
}

/** Starts Codex with an argv array and an explicit `shell: false` boundary. */
export function spawnCodexProcess(
  preflight: PreflightResult,
  args: readonly string[],
  options: CodexSpawnOptions = {},
): ChildProcessWithoutNullStreams {
  for (const argument of args) {
    if (argument.includes('\0')) {
      throw new PreflightError('Codex argument contains an invalid null byte');
    }
  }
  return spawn(preflight.config.codexBin, [...args], {
    cwd: preflight.config.codexCwd,
    env: { ...buildCodexEnvironment(options.env ?? process.env) },
    shell: false,
    stdio: 'pipe',
  });
}
