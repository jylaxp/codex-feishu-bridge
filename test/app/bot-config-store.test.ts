import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      botKey: 'cli_aaaaaaaaaaaaaaaa',
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
    assert.deepEqual(loaded.get('cli_abcdefabcdef1234')?.roleProfile, bot.roleProfile);

    const document = JSON.parse(readFileSync(join(configHome, 'channels', 'feishu', 'bots.json'), 'utf8')) as {
      readonly schemaVersion: number;
      readonly bots: readonly Partial<LarkBotConfig>[];
    };
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.bots[1]?.botKey, undefined);
    assert.equal(document.bots[1]?.appId, 'cli_abcdefabcdef1234');
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
      botKey: 'cli_aaaaaaaaaaaaaaaa',
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

test('bot config store ignores development root lark-bots.json during official migration', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-bot-ignore-root-'));
  try {
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
          botKey: 'cli_aaaaaaaaaaaaaaaa',
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
    loadedStore.load({ ...baseConfig, larkAppId: '', larkAppSecret: '' });

    assert.equal(loadedStore.list().length, 0);
    assert.equal(existsSync(join(configHome, 'lark-bots.json')), true);
    assert.equal(existsSync(join(configHome, 'channels', 'feishu', 'bots.json')), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
