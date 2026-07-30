import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { LarkBotConfig } from '../../src/app/bot-config-store';
import { ExternalBotDirectoryStore } from '../../src/app/external-bot-directory';
import { GroupBotDiscoveryService } from '../../src/app/lark/group-bot-discovery';

test('group bot discovery stores only external bots returned by Feishu', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-group-bot-discovery-'));
  try {
    const store = new ExternalBotDirectoryStore(configHome, { now: () => 1_000 });
    const fetches: string[] = [];
    const discovery = new GroupBotDiscoveryService(store, {
      localBots: () => [sourceBot],
      fetchImpl: async (url, init) => {
        fetches.push(String(url));
        if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
          return jsonResponse({ code: 0, tenant_access_token: 'tat', expire: 7_200 });
        }
        assert.equal(init?.headers instanceof Headers, false);
        return jsonResponse({
          code: 0,
          data: {
            items: [
              { bot_id: 'ou_source', bot_name: 'Search Bot' },
              { bot_id: 'ou_external_order', bot_name: 'Order Bot' },
            ],
          },
        });
      },
    });

    const result = await discovery.refreshGroup({
      sourceBot,
      tenantKey: 'tenant',
      chatId: 'chat',
      force: true,
    });

    assert.equal(result.refreshed, true);
    assert.equal(result.externalBotCount, 1);
    assert.equal(store.listForGroup('bot_aaaaaaaaaaaa', 'tenant', 'chat')[0]?.displayName, 'Order Bot');
    assert.ok(fetches.some((url) => url.endsWith('/open-apis/im/v1/chats/chat/members/bots')));
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('group bot discovery throttles repeated refreshes for the same source group', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-group-bot-throttle-'));
  try {
    let tick = 1_000;
    let groupBotCalls = 0;
    const store = new ExternalBotDirectoryStore(configHome, { now: () => tick });
    const discovery = new GroupBotDiscoveryService(store, {
      now: () => tick,
      localBots: () => [sourceBot],
      fetchImpl: async (url) => {
        if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
          return jsonResponse({ code: 0, tenant_access_token: 'tat', expire: 7_200 });
        }
        groupBotCalls += 1;
        return jsonResponse({ code: 0, data: { items: [] } });
      },
      refreshThrottleMs: 60_000,
    });

    await discovery.refreshGroup({ sourceBot, tenantKey: 'tenant', chatId: 'chat' });
    tick = 2_000;
    const throttled = await discovery.refreshGroup({ sourceBot, tenantKey: 'tenant', chatId: 'chat' });

    assert.equal(throttled.refreshed, false);
    assert.equal(groupBotCalls, 1);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const sourceBot: LarkBotConfig = {
  botKey: 'bot_aaaaaaaaaaaa',
  appId: 'cli_0123456789abcdef',
  appSecret: 'secret',
  enabled: true,
  tenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['owner'],
  allowedApprovers: ['owner'],
  allowGroupUserMentions: true,
  allowExternalGroupUserMentions: true,
  allowGroupBotMentions: true,
  botOpenId: 'ou_source',
  displayName: 'Search Bot',
  source: 'import',
  createdAtMs: 1,
  updatedAtMs: 1,
};
