import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApprovalAppServer,
  ApprovalCardClient,
  ApprovalService,
  TaskInterrupter,
} from '../../src/app/approval-service';
import { CardKitJson } from '../../src/app/cards/layouts';
import { RequestId, ServerRequest } from '../../src/app/codex/protocol';
import { BridgeDatabase } from '../../src/app/db/database';
import {
  APPROVAL_RESPONSE_RPC_METHOD,
  BridgeRepositories,
  TaskRecord,
} from '../../src/app/db/repositories';
import { BridgeConfig } from '../../src/app/domain';
import { InboundCardAction } from '../../src/app/lark/event-server';
import { ProjectionRequester } from '../../src/app/task-orchestrator';

const config: BridgeConfig = {
  larkAppId: 'app-test',
  larkAppSecret: 'secret-test',
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
  cardUpdateIntervalMs: 1_500,
  maxQueuedTasks: 100,
};

class FakeAppServer implements ApprovalAppServer {
  public readonly connectionEpoch = 4;
  public readonly responses: Array<readonly [RequestId, unknown, number | undefined]> = [];
  public readonly errors: Array<readonly [RequestId, number]> = [];
  public failResponses = false;
  public beforeRespond: (() => void) | undefined;

  public async respond(id: RequestId, result: unknown, epoch?: number): Promise<void> {
    this.beforeRespond?.();
    if (this.failResponses) {
      throw new Error('connection lost after approval click');
    }
    this.responses.push([id, result, epoch]);
  }

  public async respondError(
    id: RequestId,
    error: { readonly code: number; readonly message: string },
  ): Promise<void> {
    this.errors.push([id, error.code]);
  }
}

class FakeCards implements ApprovalCardClient {
  public card: CardKitJson | undefined;

  public async createCard(card: CardKitJson): Promise<string> {
    this.card = card;
    return 'approval-card';
  }

  public async replyCard(): Promise<string> {
    return 'approval-message';
  }
}

class FakeInterrupter implements TaskInterrupter {
  public readonly taskIds: string[] = [];

  public async interruptTask(taskId: string): Promise<void> {
    this.taskIds.push(taskId);
  }
}

class FakeProjections implements ProjectionRequester {
  public readonly taskIds: string[] = [];

  public request(taskId: string): void {
    this.taskIds.push(taskId);
  }
}

interface Fixture {
  readonly root: string;
  readonly database: BridgeDatabase;
  readonly task: TaskRecord;
  readonly appServer: FakeAppServer;
  readonly cards: FakeCards;
  readonly interrupter: FakeInterrupter;
  readonly service: ApprovalService;
}

function createFixture(serviceConfig: BridgeConfig = config): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'codex-approval-'));
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
  const repositories = new BridgeRepositories(database);
  const inbox = repositories.inbox.record({
    tenantKey: 'tenant-test',
    eventId: 'event-test',
    messageId: 'message-test',
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    senderOpenId: 'user-test',
    payloadDigest: 'digest-test',
    receivedAtMs: 1_000,
  }).record;
  const binding = repositories.threadBindings.getOrCreate({
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    projectId: 'project-test',
    workspacePath: '/workspace/project',
    threadId: 'thread-test',
    nowMs: 1_001,
  });
  const created = repositories.tasks.create({
    bindingId: binding.id,
    sourceInboxId: inbox.id,
    prompt: 'Run tests',
    nowMs: 1_002,
  });
  repositories.tasks.attachCard(created.id, 'task-card', 'task-card-message', 1_004);
  repositories.tasks.bindTurn(created.id, 'turn-test', 1_005);
  repositories.tasks.transition(created.id, 'RECEIVED', 'STARTING', 1_006);
  repositories.tasks.transition(created.id, 'STARTING', 'RUNNING', 1_007);

  const appServer = new FakeAppServer();
  const cards = new FakeCards();
  const interrupter = new FakeInterrupter();
  const projections = new FakeProjections();
  let nowMs = 2_000;
  const service = new ApprovalService(
    database,
    serviceConfig,
    appServer,
    cards,
    interrupter,
    projections,
    {
      runtimeInstanceId: 'runtime-a',
      now: () => {
        nowMs += 1;
        return nowMs;
      },
    },
  );
  return {
    root,
    database,
    task: repositories.tasks.getById(created.id) as TaskRecord,
    appServer,
    cards,
    interrupter,
    service,
  };
}

function dispose(fixture: Fixture): void {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function approvalRequest(): ServerRequest {
  return {
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-test',
      turnId: 'turn-test',
      itemId: 'item-test',
      startedAtMs: 1,
      environmentId: null,
      command: 'npm test',
      reason: 'run local tests',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    },
  };
}

function action(token: string, operatorOpenId = 'approver-test'): InboundCardAction {
  return {
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    messageId: 'approval-message',
    operatorOpenId,
    action: 'approval',
    token,
  };
}

function extractButtonTokens(card: CardKitJson): readonly string[] {
  const tokens: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.action === 'approval' && typeof record.token === 'string') {
      tokens.push(record.token);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return tokens;
}

test('persists decision-bound tokens and submits one authorized approval response', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const tokens = extractButtonTokens(fixture.cards.card as CardKitJson);
    const repositories = new BridgeRepositories(fixture.database);
    const approvalId = fixture.database.prepare('SELECT id FROM approval').get()?.id;
    const approval = repositories.approvals.getById(String(approvalId));
    const acceptToken = tokens.find((token) => (
      approval?.decisionTokenHashes.accept === sha256(token)
    ));

    assert.equal(tokens.length, 4);
    assert.ok(acceptToken);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'AWAITING_APPROVAL');
    fixture.appServer.beforeRespond = () => {
      assert.equal(
        fixture.database.prepare(`
          SELECT state FROM rpc_intent WHERE method = ?
        `).get(APPROVAL_RESPONSE_RPC_METHOD)?.state,
        'SENT',
      );
    };

    const first = await fixture.service.handleCardAction(action(acceptToken as string));
    const replay = await fixture.service.handleCardAction(action(acceptToken as string));

    assert.deepEqual(fixture.appServer.responses, [[42, { decision: 'accept' }, 4]]);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'RUNNING');
    const intent = fixture.database.prepare(`
      SELECT state, rpc_id AS rpcId FROM rpc_intent WHERE method = ?
    `).get(APPROVAL_RESPONSE_RPC_METHOD);
    assert.equal(intent?.state, 'RESOLVED');
    assert.equal(intent?.rpcId, '42');
    assert.match(JSON.stringify(first), /审批决定已提交/);
    assert.match(JSON.stringify(replay), /过期或无效/);
  } finally {
    dispose(fixture);
  }
});

test('submits acceptForSession as a decision-bound approval response', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const repositories = new BridgeRepositories(fixture.database);
    const approvalId = String(fixture.database.prepare('SELECT id FROM approval').get()?.id);
    const approval = repositories.approvals.getById(approvalId);
    const sessionToken = extractButtonTokens(fixture.cards.card as CardKitJson).find((token) => (
      approval?.decisionTokenHashes.acceptForSession === sha256(token)
    ));

    assert.ok(sessionToken);
    await fixture.service.handleCardAction(action(sessionToken));

    assert.deepEqual(
      fixture.appServer.responses,
      [[42, { decision: 'acceptForSession' }, 4]],
    );
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'RUNNING');
  } finally {
    dispose(fixture);
  }
});

test('defers approval while recovering and creates it after the task resumes', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.transition(fixture.task.id, 'RUNNING', 'RECOVERING', 2_100);

    await fixture.service.handleServerRequest(approvalRequest(), 4);

    assert.deepEqual(fixture.appServer.responses, []);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM approval').get()?.count, 0);
    assert.equal(fixture.cards.card, undefined);

    repositories.tasks.transition(fixture.task.id, 'RECOVERING', 'RUNNING', 2_101);
    await fixture.service.drainDeferredRequests();

    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM approval').get()?.count, 1);
    assert.ok(fixture.cards.card);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'AWAITING_APPROVAL');
    assert.deepEqual(fixture.appServer.responses, []);
  } finally {
    dispose(fixture);
  }
});

test('fails closed when a deferred approval task becomes terminal', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.transition(fixture.task.id, 'RUNNING', 'RECOVERING', 2_100);
    await fixture.service.handleServerRequest(approvalRequest(), 4);

    repositories.tasks.transition(fixture.task.id, 'RECOVERING', 'FAILED', 2_101);
    await fixture.service.drainDeferredRequests();

    assert.deepEqual(fixture.appServer.responses, [[42, { decision: 'cancel' }, 4]]);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM approval').get()?.count, 0);
    assert.equal(fixture.cards.card, undefined);
  } finally {
    dispose(fixture);
  }
});

test('rejects unauthorized approval clicks without consuming the token', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const [token] = extractButtonTokens(fixture.cards.card as CardKitJson);
    const result = await fixture.service.handleCardAction(action(token as string, 'other-user'));

    assert.match(JSON.stringify(result), /没有审批权限/);
    assert.deepEqual(fixture.appServer.responses, []);
    assert.equal(fixture.database.prepare('SELECT status FROM approval').get()?.status, 'PENDING');
  } finally {
    dispose(fixture);
  }
});

test('binds pending approvals to one runtime instance across process restarts', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const [token] = extractButtonTokens(fixture.cards.card as CardKitJson);
    const replacementService = new ApprovalService(
      fixture.database,
      config,
      fixture.appServer,
      fixture.cards,
      fixture.interrupter,
      new FakeProjections(),
      { runtimeInstanceId: 'runtime-b', now: () => 3_000 },
    );

    const staleResult = await replacementService.handleCardAction(action(token as string));
    assert.match(JSON.stringify(staleResult), /作用域不匹配/);
    assert.deepEqual(fixture.appServer.responses, []);

    const repositories = new BridgeRepositories(fixture.database);
    const firstApprovalId = String(
      fixture.database.prepare('SELECT id FROM approval LIMIT 1').get()?.id,
    );
    repositories.approvals.cancelPending(firstApprovalId, 3_001);
    repositories.tasks.transition(fixture.task.id, 'AWAITING_APPROVAL', 'RUNNING', 3_002);
    await replacementService.handleServerRequest(approvalRequest(), 4);

    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM approval').get()?.count,
      2,
    );
  } finally {
    dispose(fixture);
  }
});

test('keeps the execution slot blocked when an approval response outcome is unknown', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const tokens = extractButtonTokens(fixture.cards.card as CardKitJson);
    const approvalId = String(
      fixture.database.prepare('SELECT id FROM approval').get()?.id,
    );
    const repositories = new BridgeRepositories(fixture.database);
    const approval = repositories.approvals.getById(approvalId);
    const acceptToken = tokens.find((token) => (
      approval?.decisionTokenHashes.accept === sha256(token)
    ));
    fixture.appServer.failResponses = true;

    const result = await fixture.service.handleCardAction(action(acceptToken as string));

    assert.match(JSON.stringify(result), /待核对/);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'DISPATCH_UNKNOWN');
    assert.equal(repositories.tasks.findAnyActive()?.id, fixture.task.id);
    const intent = fixture.database.prepare(`
      SELECT state, error_code AS errorCode FROM rpc_intent WHERE method = ?
    `).get(APPROVAL_RESPONSE_RPC_METHOD);
    assert.equal(intent?.state, 'UNKNOWN');
    assert.equal(intent?.errorCode, 'APPROVAL_RESPONSE_UNKNOWN');
  } finally {
    dispose(fixture);
  }
});

test('rolls back token consumption when approval response intent preparation conflicts', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest(approvalRequest(), 4);
    const repositories = new BridgeRepositories(fixture.database);
    const approvalId = String(fixture.database.prepare('SELECT id FROM approval').get()?.id);
    const approval = repositories.approvals.getById(approvalId);
    const acceptToken = extractButtonTokens(fixture.cards.card as CardKitJson).find((token) => (
      approval?.decisionTokenHashes.accept === sha256(token)
    ));
    repositories.rpcIntents.prepare({
      operationKey: `approval-response:${approvalId}`,
      taskId: fixture.task.id,
      method: APPROVAL_RESPONSE_RPC_METHOD,
      requestDigest: 'conflicting-digest',
      connectionEpoch: 4,
      nowMs: 2_100,
    });

    const result = await fixture.service.handleCardAction(action(acceptToken as string));

    assert.match(JSON.stringify(result), /审批处理失败，请重试/);
    assert.equal(repositories.approvals.getById(approvalId)?.status, 'PENDING');
    assert.deepEqual(fixture.appServer.responses, []);
  } finally {
    dispose(fixture);
  }
});

test('consumes a scoped task cancellation token once', async () => {
  const fixture = createFixture();
  try {
    const rawToken = 'task-cancel-token';
    new BridgeRepositories(fixture.database).tasks.attachCancelTokenHash(
      fixture.task.id,
      sha256(rawToken),
      2_100,
    );
    const cancelAction: InboundCardAction = {
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      messageId: 'task-card-message',
      operatorOpenId: 'user-test',
      action: 'cancel',
      token: rawToken,
    };

    await fixture.service.handleCardAction(cancelAction);
    await fixture.service.handleCardAction(cancelAction);

    assert.deepEqual(fixture.interrupter.taskIds, [fixture.task.id]);
    assert.equal(
      new BridgeRepositories(fixture.database).tasks.getById(fixture.task.id)?.cancelRequested,
      true,
    );
  } finally {
    dispose(fixture);
  }
});

test('prevents another authorized user from cancelling a task they do not own', async () => {
  const fixture = createFixture({
    ...config,
    authorizedUsers: [...config.authorizedUsers, 'other-user'],
  });
  try {
    const rawToken = 'owner-scoped-cancel-token';
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.attachCancelTokenHash(fixture.task.id, sha256(rawToken), 2_100);

    const result = await fixture.service.handleCardAction({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      messageId: 'task-card-message',
      operatorOpenId: 'other-user',
      action: 'cancel',
      token: rawToken,
    });

    assert.match(JSON.stringify(result), /任务已结束或取消操作已失效/);
    assert.deepEqual(fixture.interrupter.taskIds, []);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.cancelRequested, false);
  } finally {
    dispose(fixture);
  }
});

test('allows a configured approver to cancel another user task', async () => {
  const fixture = createFixture();
  try {
    const rawToken = 'privileged-cancel-token';
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.attachCancelTokenHash(fixture.task.id, sha256(rawToken), 2_100);

    await fixture.service.handleCardAction({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      messageId: 'task-card-message',
      operatorOpenId: 'approver-test',
      action: 'cancel',
      token: rawToken,
    });

    assert.deepEqual(fixture.interrupter.taskIds, [fixture.task.id]);
    assert.equal(repositories.tasks.getById(fixture.task.id)?.cancelRequested, true);
  } finally {
    dispose(fixture);
  }
});

test('fails closed for an unknown App Server request', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.handleServerRequest({ id: 'unknown', method: 'future/request' }, 4);
    assert.deepEqual(fixture.appServer.errors, [['unknown', -32601]]);
  } finally {
    dispose(fixture);
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
