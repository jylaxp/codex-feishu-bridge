/// <reference path="./types/qrcode-terminal.d.ts" />

import * as Lark from '@larksuiteoapi/node-sdk';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { normalize } from 'node:path';

import { BindingStore } from './binding-store';
import {
  ConfigurationError,
  parseEnvironment,
  resolveConfigHome,
} from './config';
import { BotConfigStore } from './bot-config-store';
import {
  bridgeConfigPaths,
  readOrMigratePersistedEnvironment,
  writeBridgeConfigFile,
} from './config-file';

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
  readonly configPath: string;
  readonly appId: string;
  readonly qrRegistered: boolean;
  readonly missingRequiredValues: readonly string[];
}

/** Creates the editable JSON configuration skeleton without starting QR registration. */
export function initializeSetupFiles(
  configHomeOption: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SetupReport {
  const configHome = configHomeOption
    ? requireAbsolutePath(configHomeOption, 'config home')
    : resolveConfigHome(baseEnv);
  ensureConfigDirectory(configHome);
  const paths = bridgeConfigPaths(configHome);
  const configEnv = ensureDefaultEnvironment(
    readConfigurationSeed(paths, baseEnv),
    {
      cwd: configHome,
      codexBin: inferDefaultCodexBin(),
    },
  );
  writeBridgeConfigFile(configHome, configEnv);
  ensureBindingsFile(configHome);
  const botStore = new BotConfigStore(configHome);
  botStore.load(parseEnvironment(configEnv));
  const firstBot = botStore.list()[0];
  return Object.freeze({
    configHome,
    configPath: paths.configPath,
    appId: firstBot?.appId ?? '',
    qrRegistered: false,
    missingRequiredValues: Object.freeze(requiredKeysWithPlaceholders(configEnv)),
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
  ensureConfigDirectory(configHome);
  const paths = bridgeConfigPaths(configHome);
  const configEnv = readConfigurationSeed(paths, baseEnv);
  const nextEnv = ensureDefaultEnvironment(configEnv, {
    cwd: configHome,
    codexBin: inferDefaultCodexBin(),
  });
  writeBridgeConfigFile(configHome, nextEnv);
  const botStore = new BotConfigStore(configHome);
  botStore.load(parseEnvironment(nextEnv));
  const existingBot = botStore.list()[0];
  const shouldRegister = options.rebind === true || !existingBot;

  if (shouldRegister) {
    const result = await registerFeishuApp({
      output,
      registerApp: options.registerApp ?? Lark.registerApp,
      qrRenderer: options.qrRenderer ?? renderQrCode,
    });
    const appId = result.client_id.trim();
    const appSecret = result.client_secret.trim();
    botStore.save({
      botKey: appId,
      appId,
      appSecret,
      enabled: true,
      tenantKey: '',
      allowedChats: [],
      authorizedUsers: [],
      allowedApprovers: [],
      allowGroupUserMentions: true,
      allowExternalGroupUserMentions: true,
      allowGroupBotMentions: true,
      source: 'qr',
    });
  }
  ensureBindingsFile(configHome);

  const missingRequiredValues = requiredKeysWithPlaceholders(nextEnv);
  const currentBot = botStore.list()[0];
  output.write([
    '',
    shouldRegister ? '✅ 飞书机器人扫码绑定已完成。' : '✅ 飞书机器人配置已存在，跳过扫码绑定。',
    `配置文件: ${paths.configPath}`,
    missingRequiredValues.length > 0
      ? `仍需填写: ${missingRequiredValues.join(', ')}`
      : '必填配置已齐全，可以运行 doctor/run。',
    '',
  ].join('\n'));

  return Object.freeze({
    configHome,
    configPath: paths.configPath,
    appId: currentBot?.appId ?? '',
    qrRegistered: shouldRegister,
    missingRequiredValues: Object.freeze(missingRequiredValues),
  });
}

function readConfigurationSeed(
  paths: ReturnType<typeof bridgeConfigPaths>,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const persisted = readOrMigratePersistedEnvironment(paths);
  const next = { ...persisted };
  for (const key of knownConfigKeys()) {
    if (!next[key] && baseEnv[key]) {
      next[key] = baseEnv[key];
    }
  }
  return next;
}

function ensureDefaultEnvironment(
  env: NodeJS.ProcessEnv,
  defaults: {
    readonly cwd: string;
    readonly codexBin: string;
  },
): NodeJS.ProcessEnv {
  const next = { ...env };
  const defaultValues: readonly [string, string][] = [
    ['APPROVAL_SUMMARY_MODE', '0'],
    ['APP_SERVER_MODE', 'owned_stdio'],
    ['CODEX_BIN', defaults.codexBin],
    ['CODEX_CWD', defaults.cwd],
    ['ALLOWED_SHELL_COMMANDS', 'ls,pwd,git,find,cd'],
    ['MAX_TEXT_LENGTH', '10000'],
    ['CARD_UPDATE_INTERVAL_MS', '1500'],
    ['MAX_QUEUED_TASKS', '100'],
    ['RATE_LIMIT_QUERY_INTERVAL_MS', '300000'],
    ['LOG_TO_FILE', 'false'],
    ['LOG_FILE_PATH', 'bridge.log'],
    ['ENABLE_AUTO_FILE_UPLOAD', 'false'],
  ];
  for (const [key, value] of defaultValues) {
    if (!next[key]) {
      next[key] = value;
    }
  }
  return next;
}

function knownConfigKeys(): readonly string[] {
  return Object.freeze([
    'APPROVAL_SUMMARY_MODE',
    'APP_SERVER_MODE',
    'APP_SERVER_SOCKET_PATH',
    'CODEX_BIN',
    'CODEX_CWD',
    'ALLOWED_SHELL_COMMANDS',
    'MAX_TEXT_LENGTH',
    'CARD_UPDATE_INTERVAL_MS',
    'MAX_QUEUED_TASKS',
    'RATE_LIMIT_QUERY_INTERVAL_MS',
    'LOG_TO_FILE',
    'LOG_FILE_PATH',
    'ENABLE_AUTO_FILE_UPLOAD',
  ]);
}

function ensureBindingsFile(configHome: string): void {
  const store = new BindingStore(configHome);
  if (!existsSync(store.filePath)) {
    writeFileSync(store.filePath, '{\n  "schemaVersion": 5,\n  "bindings": []\n}\n', {
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

function requiredKeysWithPlaceholders(env: NodeJS.ProcessEnv): readonly string[] {
  const required = [
    ['CODEX_BIN', '/absolute/path/to/codex'],
  ] as const;
  return required
    .filter(([key, placeholder]) => isPlaceholder(env[key] ?? '', placeholder))
    .map(([key]) => key);
}

export async function registerFeishuApp(options: {
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

export async function renderQrCode(url: string): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  qrcode.generate(url, { small: true });
}

function inferDefaultCodexBin(): string {
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? '/absolute/path/to/codex';
}
