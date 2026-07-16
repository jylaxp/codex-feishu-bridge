import assert from 'node:assert/strict';
import test from 'node:test';

import type { CardKitJson } from '../../src/app/cards/layouts';
import type { DesktopIpcClient } from '../../src/app/codex/desktop-ipc-client';
import type { BridgeConfig } from '../../src/app/domain';
import { DesktopApprovalService } from '../../src/app/desktop-approval-service';

const config: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['user'],
  allowedApprovers: ['approver'],
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/codex',
  codexCwd: '/workspace',
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1_000,
  maxQueuedTasks: 10,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

class FakeDesktop {
  public connectionEpoch = 4;
  public readonly responses: unknown[] = [];

  public async respondToApproval(response: unknown): Promise<void> {
    this.responses.push(response);
  }
}

class FakeCards {
  public card: CardKitJson | undefined;
  public replacements: CardKitJson[] = [];

  public async createCard(card: CardKitJson): Promise<string> {
    this.card = card;
    return 'approval-card';
  }

  public async replyCard(): Promise<string> {
    return 'approval-message';
  }

  public async replaceCard(_cardId: string, card: CardKitJson, sequence: number): Promise<number> {
    this.replacements.push(card);
    return sequence + 1;
  }
}

class FakeTasks {
  public waiting: boolean | undefined;
  public failed = false;

  public approvalContext(): { taskId: string; chatId: string; rootMessageId: string } {
    return { taskId: 'task-1', chatId: 'chat', rootMessageId: 'root-1' };
  }

  public setAwaitingApproval(_threadId: string, _turnId: string | null, waiting: boolean): boolean {
    this.waiting = waiting;
    return true;
  }

  public failForApprovalDelivery(): void {
    this.failed = true;
  }
}

function approvalToken(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const columns = body.elements.at(-1) as { columns: Array<{ elements: Array<Record<string, unknown>> }> };
  const token = columns.columns[0]?.elements[0]?.value as { token?: unknown } | undefined;
  assert.equal(typeof token?.token, 'string');
  return token?.token as string;
}

test('projects a Desktop approval to the source Feishu root and submits it once', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const tasks = new FakeTasks();
  const service = new DesktopApprovalService(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
    tasks,
    () => 100,
  );

  await service.present({
    requestId: 'request-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    kind: 'command',
    reason: 'Need permission',
    operationSummary: 'git status',
    availableDecisions: ['accept', 'decline'],
  }, 4);

  const token = approvalToken(cards.card!);
  const result = await service.handleAction({
    chatId: 'chat',
    messageId: 'approval-message',
    operatorOpenId: 'approver',
    token,
  });

  assert.deepEqual(desktop.responses, [{
    threadId: 'thread-1', requestId: 'request-1', kind: 'command', decision: 'accept',
  }]);
  assert.equal(tasks.waiting, false);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /审批已批准/);
  assert.deepEqual(result, {
    toast: {
      type: 'success', content: '审批结果已提交',
      i18n: { zh_cn: '审批结果已提交', en_us: '审批结果已提交' },
    },
  });

  const repeated = await service.handleAction({
    chatId: 'chat', messageId: 'approval-message', operatorOpenId: 'approver', token,
  });
  assert.equal(desktop.responses.length, 1);
  assert.match(JSON.stringify(repeated), /审批已失效/);
});

test('rejects a stale Desktop epoch without submitting an approval response', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const tasks = new FakeTasks();
  const service = new DesktopApprovalService(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
    tasks,
    () => 100,
  );
  await service.present({
    requestId: 'request-1', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
    kind: 'file', reason: '', operationSummary: 'file change', availableDecisions: ['accept'],
  }, 4);
  desktop.connectionEpoch = 5;

  const result = await service.handleAction({
    chatId: 'chat', messageId: 'approval-message', operatorOpenId: 'approver',
    token: approvalToken(cards.card!),
  });
  assert.equal(desktop.responses.length, 0);
  assert.match(JSON.stringify(result), /审批已失效/);
});
