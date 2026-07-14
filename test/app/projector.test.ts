import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveTaskCancelToken, hashActionToken } from '../../src/app/action-tokens';
import {
  hydrateTaskCardActions,
  TASK_CANCEL_TOKEN_PLACEHOLDER,
} from '../../src/app/cards/action-hydrator';
import {
  buildTaskProjection,
  DurableCardProjector,
  MAX_TASK_CARD_JSON_BYTES,
  ProjectionCoalescer,
} from '../../src/app/cards/projector';
import { BridgeDatabase } from '../../src/app/db/database';
import { BridgeRepositories } from '../../src/app/db/repositories';
import { TaskItemRecord, TaskRecord } from '../../src/app/db/repositories';
import { BridgeConfig } from '../../src/app/domain';
import { EventProjectionSnapshot } from '../../src/app/codex/event-reducer';

function task(status: TaskRecord['status'] = 'RUNNING'): TaskRecord {
  return {
    id: '12345678-task',
    bindingId: 'binding-test',
    sourceInboxId: 'inbox-test',
    prompt: 'Implement safely',
    status,
    turnId: 'turn-test',
    cardId: 'card-test',
    cardMessageId: 'message-test',
    cardSequence: 0,
    projectionRevision: 0,
    finalText: null,
    errorCode: null,
    cancelRequested: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    completedAtMs: null,
  };
}

function item(overrides: Partial<TaskItemRecord>): TaskItemRecord {
  return {
    taskId: '12345678-task',
    itemId: 'item-test',
    itemType: 'agent_message',
    phase: 'commentary',
    status: 'COMPLETED',
    contentText: '',
    terminalPayloadJson: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

test('projection keeps commentary, tools, and final answer in separate regions', () => {
  const projection = buildTaskProjection(task('SUCCEEDED'), [
    item({ itemId: 'commentary', contentText: 'checking files' }),
    item({
      itemId: 'command',
      itemType: 'command_execution',
      phase: null,
      contentText: 'npm test passed',
    }),
    item({ itemId: 'final', phase: 'final_answer', contentText: 'implemented' }),
  ], { maxTextLength: 10_000, cancelToken: 'must-not-render' });

  assert.equal(projection.payload.commentary, 'checking files');
  assert.equal(projection.payload.toolSummary, 'npm test passed');
  assert.equal(projection.payload.finalAnswer, 'implemented');
  assert.equal(projection.payload.terminal, true);
  assert.doesNotMatch(JSON.stringify(projection.card), /must-not-render/);
});

test('projection renders in-flight agent and command deltas before item completion', () => {
  const liveSnapshot: EventProjectionSnapshot = {
    threadId: 'thread-test',
    turnId: 'turn-test',
    status: 'RUNNING',
    terminal: false,
    revision: 3,
    pendingAgentText: '正在分析当前实现',
    commentary: '',
    finalAnswer: '',
    reasoningSummary: '已定位关键路径',
    commands: [{
      itemId: 'command-live',
      command: 'npm test',
      outputTail: 'running...',
      completed: false,
    }],
    errorMessage: 'temporary failure',
    items: [],
  };
  const projection = buildTaskProjection(task(), [
    item({ itemId: 'persisted-commentary', contentText: '恢复前已完成' }),
  ], {
    maxTextLength: 10_000,
    liveSnapshot,
  });

  assert.match(projection.payload.commentary, /恢复前已完成/);
  assert.match(projection.payload.commentary, /正在分析当前实现/);
  assert.match(projection.payload.commentary, /已定位关键路径/);
  assert.ok(projection.payload.toolSummary.includes('npm test\nrunning\\.\\.\\.'));
  assert.match(projection.payload.toolSummary, /temporary failure/);
});

test('projection limits the complete multi-byte card JSON to 29 KiB', () => {
  const oversizedTask = {
    ...task(),
    prompt: '输入内容'.repeat(5_000),
  };
  const projection = buildTaskProjection(oversizedTask, [
    item({ itemId: 'commentary', contentText: '推理过程'.repeat(5_000) }),
    item({
      itemId: 'command',
      itemType: 'command_execution',
      phase: null,
      contentText: '命令输出'.repeat(5_000),
    }),
  ], {
    maxTextLength: 20_000,
    cancelToken: TASK_CANCEL_TOKEN_PLACEHOLDER,
  });
  const hydrated = hydrateTaskCardActions(projection.card, 'app-secret', oversizedTask.id);

  assert.ok(
    Buffer.byteLength(JSON.stringify(hydrated), 'utf8') <= MAX_TASK_CARD_JSON_BYTES,
  );
});

test('terminal projection preserves final answer before lower-priority regions', () => {
  const finalAnswer = '必须保留的最终结论。'.repeat(400);
  const projection = buildTaskProjection({
    ...task('SUCCEEDED'),
    prompt: '超长输入'.repeat(5_000),
  }, [
    item({ itemId: 'commentary', contentText: '超长过程'.repeat(5_000) }),
    item({
      itemId: 'command',
      itemType: 'command_execution',
      phase: null,
      contentText: '超长命令'.repeat(5_000),
    }),
    item({ itemId: 'final', phase: 'final_answer', contentText: finalAnswer }),
  ], { maxTextLength: 20_000 });

  assert.equal(projection.payload.finalAnswer, finalAnswer);
  assert.ok(
    Buffer.byteLength(JSON.stringify(projection.card), 'utf8') <= MAX_TASK_CARD_JSON_BYTES,
  );
});

test('coalescer merges ordinary requests and immediately follows a running flush', async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstFlush = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondFlush = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const coalescer = new ProjectionCoalescer(5, async (taskId) => {
    calls.push(taskId);
    if (calls.length === 1) {
      await firstFlush;
    } else if (calls.length === 2) {
      await secondFlush;
    }
  });

  coalescer.request('task-1');
  coalescer.request('task-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  coalescer.request('task-1', true);
  releaseFirst?.();
  let drained = false;
  const drain = coalescer.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseSecond?.();
  await drain;

  assert.deepEqual(calls, ['task-1', 'task-1']);
});

test('durable projector stores only a placeholder and hydrates the cancel token at delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-projector-'));
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
  try {
    const repositories = new BridgeRepositories(database);
    const inbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-test',
      messageId: 'message-test',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      payloadDigest: 'digest-test',
      receivedAtMs: 1,
    }).record;
    const binding = repositories.threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      projectId: 'project-test',
      workspacePath: '/workspace/project',
      threadId: 'thread-test',
      nowMs: 2,
    });
    const created = repositories.tasks.create({
      bindingId: binding.id,
      sourceInboxId: inbox.id,
      prompt: 'Run checks',
      nowMs: 3,
    });
    repositories.tasks.attachCard(created.id, 'card-test', 'card-message-test', 4);
    repositories.tasks.transition(created.id, 'RECEIVED', 'STARTING', 5);
    repositories.tasks.transition(created.id, 'STARTING', 'RUNNING', 6);

    const bridgeConfig: BridgeConfig = {
      larkAppId: 'app-test',
      larkAppSecret: 'app-secret-test',
      larkTenantKey: 'tenant-test',
      allowedChats: ['chat-test'],
      authorizedUsers: ['user-test'],
      allowedApprovers: ['approver-test'],
      appServerMode: 'owned_stdio',
      appServerSocketPath: null,
      codexBin: '/usr/local/bin/codex',
      codexCwd: '/workspace/project',
      allowedWorkspaceRoots: ['/workspace'],
      dataDir: '/var/lib/bridge',
      maxTextLength: 10_000,
      cardUpdateIntervalMs: 1_000,
      maxQueuedTasks: 100,
    };
    const rawToken = deriveTaskCancelToken(bridgeConfig.larkAppSecret, created.id);
    repositories.tasks.attachCancelTokenHash(created.id, hashActionToken(rawToken), 7);
    const projector = new DurableCardProjector(database, bridgeConfig, 1);

    projector.request(created.id, true);
    await projector.drain();
    const payloadJson = String(database.prepare(`
      SELECT payload_json FROM card_outbox WHERE state = 'PENDING'
    `).get()?.payload_json);

    assert.match(payloadJson, new RegExp(TASK_CANCEL_TOKEN_PLACEHOLDER));
    assert.doesNotMatch(payloadJson, new RegExp(rawToken));
    const hydrated = hydrateTaskCardActions(
      JSON.parse(payloadJson) as Record<string, unknown>,
      bridgeConfig.larkAppSecret,
      created.id,
    );
    assert.match(JSON.stringify(hydrated), new RegExp(rawToken));
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
