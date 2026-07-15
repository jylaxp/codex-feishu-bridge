import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BindingStore } from '../../src/app/binding-store';
import { type CardKitJson } from '../../src/app/cards/layouts';
import { BridgeCommandService } from '../../src/app/command-service';
import type { InMemoryOrchestrator } from '../../src/app/in-memory-orchestrator';
import type { BridgeConfig } from '../../src/app/domain';
import type { InboundTextMessage } from '../../src/app/lark/intake';

const config: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef', larkAppSecret: 'secret', larkTenantKey: 'tenant',
  allowedChats: ['chat'], authorizedUsers: ['user'], allowedApprovers: ['approver'],
  appServerMode: 'owned_stdio', appServerSocketPath: null, codexBin: '/codex', codexCwd: '/workspace',
  allowedWorkspaceRoots: ['/workspace'], maxTextLength: 10_000, cardUpdateIntervalMs: 1_000,
  maxQueuedTasks: 10,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

let nextEvent = 1;

function message(text: string): InboundTextMessage {
  const event = nextEvent++;
  return { tenantKey: 'tenant', eventId: `event-${event}`, messageId: `message-${event}`, chatId: 'chat',
    rootMessageId: 'root', senderOpenId: 'user', text, payloadDigest: 'digest', createdAtMs: 1 };
}

test('handles slash control commands without forwarding them to a model turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'command-service-'));
  try {
    const store = new BindingStore(root);
    store.load();
    store.bind({ tenantKey: 'tenant', chatId: 'chat', threadId: 'thread-1', workspaceId: '/workspace' });
    const cards: CardKitJson[] = [];
    const calls: string[] = [];
    const cancelled: string[] = [];
    const shellCalls: Array<{ command: string; arguments_: readonly string[]; cwd: string }> = [];
    const service = new BridgeCommandService(
      config,
      store,
      { request: async <TResult>(method: string): Promise<TResult> => {
        calls.push(method);
        return {
          rateLimits: {
            primary: { usedPercent: 1, windowDurationMins: 10_080 },
          },
        } as TResult;
      } },
      { createCard: async (card) => { cards.push(card); return `card-${cards.length}`; }, replyCard: async () => 'message' },
      { cancelCurrent: async (chatId: string, threadId: string) => {
        cancelled.push(`${chatId}:${threadId}`); return true;
      } } as unknown as InMemoryOrchestrator,
      { openThread: async () => undefined },
      { run: async (command, arguments_, cwd) => {
        shellCalls.push({ command, arguments_, cwd });
        return { stdout: 'clean', stderr: '', exitCode: 0, timedOut: false };
      } },
    );

    assert.equal(await service.handle(message('/help')), true);
    assert.equal(await service.handle(message('/model gpt-5.6-sol')), true);
    assert.equal(store.get('tenant', 'chat')?.model, 'gpt-5.6-sol');
    assert.equal(await service.handle(message('/cancel')), true);
    assert.deepEqual(cancelled, ['chat:thread-1']);
    assert.equal(await service.handle(message('/usage')), true);
    assert.deepEqual(calls, ['account/rateLimits/read']);
    const usageCard = cards.find((card) => JSON.stringify(card).includes('账户用量统计'));
    const usageSerialized = JSON.stringify(usageCard);
    assert.doesNotMatch(usageSerialized, /5h/);
    assert.match(usageSerialized, /7d/);
    assert.match(usageSerialized, /已用 1/);
    assert.equal(await service.handle(message('/plan')), true);
    assert.equal(store.get('tenant', 'chat')?.plan, 'plan');
    assert.equal(await service.handle(message('/plan')), true);
    assert.equal(store.get('tenant', 'chat')?.plan, undefined);
    assert.equal(await service.handle(message('/goal -c')), true);
    assert.deepEqual(calls, ['account/rateLimits/read', 'thread/goal/clear']);
    assert.equal(await service.handle(message('/cmd git status')), true);
    assert.deepEqual(shellCalls, [{ command: 'git', arguments_: ['status'], cwd: '/workspace' }]);
    assert.equal(await service.handle(message('/cmd git branch unsafe-branch')), true);
    assert.equal(await service.handle(message('/cmd find . -exec touch marker \\;')), true);
    assert.deepEqual(shellCalls, [{ command: 'git', arguments_: ['status'], cwd: '/workspace' }]);
    assert.equal(await service.handle(message('/not-allowed')), true);
    assert.equal(cards.length, 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
