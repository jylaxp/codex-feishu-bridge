import * as path from 'path';
import * as os from 'os';
import { BridgeConfig } from './domain';

export const MIN_NODE_VERSION = '24.18.0';
export const MAX_NODE_MAJOR_EXCLUSIVE = 25;
export const DEFAULT_MAX_TEXT_LENGTH = 10_000;
export const MIN_TEXT_LENGTH = 1_000;
export const MAX_TEXT_LENGTH = 20_000;
export const DEFAULT_CARD_UPDATE_INTERVAL_MS = 1_500;
export const MIN_CARD_UPDATE_INTERVAL_MS = 1_000;
export const MAX_CARD_UPDATE_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_QUEUED_TASKS = 100;
export const MIN_QUEUED_TASKS = 1;
export const MAX_QUEUED_TASKS = 1_000;
export const DEFAULT_RATE_LIMIT_QUERY_INTERVAL_MS = 300_000;
export const MIN_RATE_LIMIT_QUERY_INTERVAL_MS = 1_000;
export const MAX_RATE_LIMIT_QUERY_INTERVAL_MS = 3_600_000;
const DEFAULT_SHELL_COMMANDS = Object.freeze(['ls', 'pwd', 'git', 'find', 'cd']);

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /^YOUR_/i.test(value)) {
    throw new ConfigurationError(`${key} is required`);
  }
  if (value.includes('\0')) {
    throw new ConfigurationError(`${key} contains an invalid null byte`);
  }
  return value;
}

function optionalValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /^YOUR_/i.test(value)) {
    return '';
  }
  if (value.includes('\0')) {
    throw new ConfigurationError(`${key} contains an invalid null byte`);
  }
  return value;
}

function requireAbsolutePath(env: NodeJS.ProcessEnv, key: string): string {
  const value = requireValue(env, key);
  if (!path.isAbsolute(value)) {
    throw new ConfigurationError(`${key} must be an absolute path`);
  }
  return path.normalize(value);
}

/** Resolves the portable configuration home before the full environment is parsed. */
export function resolveConfigHome(env: NodeJS.ProcessEnv, homeDirectory = os.homedir()): string {
  const configured = env.BRIDGE_CONFIG_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new ConfigurationError('BRIDGE_CONFIG_HOME must be an absolute path');
    }
    return path.normalize(configured);
  }
  return path.join(homeDirectory, '.codex-feishu-bridge');
}

function requireLarkAppId(env: NodeJS.ProcessEnv): string {
  const appId = requireValue(env, 'LARK_APP_ID');
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new ConfigurationError('LARK_APP_ID must match cli_ followed by 16 hexadecimal characters');
  }
  return appId;
}

function parseAppServerMode(
  env: NodeJS.ProcessEnv,
): Pick<BridgeConfig, 'appServerMode' | 'appServerSocketPath'> {
  const rawMode = env.APP_SERVER_MODE?.trim() || 'owned_stdio';
  if (rawMode !== 'owned_stdio' && rawMode !== 'managed_proxy') {
    throw new ConfigurationError('APP_SERVER_MODE must be owned_stdio or managed_proxy');
  }
  const rawSocketPath = env.APP_SERVER_SOCKET_PATH?.trim();
  if (rawSocketPath && !path.isAbsolute(rawSocketPath)) {
    throw new ConfigurationError('APP_SERVER_SOCKET_PATH must be an absolute path');
  }
  if (rawSocketPath && rawMode !== 'managed_proxy') {
    throw new ConfigurationError('APP_SERVER_SOCKET_PATH requires APP_SERVER_MODE=managed_proxy');
  }
  return {
    appServerMode: rawMode,
    appServerSocketPath: rawSocketPath ? path.normalize(rawSocketPath) : null,
  };
}

function parseOptionalList(env: NodeJS.ProcessEnv, key: string): readonly string[] {
  const raw = optionalValue(env, key);
  if (!raw) {
    return Object.freeze([]);
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Object.freeze([...new Set(values)]);
}

function parseAllowedShellCommands(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.ALLOWED_SHELL_COMMANDS?.trim();
  if (!raw) {
    return DEFAULT_SHELL_COMMANDS;
  }
  const commands = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (commands.length === 0 || commands.some((command) => !/^[a-z0-9][a-z0-9_.-]*$/.test(command))) {
    throw new ConfigurationError('ALLOWED_SHELL_COMMANDS entries must be executable basenames');
  }
  return Object.freeze(commands);
}

function parseBoundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseBoolean(env: NodeJS.ProcessEnv, key: string, defaultValue = false): boolean {
  const raw = env[key]?.trim();
  if (!raw) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new ConfigurationError(`${key} must be true or false`);
}

function parseLogFilePath(env: NodeJS.ProcessEnv): string | null {
  const value = env.LOG_FILE_PATH?.trim();
  if (!value) {
    return null;
  }
  if (value.includes('\0')) {
    throw new ConfigurationError('LOG_FILE_PATH contains an invalid null byte');
  }
  return value;
}

/**
 * Parses environment values without touching the filesystem or mutating the
 * supplied environment object. Filesystem and runtime checks belong to
 * `runPreflight`.
 */
export function parseEnvironment(env: NodeJS.ProcessEnv): BridgeConfig {
  const appServer = parseAppServerMode(env);
  const configHome = resolveConfigHome(env);
  const configuredCwd = optionalValue(env, 'CODEX_CWD');
  if (configuredCwd && !path.isAbsolute(configuredCwd)) {
    throw new ConfigurationError('CODEX_CWD must be an absolute path');
  }
  const config: BridgeConfig = {
    larkAppId: requireLarkAppId(env),
    larkAppSecret: requireValue(env, 'LARK_APP_SECRET'),
    larkTenantKey: optionalValue(env, 'LARK_TENANT_KEY'),
    allowedChats: parseOptionalList(env, 'ALLOWED_CHATS'),
    authorizedUsers: parseOptionalList(env, 'AUTHORIZED_USERS'),
    allowedApprovers: parseOptionalList(env, 'ALLOWED_APPROVERS'),
    allowedShellCommands: parseAllowedShellCommands(env),
    ...appServer,
    codexBin: requireAbsolutePath(env, 'CODEX_BIN'),
    codexCwd: configuredCwd ? path.normalize(configuredCwd) : configHome,
    configHome,
    maxTextLength: parseBoundedInteger(
      env,
      'MAX_TEXT_LENGTH',
      DEFAULT_MAX_TEXT_LENGTH,
      MIN_TEXT_LENGTH,
      MAX_TEXT_LENGTH,
    ),
    cardUpdateIntervalMs: parseBoundedInteger(
      env,
      'CARD_UPDATE_INTERVAL_MS',
      DEFAULT_CARD_UPDATE_INTERVAL_MS,
      MIN_CARD_UPDATE_INTERVAL_MS,
      MAX_CARD_UPDATE_INTERVAL_MS,
    ),
    maxQueuedTasks: parseBoundedInteger(
      env,
      'MAX_QUEUED_TASKS',
      DEFAULT_MAX_QUEUED_TASKS,
      MIN_QUEUED_TASKS,
      MAX_QUEUED_TASKS,
    ),
    rateLimitQueryIntervalMs: parseBoundedInteger(
      env,
      'RATE_LIMIT_QUERY_INTERVAL_MS',
      DEFAULT_RATE_LIMIT_QUERY_INTERVAL_MS,
      MIN_RATE_LIMIT_QUERY_INTERVAL_MS,
      MAX_RATE_LIMIT_QUERY_INTERVAL_MS,
    ),
    logToFile: parseBoolean(env, 'LOG_TO_FILE'),
    logFilePath: parseLogFilePath(env),
    enableAutoFileUpload: parseBoolean(env, 'ENABLE_AUTO_FILE_UPLOAD'),
  };

  return Object.freeze(config);
}
