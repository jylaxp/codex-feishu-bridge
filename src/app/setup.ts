/// <reference path="./types/qrcode-terminal.d.ts" />

import * as Lark from '@larksuiteoapi/node-sdk';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import { BindingStore } from './binding-store';
import { ConfigurationError, resolveConfigHome } from './config';

const PLACEHOLDER_APP_ID = 'cli_0123456789abcdef';
const PLACEHOLDER_SECRET = 'replace_me';

type RegisterAppOptions = Parameters<typeof Lark.registerApp>[0];
type RegisterAppResult = Awaited<ReturnType<typeof Lark.registerApp>>;

export interface SetupOptions {
  readonly configHome?: string;
  readonly rebind?: boolean;
  readonly stdout?: OutputWriter;
  readonly registerApp?: (options: RegisterAppOptions) => Promise<RegisterAppResult>;
  readonly qrRenderer?: (url: string) => Promise<void> | void;
}

export interface OutputWriter {
  write(chunk: string): unknown;
}

export interface SetupReport {
  readonly configHome: string;
  readonly envPath: string;
  readonly appId: string;
  readonly qrRegistered: boolean;
  readonly missingRequiredValues: readonly string[];
}

/** Creates the original editable configuration skeleton without starting QR registration. */
export function initializeSetupFiles(
  configHomeOption: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SetupReport {
  const configHome = configHomeOption
    ? requireAbsolutePath(configHomeOption, 'config home')
    : resolveConfigHome(baseEnv);
  const envPath = join(configHome, '.env');
  ensureConfigDirectory(configHome);
  let source = readEnvironmentFileIfPresent(envPath);
  source = ensureDefaultEnvironment(source, {
    cwd: normalize(process.cwd()),
    codexBin: inferDefaultCodexBin(),
  });
  writeFileSync(envPath, source, { encoding: 'utf8', mode: 0o600 });
  ensureBindingsFile(configHome);
  return Object.freeze({
    configHome,
    envPath,
    appId: readEnvValue(source, 'LARK_APP_ID') ?? '',
    qrRegistered: false,
    missingRequiredValues: Object.freeze(requiredKeysWithPlaceholders(source)),
  });
}

/**
 * Creates or updates the private Bridge configuration file and, when needed,
 * runs the Feishu/Lark one-click app registration flow.
 */
export async function runSetup(
  options: SetupOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<SetupReport> {
  const output = options.stdout ?? process.stdout;
  const configHome = options.configHome
    ? requireAbsolutePath(options.configHome, 'config home')
    : resolveConfigHome(baseEnv);
  const envPath = join(configHome, '.env');
  ensureConfigDirectory(configHome);

  let source = readEnvironmentFileIfPresent(envPath);
  const currentAppId = readEnvValue(source, 'LARK_APP_ID') ?? baseEnv.LARK_APP_ID ?? '';
  const currentAppSecret = readEnvValue(source, 'LARK_APP_SECRET') ?? baseEnv.LARK_APP_SECRET ?? '';
  const shouldRegister = options.rebind === true
    || isPlaceholder(currentAppId, PLACEHOLDER_APP_ID)
    || isPlaceholder(currentAppSecret, PLACEHOLDER_SECRET);

  let appId = currentAppId.trim();
  let appSecret = currentAppSecret.trim();
  if (shouldRegister) {
    const result = await registerFeishuApp({
      output,
      registerApp: options.registerApp ?? Lark.registerApp,
      qrRenderer: options.qrRenderer ?? renderQrCode,
    });
    appId = result.client_id.trim();
    appSecret = result.client_secret.trim();
    source = setEnvValue(source, 'LARK_APP_ID', appId);
    source = setEnvValue(source, 'LARK_APP_SECRET', appSecret);
  } else {
    source = setEnvValue(source, 'LARK_APP_ID', appId);
    source = setEnvValue(source, 'LARK_APP_SECRET', appSecret);
  }

  source = ensureDefaultEnvironment(source, {
    cwd: normalize(process.cwd()),
    codexBin: inferDefaultCodexBin(),
  });
  writeFileSync(envPath, source, { encoding: 'utf8', mode: 0o600 });
  ensureBindingsFile(configHome);

  const missingRequiredValues = requiredKeysWithPlaceholders(source);
  output.write([
    '',
    shouldRegister ? '✅ 飞书应用扫码绑定已完成。' : '✅ 飞书应用凭证已存在，跳过扫码绑定。',
    `配置文件: ${envPath}`,
    missingRequiredValues.length > 0
      ? `仍需填写: ${missingRequiredValues.join(', ')}`
      : '必填配置已齐全，可以运行 doctor/run。',
    '',
  ].join('\n'));

  return Object.freeze({
    configHome,
    envPath,
    appId,
    qrRegistered: shouldRegister,
    missingRequiredValues: Object.freeze(missingRequiredValues),
  });
}

function ensureBindingsFile(configHome: string): void {
  const store = new BindingStore(configHome);
  if (!existsSync(store.filePath)) {
    writeFileSync(store.filePath, '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    return;
  }
  const stat = lstatSync(store.filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConfigurationError('bindings.json must be a regular file, not a symlink');
  }
  store.load();
}

function ensureConfigDirectory(configHome: string): void {
  if (existsSync(configHome)) {
    const stat = lstatSync(configHome);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConfigurationError('BRIDGE_CONFIG_HOME must be a real directory, not a symlink');
    }
    return;
  }
  mkdirSync(configHome, { recursive: true, mode: 0o700 });
}

function readEnvironmentFileIfPresent(envPath: string): string {
  if (!existsSync(envPath)) {
    const parent = dirname(envPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    return '';
  }
  const stat = lstatSync(envPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConfigurationError('Bridge .env must be a regular file, not a symlink');
  }
  return readFileSync(envPath, 'utf8');
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value.trim()) {
    throw new ConfigurationError(`${label} must not be blank`);
  }
  if (!value.startsWith('/')) {
    throw new ConfigurationError(`${label} must be an absolute path`);
  }
  return normalize(value);
}

function isPlaceholder(value: string, exactPlaceholder: string): boolean {
  const normalized = value.trim();
  return !normalized
    || normalized === exactPlaceholder
    || /^YOUR_/i.test(normalized)
    || normalized.toLowerCase() === 'replace_me'
    || normalized.toLowerCase() === 'tenant_key'
    || normalized.toLowerCase().endsWith('_xxx');
}

function readEnvValue(source: string, key: string): string | undefined {
  const escaped = escapeRegExp(key);
  const match = new RegExp(`^(?:export\\s+)?${escaped}\\s*=\\s*(.*)$`, 'm').exec(source);
  if (!match) {
    return undefined;
  }
  return unquoteEnvValue(match[1]!.trim());
}

function setEnvValue(source: string, key: string, value: string): string {
  const line = `${key}=${formatEnvValue(value)}`;
  const escaped = escapeRegExp(key);
  const pattern = new RegExp(`^(?:export\\s+)?${escaped}\\s*=.*$`, 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  return appendLine(source, line);
}

function ensureDefaultEnvironment(
  source: string,
  defaults: {
    readonly cwd: string;
    readonly codexBin: string;
  },
): string {
  let next = source;
  const defaultValues: readonly [string, string][] = [
    ['BRIDGE_CONFIG_VERSION', '2'],
    ['LARK_APP_ID', PLACEHOLDER_APP_ID],
    ['LARK_APP_SECRET', PLACEHOLDER_SECRET],
    ['LARK_TENANT_KEY', ''],
    ['ALLOWED_CHATS', ''],
    ['AUTHORIZED_USERS', ''],
    ['ALLOWED_APPROVERS', ''],
    ['APP_SERVER_MODE', 'owned_stdio'],
    ['CODEX_BIN', defaults.codexBin],
    ['CODEX_CWD', defaults.cwd],
    ['ALLOWED_WORKSPACE_ROOTS', defaults.cwd],
    ['MAX_TEXT_LENGTH', '10000'],
    ['CARD_UPDATE_INTERVAL_MS', '1500'],
    ['MAX_QUEUED_TASKS', '100'],
    ['RATE_LIMIT_QUERY_INTERVAL_MS', '300000'],
    ['LOG_TO_FILE', 'false'],
    ['LOG_FILE_PATH', 'bridge.log'],
    ['ENABLE_AUTO_FILE_UPLOAD', 'false'],
  ];
  for (const [key, value] of defaultValues) {
    if (!hasEnvAssignment(next, key)) {
      next = appendLine(next, `${key}=${formatEnvValue(value)}`);
    }
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

function hasEnvAssignment(source: string, key: string): boolean {
  return new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`, 'm').test(source);
}

function requiredKeysWithPlaceholders(source: string): readonly string[] {
  const required = [
    ['LARK_APP_ID', PLACEHOLDER_APP_ID],
    ['LARK_APP_SECRET', PLACEHOLDER_SECRET],
    ['CODEX_BIN', '/absolute/path/to/codex'],
    ['CODEX_CWD', '/absolute/path/to/project'],
    ['ALLOWED_WORKSPACE_ROOTS', '/absolute/path/to/project'],
  ] as const;
  return required
    .filter(([key, placeholder]) => isPlaceholder(readEnvValue(source, key) ?? '', placeholder))
    .map(([key]) => key);
}

async function registerFeishuApp(options: {
  readonly output: OutputWriter;
  readonly registerApp: (options: RegisterAppOptions) => Promise<RegisterAppResult>;
  readonly qrRenderer: (url: string) => Promise<void> | void;
}): Promise<RegisterAppResult> {
  options.output.write([
    '',
    '==================================================================',
    '需要扫码创建或重新绑定飞书应用。',
    '请使用飞书客户端扫描下方二维码，或打开打印出的授权链接。',
    '==================================================================',
    '',
  ].join('\n'));

  const result = await options.registerApp({
    source: 'codex-feishu-bridge',
    onQRCodeReady(info) {
      options.output.write(`授权链接: ${info.url}\n`);
      options.output.write(`有效期: ${info.expireIn} 秒\n\n`);
      void options.qrRenderer(info.url);
      options.output.write('\n');
    },
    onStatusChange(info) {
      options.output.write(`扫码状态: ${info.status}\n`);
    },
    appPreset: {
      name: 'Codex Control Bot ({user})',
      desc: 'Codex Desktop remote control bot for {user}.',
    },
  });
  if (!result.client_id.trim() || !result.client_secret.trim()) {
    throw new ConfigurationError('Feishu app registration did not return app credentials');
  }
  return result;
}

async function renderQrCode(url: string): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  qrcode.generate(url, { small: true });
}

function appendLine(source: string, line: string): string {
  if (!source) {
    return `${line}\n`;
  }
  return `${source.endsWith('\n') ? source : `${source}\n`}${line}\n`;
}

function formatEnvValue(value: string): string {
  if (!/[#\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquoteEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferDefaultCodexBin(): string {
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? '/absolute/path/to/codex';
}
