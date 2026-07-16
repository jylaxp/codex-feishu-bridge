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

function selectedActionToken(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const select = body.elements.find((element) => element.tag === 'select_static');
  const options = select?.options as Array<{ value?: unknown }> | undefined;
  const token = options?.at(-1)?.value;
  assert.equal(typeof token, 'string');
  return token as string;
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
      {
        createCard: async (card) => { cards.push(card); return `card-${cards.length}`; },
        replyCard: async () => 'message',
        replaceCard: async (_cardId, card, sequence) => { cards.push(card); return sequence + 1; },
      },
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
    assert.deepEqual(calls, ['account/rateLimits/read', 'thread/goal/clear', 'thread/read']);
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

test('restores interactive model, skill, goal and complete help command behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'command-service-interactive-'));
  try {
    const store = new BindingStore(root);
    store.load();
    store.bind({ tenantKey: 'tenant', chatId: 'chat', threadId: 'thread-1', workspaceId: '/workspace' });
    const cards: CardKitJson[] = [];
    const startedPrompts: string[] = [];
    const calls: string[] = [];
    const service = new BridgeCommandService(
      config,
      store,
      { request: async <TResult>(method: string): Promise<TResult> => {
        calls.push(method);
        if (method === 'skills/list') {
          return {
            data: [{ skills: [{ name: 'ce-debug', shortDescription: '系统排障', scope: 'local' }] }],
          } as TResult;
        }
        return {} as TResult;
      } },
      {
        createCard: async (card) => { cards.push(card); return `card-${cards.length}`; },
        replyCard: async () => 'message',
        replaceCard: async (_cardId, card, sequence) => { cards.push(card); return sequence + 1; },
      },
      { handleInbound: async (inbound: InboundTextMessage) => {
        startedPrompts.push(inbound.text);
        return { type: 'started' };
      } } as unknown as InMemoryOrchestrator,
      { openThread: async () => undefined },
      undefined,
      undefined,
      { list: async () => ['gpt-5.6-sol'] },
    );

    assert.equal(await service.handle(message('/help')), true);
    const help = JSON.stringify(cards.at(-1));
    for (const expected of ['/ll', '/goal', '/mcp', '/model', '/skills', '/run', '/usage']) {
      assert.match(help, new RegExp(expected.replace('/', '\\/')));
    }

    assert.equal(await service.handle(message('/model')), true);
    const modelToken = selectedActionToken(cards.at(-1)!);
    assert.equal(((await service.handleCardAction({
      tenantKey: 'tenant', chatId: 'chat', messageId: 'message', operatorOpenId: 'user',
      action: 'model', token: modelToken,
    })) as { toast: { type: string } }).toast.type, 'success');
    assert.equal(store.get('tenant', 'chat')?.model, 'gpt-5.6-sol');
    assert.match(JSON.stringify(cards.at(-1)), /🤖 模型设定/);

    assert.equal(await service.handle(message('/skills')), true);
    const skillToken = selectedActionToken(cards.at(-1)!);
    await service.handleCardAction({
      tenantKey: 'tenant', chatId: 'chat', messageId: 'message', operatorOpenId: 'user',
      action: 'skill', token: skillToken,
    });
    assert.equal(store.get('tenant', 'chat')?.activeSkill, 'ce-debug');
    assert.match(JSON.stringify(cards.at(-1)), /📌 \*\*已锁定\*\*/);

    assert.equal(await service.handle(message('/goal 修复当前问题')), true);
    assert.deepEqual(startedPrompts, ['开始执行目标：修复当前问题']);
    assert.equal(store.get('tenant', 'chat')?.activeSkill, undefined);
    assert.deepEqual(calls, ['skills/list', 'thread/goal/set']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
