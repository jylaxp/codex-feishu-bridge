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

function requireAbsolutePath(env: NodeJS.ProcessEnv, key: string): string {
  const value = requireValue(env, key);
  if (!path.isAbsolute(value)) {
    throw new ConfigurationError(`${key} must be an absolute path`);
  }
  return path.normalize(value);
}

function configHome(env: NodeJS.ProcessEnv): string {
  const configured = env.BRIDGE_CONFIG_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new ConfigurationError('BRIDGE_CONFIG_HOME must be an absolute path');
    }
    return path.normalize(configured);
  }
  return path.join(os.homedir(), '.codex-feishu-bridge');
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

function parseRequiredList(env: NodeJS.ProcessEnv, key: string): readonly string[] {
  const raw = requireValue(env, key);
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length === 0) {
    throw new ConfigurationError(`${key} must contain at least one value`);
  }
  return Object.freeze(uniqueValues);
}

function parseRequiredAbsolutePathList(env: NodeJS.ProcessEnv, key: string): readonly string[] {
  const values = parseRequiredList(env, key);
  const normalizedValues = values.map((value) => {
    if (!path.isAbsolute(value)) {
      throw new ConfigurationError(`${key} entries must be absolute paths`);
    }
    return path.normalize(value);
  });
  return Object.freeze(normalizedValues);
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

/**
 * Parses environment values without touching the filesystem or mutating the
 * supplied environment object. Filesystem and runtime checks belong to
 * `runPreflight`.
 */
export function parseEnvironment(env: NodeJS.ProcessEnv): BridgeConfig {
  const appServer = parseAppServerMode(env);
  const config: BridgeConfig = {
    larkAppId: requireLarkAppId(env),
    larkAppSecret: requireValue(env, 'LARK_APP_SECRET'),
    larkTenantKey: requireValue(env, 'LARK_TENANT_KEY'),
    allowedChats: parseRequiredList(env, 'ALLOWED_CHATS'),
    authorizedUsers: parseRequiredList(env, 'AUTHORIZED_USERS'),
    allowedApprovers: parseRequiredList(env, 'ALLOWED_APPROVERS'),
    ...appServer,
    codexBin: requireAbsolutePath(env, 'CODEX_BIN'),
    codexCwd: requireAbsolutePath(env, 'CODEX_CWD'),
    allowedWorkspaceRoots: parseRequiredAbsolutePathList(env, 'ALLOWED_WORKSPACE_ROOTS'),
    configHome: configHome(env),
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
  };

  return Object.freeze(config);
}
