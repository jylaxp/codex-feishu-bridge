/// <reference path="./types/qrcode-terminal.d.ts" />

import * as Lark from '@larksuiteoapi/node-sdk';

import { BindingStore, type ChatThreadBinding } from './binding-store';
import {
  BotConfigStore,
  hasLegacyLarkBotConfig,
  type LarkBotConfig,
  hydrateBotIdentity,
  materializeDefaultBot,
} from './bot-config-store';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { resolveConfigHome } from './config';
import { registerFeishuApp, renderQrCode, type OutputWriter } from './setup';

export type BotCommandAction =
  | 'add'
  | 'import'
  | 'migrate-default'
  | 'rebind'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'list'
  | 'doctor';

export interface BotCommandOptions {
  readonly action: BotCommandAction;
  readonly configHome?: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly confirm?: boolean;
  readonly json?: boolean;
  readonly stdout?: OutputWriter;
}

export interface BotCommandReport {
  readonly action: BotCommandAction;
  readonly configHome: string;
  readonly bots: readonly BotCommandBotView[];
  readonly changed: boolean;
  readonly removedBindingCount: number;
  readonly message: string;
}

export interface BotCommandBotView {
  readonly appId: string;
  readonly enabled: boolean;
  readonly tenantKeyConfigured: boolean;
  readonly allowedChatCount: number;
  readonly authorizedUserCount: number;
  readonly allowedApproverCount: number;
  readonly allowGroupUserMentions: boolean;
  readonly allowExternalGroupUserMentions: boolean;
  readonly allowGroupBotMentions: boolean;
  readonly roleProfileConfigured: boolean;
  readonly botOpenId?: string;
  readonly displayName?: string;
  readonly activateStatus?: number;
  readonly source: LarkBotConfig['source'];
}

type BotCommandPartialReport = Omit<BotCommandReport, 'configHome'>;

export async function runBotCommand(
  options: BotCommandOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<BotCommandReport> {
  const output = options.stdout ?? process.stdout;
  const runtimeEnv = options.configHome
    ? { ...baseEnv, BRIDGE_CONFIG_HOME: options.configHome }
    : baseEnv;
  const effectiveEnv = loadBridgeEnvironment(runtimeEnv);
  const baseConfig = parseEnvironment(effectiveEnv);
  const configHome = options.configHome ?? resolveConfigHome(effectiveEnv);
  const store = new BotConfigStore(configHome);
  store.load(baseConfig);

  let report: BotCommandPartialReport;
  if (options.action === 'add') {
    report = await addBot(store, baseConfig, output);
  } else if (options.action === 'import') {
    report = await importBot(store, baseConfig, options);
  } else if (options.action === 'migrate-default') {
    report = await migrateDefaultBot(store, baseConfig, configHome);
  } else if (options.action === 'rebind') {
    report = await rebindBot(store, options, output);
  } else if (options.action === 'enable' || options.action === 'disable') {
    report = updateEnabled(store, options, options.action === 'enable');
  } else if (options.action === 'remove') {
    report = removeBot(store, configHome, options);
  } else {
    report = viewBots(store, options.action);
  }

  const finalReport = Object.freeze({ ...report, configHome });
  output.write(options.json ? `${JSON.stringify(finalReport, null, 2)}\n` : formatBotReport(finalReport));
  return finalReport;
}

async function addBot(
  store: BotConfigStore,
  baseConfig: ReturnType<typeof parseEnvironment>,
  output: OutputWriter,
): Promise<BotCommandPartialReport> {
  const result = await registerFeishuApp({
    output,
    registerApp: Lark.registerApp,
    qrRenderer: renderQrCode,
  });
  const appId = result.client_id.trim();
  const appSecret = result.client_secret.trim();
  const existing = store.findByAppId(appId);
  if (existing) {
    return report('add', store, false, `机器人已存在：${existing.appId}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  store.save({
    botKey: appId,
    appId,
    appSecret,
    enabled: true,
    tenantKey: '',
    allowedChats: [],
    authorizedUsers: [],
    allowedApprovers: [],
    allowGroupUserMentions: baseConfig.allowGroupUserMentions !== false,
    allowExternalGroupUserMentions: baseConfig.allowExternalGroupUserMentions !== false,
    allowGroupBotMentions: baseConfig.allowGroupBotMentions !== false,
    botOpenId: identity.botOpenId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    activateStatus: identity.activateStatus,
    source: 'qr',
  });
  return report('add', store, true, `已添加机器人：${appId}`);
}

async function importBot(
  store: BotConfigStore,
  baseConfig: ReturnType<typeof parseEnvironment>,
  options: BotCommandOptions,
): Promise<BotCommandPartialReport> {
  const appId = requiredOption(options.appId, '--app-id');
  const appSecret = requiredOption(options.appSecret, '--app-secret');
  const existing = store.findByAppId(appId);
  if (existing) {
    return report('import', store, false, `机器人已存在：${existing.appId}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  store.save({
    botKey: appId,
    appId,
    appSecret,
    enabled: true,
    tenantKey: '',
    allowedChats: [],
    authorizedUsers: [],
    allowedApprovers: [],
    allowGroupUserMentions: baseConfig.allowGroupUserMentions !== false,
    allowExternalGroupUserMentions: baseConfig.allowExternalGroupUserMentions !== false,
    allowGroupBotMentions: baseConfig.allowGroupBotMentions !== false,
    botOpenId: identity.botOpenId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    activateStatus: identity.activateStatus,
    source: 'import',
  });
  return report('import', store, true, `已导入机器人：${appId}`);
}

async function migrateDefaultBot(
  store: BotConfigStore,
  baseConfig: ReturnType<typeof parseEnvironment>,
  configHome: string,
): Promise<BotCommandPartialReport> {
  if (!hasLegacyLarkBotConfig(baseConfig)) {
    return report('migrate-default', store, false, '未发现旧机器人配置；当前机器人配置已在 channels/feishu/bots.json 中维护');
  }
  const existing = store.findByAppId(baseConfig.larkAppId);
  const identity = await hydrateBotIdentity(baseConfig.larkAppId, baseConfig.larkAppSecret);
  const materialized = materializeDefaultBot(baseConfig, identity);
  store.save({
    ...materialized,
    enabled: existing?.enabled ?? true,
    allowedChats: mergeUniqueStrings(materialized.allowedChats, existing?.allowedChats ?? []),
  });
  const bindings = new BindingStore(configHome);
  bindings.load({
    legacyDefaultBotIdentifier: baseConfig.larkAppId,
  });
  bindings.materialize();
  const migratedBot = store.get(baseConfig.larkAppId);
  const migratedAllowedChats = mergeMigratedBindingAllowedChats(
    migratedBot?.allowedChats ?? materialized.allowedChats,
    bindings.list(),
    baseConfig.larkAppId,
  );
  if (migratedBot && !sameStringList(migratedBot.allowedChats, migratedAllowedChats)) {
    store.update(migratedBot.appId, { allowedChats: migratedAllowedChats });
  }
  return report('migrate-default', store, true, `已迁移旧机器人配置：${baseConfig.larkAppId}`);
}

async function rebindBot(
  store: BotConfigStore,
  options: BotCommandOptions,
  output: OutputWriter,
): Promise<BotCommandPartialReport> {
  const selectedAppId = selectedBotIdentifier(options);
  const existing = store.get(selectedAppId);
  if (!existing) {
    throw new Error(`机器人不存在：${selectedAppId}`);
  }
  const result = await registerFeishuApp({
    output,
    registerApp: Lark.registerApp,
    qrRenderer: renderQrCode,
  });
  const appId = result.client_id.trim();
  const appSecret = result.client_secret.trim();
  if (appId !== existing.appId) {
    throw new Error(`扫码返回的是新机器人应用：${appId}。请使用 bot add 添加新机器人，或继续使用 ${existing.appId}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  store.update(existing.appId, {
    appSecret,
    enabled: true,
    tenantKey: '',
    allowedChats: [],
    authorizedUsers: [],
    allowedApprovers: [],
    botOpenId: identity.botOpenId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    activateStatus: identity.activateStatus,
    source: 'qr',
  });
  return report('rebind', store, true, `已刷新机器人凭证：${existing.appId}`);
}

function updateEnabled(
  store: BotConfigStore,
  options: BotCommandOptions,
  enabled: boolean,
): BotCommandPartialReport {
  const appId = selectedBotIdentifier(options);
  store.update(appId, { enabled });
  return report(enabled ? 'enable' : 'disable', store, true, `${enabled ? '已启用' : '已禁用'}机器人：${appId}`);
}

function removeBot(
  store: BotConfigStore,
  configHome: string,
  options: BotCommandOptions,
): BotCommandPartialReport {
  const appId = selectedBotIdentifier(options);
  if (!options.confirm) {
    throw new Error('bot remove requires --confirm');
  }
  const bindings = new BindingStore(configHome);
  bindings.load({ legacyDefaultBotIdentifier: appId });
  const removedBindingCount = bindings.removeBotBindings(appId);
  const removed = store.remove(appId);
  return report(
    'remove',
    store,
    removed || removedBindingCount > 0,
    removed ? `已移除机器人：${appId}` : `机器人不存在：${appId}`,
    removedBindingCount,
  );
}

function viewBots(store: BotConfigStore, action: 'list' | 'doctor'): BotCommandPartialReport {
  return report(action, store, false, action === 'doctor' ? '机器人诊断完成' : '机器人列表');
}

function report(
  action: BotCommandAction,
  store: BotConfigStore,
  changed: boolean,
  message: string,
  removedBindingCount = 0,
): BotCommandPartialReport {
  return Object.freeze({
    action,
    bots: Object.freeze(store.list().map(botView)),
    changed,
    removedBindingCount,
    message,
  });
}

function botView(bot: LarkBotConfig): BotCommandBotView {
  return Object.freeze({
    appId: bot.appId,
    enabled: bot.enabled,
    tenantKeyConfigured: bot.tenantKey.length > 0,
    allowedChatCount: bot.allowedChats.length,
    authorizedUserCount: bot.authorizedUsers.length,
    allowedApproverCount: bot.allowedApprovers.length,
    allowGroupUserMentions: bot.allowGroupUserMentions,
    allowExternalGroupUserMentions: bot.allowExternalGroupUserMentions,
    allowGroupBotMentions: bot.allowGroupBotMentions,
    roleProfileConfigured: Boolean(bot.roleProfile),
    ...(bot.botOpenId ? { botOpenId: bot.botOpenId } : {}),
    ...(bot.displayName ? { displayName: bot.displayName } : {}),
    ...(bot.activateStatus !== undefined ? { activateStatus: bot.activateStatus } : {}),
    source: bot.source,
  });
}

function formatBotReport(report: BotCommandReport): string {
  const lines = [
    `${report.message}`,
    `配置目录: ${report.configHome}`,
    ...(report.removedBindingCount > 0 ? [`移除绑定数: ${report.removedBindingCount}`] : []),
    '',
  ];
  if (report.bots.length === 0) {
    lines.push('未配置机器人。');
  } else {
    for (const bot of report.bots) {
      lines.push([
        `- ${bot.displayName ?? bot.appId}`,
        bot.displayName ? `名称=${bot.displayName}` : '名称=未获取',
        `appId=${bot.appId}`,
        `状态=${bot.enabled ? 'enabled' : 'disabled'}`,
        `openId=${bot.botOpenId ?? '未获取'}`,
        `群成员@=${bot.allowGroupUserMentions ? 'on' : 'off'}`,
        `外部群成员默认@=${bot.allowExternalGroupUserMentions ? 'on' : 'off'}`,
        `机器人@=${bot.allowGroupBotMentions ? 'on' : 'off'}`,
        `角色=${bot.roleProfileConfigured ? '已配置' : '未配置'}`,
        `chats=${bot.allowedChatCount}`,
        `admins=${bot.allowedApproverCount}`,
      ].join(' | '));
    }
  }
  lines.push('');
  return lines.join('\n');
}

function requiredOption(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function selectedBotIdentifier(options: BotCommandOptions): string {
  return requiredOption(options.appId, '--app-id');
}

export function mergeMigratedBindingAllowedChats(
  currentAllowedChats: readonly string[],
  bindings: readonly ChatThreadBinding[],
  appId: string,
): readonly string[] {
  return mergeUniqueStrings(
    currentAllowedChats,
    bindings
      .filter((binding) => (binding.larkAppId ?? binding.botKey) === appId)
      .map((binding) => binding.chatId),
  );
}

function mergeUniqueStrings(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...left, ...right]) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return Object.freeze(merged);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
