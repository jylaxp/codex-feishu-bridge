import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { materializeLegacyBotFromEnvironment } from './bot-config-store';
import { ConfigurationError, resolveConfigHome } from './config';

export const CONFIG_FILE_NAME = 'config.toml';
export const LEGACY_ENV_FILE_NAME = '.env';
const CONFIG_SCHEMA_VERSION = 1;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

export interface ConfigFileOptions {
  readonly homeDirectory?: string;
}

export interface BridgeConfigPaths {
  readonly configHome: string;
  readonly configPath: string;
  readonly legacyEnvPath: string;
}

export interface BridgeConfigDocument {
  readonly schemaVersion: number;
  readonly approval: {
    readonly summaryMode: boolean;
  };
  readonly appServer: {
    readonly mode: string;
    readonly socketPath: string | null;
  };
  readonly codex: {
    readonly bin: string;
    readonly cwd: string;
    readonly allowedShellCommands: readonly string[];
  };
  readonly card: {
    readonly maxTextLength: number;
    readonly updateIntervalMs: number;
  };
  readonly queue: {
    readonly maxQueuedTasks: number;
  };
  readonly usage: {
    readonly rateLimitQueryIntervalMs: number;
  };
  readonly logging: {
    readonly toFile: boolean;
    readonly filePath: string | null;
  };
  readonly files: {
    readonly enableAutoFileUpload: boolean;
  };
}

interface LegacyLarkConfigDocument {
  readonly appId: string;
  readonly appSecret: string;
  readonly tenantKey: string;
  readonly allowedChats: readonly string[];
  readonly authorizedUsers: readonly string[];
  readonly allowedApprovers: readonly string[];
  readonly allowGroupUserMentions: boolean;
  readonly allowExternalGroupUserMentions: boolean;
  readonly allowGroupBotMentions: boolean;
}

type ParsedBridgeConfigDocument = BridgeConfigDocument & {
  readonly legacyLark?: LegacyLarkConfigDocument;
};

/**
 * Loads `config.toml` as the current editable config format. Legacy
 * `.env` files are one-time migration sources.
 */
export function loadBridgeEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  options: ConfigFileOptions = {},
): NodeJS.ProcessEnv {
  const paths = bridgeConfigPaths(resolveConfigHome(baseEnv, options.homeDirectory));
  const persisted = readOrMigratePersistedEnvironment(paths);
  return { ...persisted, ...baseEnv };
}

export function bridgeConfigPaths(configHome: string): BridgeConfigPaths {
  return Object.freeze({
    configHome,
    configPath: join(configHome, CONFIG_FILE_NAME),
    legacyEnvPath: join(configHome, LEGACY_ENV_FILE_NAME),
  });
}

export function configFileExists(configHome: string): boolean {
  return existsSync(bridgeConfigPaths(configHome).configPath);
}

export function readOrMigratePersistedEnvironment(paths: BridgeConfigPaths): NodeJS.ProcessEnv {
  if (existsSync(paths.configPath)) {
    const document = readConfigDocument(paths.configPath);
    const env = configDocumentToEnvironment(document);
    materializeLegacyBotFromEnvironment(paths.configHome, env);
    if (document.legacyLark) {
      writeBridgeConfigFile(paths.configHome, env);
    }
    removeLegacyEnvironmentFile(paths);
    return env;
  }
  if (!existsSync(paths.legacyEnvPath)) {
    return {};
  }
  const legacyEnv = readLegacyEnvironmentFile(paths);
  materializeLegacyBotFromEnvironment(paths.configHome, legacyEnv);
  writeBridgeConfigFile(paths.configHome, legacyEnv);
  removeLegacyEnvironmentFile(paths);
  return legacyEnv;
}

export function readConfigFileEnvironment(paths: BridgeConfigPaths): NodeJS.ProcessEnv {
  assertPrivateConfigFile(paths.configPath, 'Bridge config.toml');
  return configDocumentToEnvironment(readConfigDocument(paths.configPath));
}

export function readLegacyEnvironmentFile(paths: BridgeConfigPaths): NodeJS.ProcessEnv {
  assertRegularFile(paths.legacyEnvPath, 'Bridge legacy .env');
  return parseEnvironmentSource(readFileSync(paths.legacyEnvPath, 'utf8'), paths.legacyEnvPath);
}

export function writeBridgeConfigFile(configHome: string, env: NodeJS.ProcessEnv): void {
  if (!configHome.trim()) {
    throw new ConfigurationError('config home must not be blank');
  }
  if (existsSync(configHome)) {
    const stat = lstatSync(configHome);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConfigurationError('BRIDGE_CONFIG_HOME must be a real directory, not a symlink');
    }
  } else {
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
  }
  const { configPath } = bridgeConfigPaths(configHome);
  if (existsSync(configPath)) {
    assertRegularFile(configPath, 'Bridge config.toml');
  }
  const serialized = serializeConfigDocument(environmentToConfigDocument(env));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigurationError('config.toml would exceed the maximum allowed size');
  }
  const temporaryPath = `${configPath}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    writeFileSync(descriptor, serialized, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, configPath);
    syncDirectory(configHome);
  } catch {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Missing temp files are already clean.
    }
    throw new ConfigurationError('config.toml could not be written');
  }
}

/** Parses Bridge dotenv syntax for one-time migration from legacy `.env`. */
export function parseEnvironmentSource(source: string, sourceName: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      throw new ConfigurationError(`${sourceName}:${index + 1} is not a valid environment assignment`);
    }
    parsed[assignment[1]!] = parseValue(assignment[2]!, sourceName, index + 1);
  }
  return parsed;
}

export function environmentToConfigDocument(env: NodeJS.ProcessEnv): BridgeConfigDocument {
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    approval: Object.freeze({
      summaryMode: stringValue(env.APPROVAL_SUMMARY_MODE, '0') === '1',
    }),
    appServer: Object.freeze({
      mode: stringValue(env.APP_SERVER_MODE, 'owned_stdio'),
      socketPath: optionalString(env.APP_SERVER_SOCKET_PATH),
    }),
    codex: Object.freeze({
      bin: stringValue(env.CODEX_BIN, '/absolute/path/to/codex'),
      cwd: stringValue(env.CODEX_CWD),
      allowedShellCommands: listValue(env.ALLOWED_SHELL_COMMANDS || 'ls,pwd,git,find,cd'),
    }),
    card: Object.freeze({
      maxTextLength: integerEnvValue(env.MAX_TEXT_LENGTH, 10_000),
      updateIntervalMs: integerEnvValue(env.CARD_UPDATE_INTERVAL_MS, 1_500),
    }),
    queue: Object.freeze({
      maxQueuedTasks: integerEnvValue(env.MAX_QUEUED_TASKS, 100),
    }),
    usage: Object.freeze({
      rateLimitQueryIntervalMs: integerEnvValue(env.RATE_LIMIT_QUERY_INTERVAL_MS, 300_000),
    }),
    logging: Object.freeze({
      toFile: booleanEnvValue(env.LOG_TO_FILE, false),
      filePath: optionalString(env.LOG_FILE_PATH) ?? 'bridge.log',
    }),
    files: Object.freeze({
      enableAutoFileUpload: booleanEnvValue(env.ENABLE_AUTO_FILE_UPLOAD, false),
    }),
  });
}

function serializeConfigDocument(document: BridgeConfigDocument): string {
  return `${[
    '# Codex Feishu Bridge process configuration.',
    '# Channel credentials are stored under channels/<channel>/, not in this file.',
    '# See config.example.toml for field-level comments.',
    '',
  ].join('\n')}${stringifyToml(document)}\n`;
}

function readConfigDocument(configPath: string): ParsedBridgeConfigDocument {
  assertPrivateConfigFile(configPath, 'Bridge config.toml');
  const stat = lstatSync(configPath);
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigurationError('config.toml exceeds the maximum allowed size');
  }
  try {
    return parseConfigDocument(parseToml(readFileSync(configPath, { encoding: 'utf8' })), 'config.toml');
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError('config.toml is not valid TOML');
  }
}

function parseConfigDocument(value: unknown, sourceName: string): ParsedBridgeConfigDocument {
  const document = recordValue(value, sourceName);
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(`${sourceName} schema version is unsupported`);
  }
  const approval = recordValue(document.approval, `${sourceName}.approval`);
  const appServer = recordValue(document.appServer, `${sourceName}.appServer`);
  const codex = recordValue(document.codex, `${sourceName}.codex`);
  const card = recordValue(document.card, `${sourceName}.card`);
  const queue = recordValue(document.queue, `${sourceName}.queue`);
  const usage = recordValue(document.usage, `${sourceName}.usage`);
  const logging = recordValue(document.logging, `${sourceName}.logging`);
  const files = recordValue(document.files, `${sourceName}.files`);
  const legacyLark = document.lark === undefined
    ? undefined
    : parseLegacyLarkConfig(recordValue(document.lark, `${sourceName}.lark`), `${sourceName}.lark`);
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    approval: Object.freeze({
      summaryMode: jsonBoolean(approval.summaryMode, `${sourceName}.approval.summaryMode`),
    }),
    appServer: Object.freeze({
      mode: requiredString(appServer.mode, `${sourceName}.appServer.mode`),
      socketPath: optionalJsonString(appServer.socketPath, `${sourceName}.appServer.socketPath`),
    }),
    codex: Object.freeze({
      bin: requiredString(codex.bin, `${sourceName}.codex.bin`),
      cwd: optionalJsonString(codex.cwd, `${sourceName}.codex.cwd`) ?? '',
      allowedShellCommands: jsonStringArray(codex.allowedShellCommands, `${sourceName}.codex.allowedShellCommands`),
    }),
    card: Object.freeze({
      maxTextLength: jsonInteger(card.maxTextLength, `${sourceName}.card.maxTextLength`),
      updateIntervalMs: jsonInteger(card.updateIntervalMs, `${sourceName}.card.updateIntervalMs`),
    }),
    queue: Object.freeze({
      maxQueuedTasks: jsonInteger(queue.maxQueuedTasks, `${sourceName}.queue.maxQueuedTasks`),
    }),
    usage: Object.freeze({
      rateLimitQueryIntervalMs: jsonInteger(
        usage.rateLimitQueryIntervalMs,
        `${sourceName}.usage.rateLimitQueryIntervalMs`,
      ),
    }),
    logging: Object.freeze({
      toFile: jsonBoolean(logging.toFile, `${sourceName}.logging.toFile`),
      filePath: optionalJsonString(logging.filePath, `${sourceName}.logging.filePath`),
    }),
    files: Object.freeze({
      enableAutoFileUpload: jsonBoolean(files.enableAutoFileUpload, `${sourceName}.files.enableAutoFileUpload`),
    }),
    ...(legacyLark ? { legacyLark } : {}),
  });
}

function parseLegacyLarkConfig(lark: Record<string, unknown>, sourceName: string): LegacyLarkConfigDocument {
  return Object.freeze({
    appId: requiredString(lark.appId, `${sourceName}.appId`),
    appSecret: requiredString(lark.appSecret, `${sourceName}.appSecret`),
    tenantKey: optionalJsonString(lark.tenantKey, `${sourceName}.tenantKey`) ?? '',
    allowedChats: jsonStringArray(lark.allowedChats, `${sourceName}.allowedChats`),
    authorizedUsers: jsonStringArray(lark.authorizedUsers, `${sourceName}.authorizedUsers`),
    allowedApprovers: jsonStringArray(lark.allowedApprovers, `${sourceName}.allowedApprovers`),
    allowGroupUserMentions: jsonBoolean(lark.allowGroupUserMentions, `${sourceName}.allowGroupUserMentions`),
    allowExternalGroupUserMentions: jsonBoolean(
      lark.allowExternalGroupUserMentions,
      `${sourceName}.allowExternalGroupUserMentions`,
    ),
    allowGroupBotMentions: jsonBoolean(lark.allowGroupBotMentions, `${sourceName}.allowGroupBotMentions`),
  });
}

function configDocumentToEnvironment(document: ParsedBridgeConfigDocument): NodeJS.ProcessEnv {
  return {
    ...(document.legacyLark ? {
      LARK_APP_ID: document.legacyLark.appId,
      LARK_APP_SECRET: document.legacyLark.appSecret,
      LARK_TENANT_KEY: document.legacyLark.tenantKey,
      ALLOWED_CHATS: document.legacyLark.allowedChats.join(','),
      AUTHORIZED_USERS: document.legacyLark.authorizedUsers.join(','),
      ALLOWED_APPROVERS: document.legacyLark.allowedApprovers.join(','),
      ALLOW_GROUP_USER_MENTIONS: `${document.legacyLark.allowGroupUserMentions}`,
      ALLOW_EXTERNAL_GROUP_USER_MENTIONS: `${document.legacyLark.allowExternalGroupUserMentions}`,
      ALLOW_GROUP_BOT_MENTIONS: `${document.legacyLark.allowGroupBotMentions}`,
    } : {}),
    APPROVAL_SUMMARY_MODE: document.approval.summaryMode ? '1' : '0',
    APP_SERVER_MODE: document.appServer.mode,
    ...(document.appServer.socketPath ? { APP_SERVER_SOCKET_PATH: document.appServer.socketPath } : {}),
    CODEX_BIN: document.codex.bin,
    CODEX_CWD: document.codex.cwd,
    ALLOWED_SHELL_COMMANDS: document.codex.allowedShellCommands.join(','),
    MAX_TEXT_LENGTH: `${document.card.maxTextLength}`,
    CARD_UPDATE_INTERVAL_MS: `${document.card.updateIntervalMs}`,
    MAX_QUEUED_TASKS: `${document.queue.maxQueuedTasks}`,
    RATE_LIMIT_QUERY_INTERVAL_MS: `${document.usage.rateLimitQueryIntervalMs}`,
    LOG_TO_FILE: `${document.logging.toFile}`,
    ...(document.logging.filePath ? { LOG_FILE_PATH: document.logging.filePath } : {}),
    ENABLE_AUTO_FILE_UPLOAD: `${document.files.enableAutoFileUpload}`,
  };
}

function assertRegularFile(path: string, label: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConfigurationError(`${label} must be a regular file, not a symlink`);
  }
  return stat;
}

function assertPrivateConfigFile(path: string, label: string): void {
  const stat = assertRegularFile(path, label);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new ConfigurationError(`${label} must not be readable or writable by group or others`);
  }
}

function removeLegacyEnvironmentFile(paths: BridgeConfigPaths): void {
  if (!existsSync(paths.legacyEnvPath)) {
    return;
  }
  const stat = lstatSync(paths.legacyEnvPath);
  if (stat.isDirectory()) {
    throw new ConfigurationError('Bridge legacy .env must not be a directory');
  }
  try {
    unlinkSync(paths.legacyEnvPath);
  } catch {
    throw new ConfigurationError('Bridge legacy .env could not be removed after config.toml migration');
  }
}

function parseValue(raw: string, sourceName: string, lineNumber: number): string {
  if (!raw) {
    return '';
  }
  if (raw.startsWith("'")) {
    return parseQuotedValue(raw, "'", sourceName, lineNumber);
  }
  if (raw.startsWith('"')) {
    return decodeDoubleQuotedValue(parseQuotedValue(raw, '"', sourceName, lineNumber));
  }
  const commentIndex = raw.search(/\s#/);
  return (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trim();
}

function parseQuotedValue(
  raw: string,
  quote: string,
  sourceName: string,
  lineNumber: number,
): string {
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      const trailing = raw.slice(index + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        throw new ConfigurationError(`${sourceName}:${lineNumber} has invalid trailing content`);
      }
      return raw.slice(1, index);
    }
    escaped = false;
  }
  throw new ConfigurationError(`${sourceName}:${lineNumber} has an unterminated quoted value`);
}

function decodeDoubleQuotedValue(value: string): string {
  return value.replace(/\\([\\"nrt])/g, (_match, escape: string) => {
    if (escape === 'n') {
      return '\n';
    }
    if (escape === 'r') {
      return '\r';
    }
    if (escape === 't') {
      return '\t';
    }
    return escape;
  });
}

function stringValue(value: string | undefined, fallback = ''): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function optionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function listValue(value: string | undefined): readonly string[] {
  const raw = value?.trim();
  if (!raw) {
    return Object.freeze([]);
  }
  return Object.freeze([...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]);
}

function booleanEnvValue(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new ConfigurationError('config boolean environment values must be true or false');
}

function integerEnvValue(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new ConfigurationError('config integer environment values must be unsigned integers');
  }
  const integer = Number(normalized);
  if (!Number.isSafeInteger(integer)) {
    throw new ConfigurationError('config integer environment values must be safe integers');
  }
  return integer;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigurationError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalJsonString(value, label);
  if (!normalized) {
    throw new ConfigurationError(`${label} must not be blank`);
  }
  return normalized;
}

function optionalJsonString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ConfigurationError(`${label} must be a string or null`);
  }
  return value.trim();
}

function jsonStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be an array`);
  }
  return Object.freeze(value.map((item, index) => requiredString(item, `${label}[${index}]`)));
}

function jsonBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${label} must be a boolean`);
  }
  return value;
}

function jsonInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is best-effort on filesystems that support it.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function noFollowFlag(): number {
  if (process.platform === 'win32') {
    return 0;
  }
  return (constants as typeof constants & { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}
