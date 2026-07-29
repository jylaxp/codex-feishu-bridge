import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotConfigStore,
  type LarkBotConfig,
} from '../../src/app/bot-config-store';
import type { BridgeConfig } from '../../src/app/domain';

const baseConfig: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['owner'],
  allowedApprovers: ['owner'],
  approvalCardMode: 'individual',
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/codex',
  codexCwd: '/workspace',
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1,
  maxQueuedTasks: 10,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

test('bot config store persists optional role profile metadata', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-bot-role-'));
  try {
    const store = new BotConfigStore(configHome, { now: () => 1_000 });
    store.load(baseConfig);
    const bot = store.save({
      botKey: 'bot_aaaaaaaaaaaa',
      appId: 'cli_abcdefabcdef1234',
      appSecret: 'secret-a',
      enabled: true,
      tenantKey: 'tenant',
      allowedChats: ['chat'],
      authorizedUsers: ['owner'],
      allowedApprovers: ['owner'],
      allowGroupUserMentions: true,
      allowExternalGroupUserMentions: true,
      allowGroupBotMentions: false,
      botOpenId: 'ou_search',
      displayName: 'Search Bot',
      roleProfile: {
        roleName: 'Search Bot',
        ownerLabel: '搜索组',
        domainDescription: '擅长机票搜索链路排查',
        collaborationInstructions: '需要订单域判断时交接给 Order Bot',
      },
      source: 'import',
    });

    assert.equal(bot.roleProfile?.roleName, 'Search Bot');
    assert.equal(bot.roleProfile?.ownerLabel, '搜索组');

    const loaded = new BotConfigStore(configHome);
    loaded.load(baseConfig);
    assert.deepEqual(loaded.get('bot_aaaaaaaaaaaa')?.roleProfile, bot.roleProfile);

    const document = JSON.parse(readFileSync(join(configHome, 'lark-bots.json'), 'utf8')) as {
      readonly bots: readonly Partial<LarkBotConfig>[];
    };
    assert.deepEqual(document.bots[1]?.roleProfile, bot.roleProfile);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('bot config store omits empty role profile metadata', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-bot-empty-role-'));
  try {
    const store = new BotConfigStore(configHome, { now: () => 1_000 });
    store.load(baseConfig);
    const bot = store.save({
      botKey: 'bot_aaaaaaaaaaaa',
      appId: 'cli_abcdefabcdef1234',
      appSecret: 'secret-a',
      enabled: true,
      tenantKey: 'tenant',
      allowedChats: [],
      authorizedUsers: [],
      allowedApprovers: [],
      allowGroupUserMentions: true,
      allowExternalGroupUserMentions: true,
      allowGroupBotMentions: false,
      roleProfile: {},
      source: 'import',
    });

    assert.equal(bot.roleProfile, undefined);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('bot config store defaults group bot mentions to enabled for MVP', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-bot-mention-default-'));
  try {
    const defaultStore = new BotConfigStore(configHome, { now: () => 1_000 });
    defaultStore.load({ ...baseConfig, allowGroupBotMentions: undefined });
    assert.equal(defaultStore.get('default')?.allowGroupBotMentions, true);

    writeFileSync(join(configHome, 'lark-bots.json'), JSON.stringify({
      schemaVersion: 1,
      bots: [
        {
          botKey: 'default',
          appId: 'cli_0123456789abcdef',
          appSecret: 'secret',
          enabled: true,
          tenantKey: 'tenant',
          allowedChats: [],
          authorizedUsers: [],
          allowedApprovers: [],
          source: 'legacy-env',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        {
          botKey: 'bot_aaaaaaaaaaaa',
          appId: 'cli_abcdefabcdef1234',
          appSecret: 'secret-a',
          enabled: true,
          tenantKey: 'tenant',
          allowedChats: [],
          authorizedUsers: [],
          allowedApprovers: [],
          allowGroupBotMentions: false,
          source: 'import',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    }));

    const loadedStore = new BotConfigStore(configHome);
    loadedStore.load({ ...baseConfig, allowGroupBotMentions: undefined });
    assert.equal(loadedStore.get('default')?.allowGroupBotMentions, true);
    assert.equal(loadedStore.get('bot_aaaaaaaaaaaa')?.allowGroupBotMentions, false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
