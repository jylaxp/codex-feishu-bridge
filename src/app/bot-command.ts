/// <reference path="./types/qrcode-terminal.d.ts" />

import * as Lark from '@larksuiteoapi/node-sdk';

import { BindingStore } from './binding-store';
import {
  BotConfigStore,
  type LarkBotConfig,
  DEFAULT_BOT_KEY,
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
  readonly botKey?: string;
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
  readonly botKey: string;
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
    report = await migrateDefaultBot(store, baseConfig);
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
    return report('add', store, false, `机器人已存在：${existing.botKey}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  const botKey = store.nextBotKey(appId);
  store.save({
    botKey,
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
  return report('add', store, true, `已添加机器人：${botKey}`);
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
    return report('import', store, false, `机器人已存在：${existing.botKey}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  const botKey = store.nextBotKey(appId);
  store.save({
    botKey,
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
  return report('import', store, true, `已导入机器人：${botKey}`);
}

async function migrateDefaultBot(
  store: BotConfigStore,
  baseConfig: ReturnType<typeof parseEnvironment>,
): Promise<BotCommandPartialReport> {
  const existing = store.get(DEFAULT_BOT_KEY);
  const identity = await hydrateBotIdentity(baseConfig.larkAppId, baseConfig.larkAppSecret);
  store.save({
    ...materializeDefaultBot(baseConfig, identity),
    enabled: existing?.enabled ?? true,
  });
  return report('migrate-default', store, true, '已物化 default 机器人配置');
}

async function rebindBot(
  store: BotConfigStore,
  options: BotCommandOptions,
  output: OutputWriter,
): Promise<BotCommandPartialReport> {
  const botKey = requiredOption(options.botKey, '--bot-key');
  const existing = store.get(botKey);
  if (!existing) {
    throw new Error(`机器人不存在：${botKey}`);
  }
  const result = await registerFeishuApp({
    output,
    registerApp: Lark.registerApp,
    qrRenderer: renderQrCode,
  });
  const appId = result.client_id.trim();
  const appSecret = result.client_secret.trim();
  const duplicate = store.findByAppId(appId);
  if (duplicate && duplicate.botKey !== botKey) {
    throw new Error(`扫码返回的应用已属于其他机器人：${duplicate.botKey}`);
  }
  const identity = await hydrateBotIdentity(appId, appSecret);
  store.update(botKey, {
    appId,
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
  return report('rebind', store, true, `已重新扫码绑定机器人：${botKey}`);
}

function updateEnabled(
  store: BotConfigStore,
  options: BotCommandOptions,
  enabled: boolean,
): BotCommandPartialReport {
  const botKey = requiredOption(options.botKey, '--bot-key');
  store.update(botKey, { enabled });
  return report(enabled ? 'enable' : 'disable', store, true, `${enabled ? '已启用' : '已禁用'}机器人：${botKey}`);
}

function removeBot(
  store: BotConfigStore,
  configHome: string,
  options: BotCommandOptions,
): BotCommandPartialReport {
  const botKey = requiredOption(options.botKey, '--bot-key');
  if (!options.confirm) {
    throw new Error('bot remove requires --confirm');
  }
  if (botKey === DEFAULT_BOT_KEY) {
    throw new Error('default bot cannot be removed; use bot disable instead');
  }
  const bindings = new BindingStore(configHome);
  bindings.load();
  const removedBindingCount = bindings.removeBotBindings(botKey);
  const removed = store.remove(botKey);
  return report(
    'remove',
    store,
    removed || removedBindingCount > 0,
    removed ? `已移除机器人：${botKey}` : `机器人不存在：${botKey}`,
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
    botKey: bot.botKey,
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
        `- ${bot.botKey}`,
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
