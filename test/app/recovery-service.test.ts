import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Thread, ThreadResumeResponse, Turn } from '../../src/app/codex/protocol';
import {
  AppServerClientEvent,
  AppServerConnectionState,
} from '../../src/app/codex/app-server-client';
import { BridgeDatabase } from '../../src/app/db/database';
import {
  APPROVAL_RESPONSE_RPC_METHOD,
  BridgeRepositories,
  TaskRecord,
} from '../../src/app/db/repositories';
import { BridgeConfig } from '../../src/app/domain';
import {
  AppServerLifecycleClient,
  AppServerSupervisor,
  RecoveryAppServer,
  RecoveryCoordinator,
  RecoveryService,
} from '../../src/app/recovery-service';
import {
  ProjectionRequester,
  RecoverableDispatchMethod,
} from '../../src/app/task-orchestrator';

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

class FakeAppServer implements RecoveryAppServer {
  public readonly connectionEpoch = 2;
  public requestCount = 0;
  public turn: Turn = makeTurn('inProgress');

  public async request<TResult>(): Promise<TResult> {
    this.requestCount += 1;
    const response: ThreadResumeResponse = {
      thread: makeThread(this.turn),
      model: 'test-model',
      modelProvider: 'openai',
      cwd: config.codexCwd,
      initialTurnsPage: null,
    };
    return response as TResult;
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
  readonly projections: FakeProjections;
  readonly recovery: RecoveryService;
}

function createFixture(
  withTurn: boolean | 'starting' = true,
  onPendingCancellation?: (taskId: string) => Promise<unknown>,
  onRecoverUnsentDispatch?: (
    taskId: string,
    method: RecoverableDispatchMethod,
  ) => Promise<unknown>,
  onRecoverUnsentSteer?: (inboxId: string) => Promise<unknown>,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'codex-recovery-'));
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
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
  assert.equal(
    repositories.inbox.transition(inbox.id, 'RECEIVED', 'ACCEPTED', 2),
    true,
  );
  const binding = repositories.threadBindings.getOrCreate({
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    projectId: 'project-test',
    workspacePath: config.codexCwd,
    threadId: 'thread-test',
    nowMs: 2,
  });
  const created = repositories.tasks.create({
    bindingId: binding.id,
    sourceInboxId: inbox.id,
    prompt: 'Recover this task',
    nowMs: 4,
  });
  repositories.tasks.transition(created.id, 'RECEIVED', 'STARTING', 5);
  if (withTurn === true) {
    repositories.tasks.bindTurn(created.id, 'turn-test', 6);
    repositories.tasks.transition(created.id, 'STARTING', 'RUNNING', 7);
  } else if (withTurn === false) {
    repositories.tasks.transition(created.id, 'STARTING', 'DISPATCH_UNKNOWN', 7);
  }
  const appServer = new FakeAppServer();
  const projections = new FakeProjections();
  let nowMs = 10;
  const recovery = new RecoveryService(database, config, appServer, projections, {
    onPendingCancellation,
    onRecoverUnsentDispatch,
    onRecoverUnsentSteer,
    now: () => {
      nowMs += 1;
      return nowMs;
    },
  });
  return {
    root,
    database,
    task: repositories.tasks.getById(created.id) as TaskRecord,
    appServer,
    projections,
    recovery,
  };
}

function dispose(fixture: Fixture): void {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function makeTurn(status: Turn['status']): Turn {
  return {
    id: 'turn-test',
    items: status === 'completed'
      ? [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'done' }]
      : [],
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? { message: 'failed', codexErrorInfo: null, additionalDetails: null }
      : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function makeThread(turn: Turn): Thread {
  return {
    id: 'thread-test',
    sessionId: 'session-test',
    preview: '',
    cwd: config.codexCwd,
    modelProvider: 'openai',
    status: turn.status === 'inProgress' ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    name: null,
    turns: [turn],
  };
}

test('reconnect resumes a known turn and converges running then terminal state', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    const approval = repositories.approvals.createPending({
      taskId: fixture.task.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'approval-message',
      connectionEpoch: 2,
      requestId: '{"runtimeInstanceId":"old","requestId":1}',
      method: 'item/commandExecution/requestApproval',
      decisionTokenHashes: { accept: 'accept-hash' },
      expiresAtMs: 100_000,
      nowMs: 8,
    });
    const currentRuntimeApproval = repositories.approvals.createPending({
      taskId: fixture.task.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'current-approval-message',
      connectionEpoch: 2,
      requestId: '{"runtimeInstanceId":"unbound-recovery-runtime","requestId":2}',
      method: 'item/commandExecution/requestApproval',
      decisionTokenHashes: { decline: 'decline-hash' },
      expiresAtMs: 100_000,
      nowMs: 8,
    });
    fixture.recovery.markConnectionLost(2);
    fixture.appServer.turn = {
      ...makeTurn('inProgress'),
      items: [
        {
          id: 'commentary',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'recovered commentary',
        },
        {
          id: 'command',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          aggregatedOutput: 'all tests passed',
        },
      ],
    };
    let task = repositories.tasks.getById(fixture.task.id);
    assert.equal(task?.status, 'RECOVERING');

    await fixture.recovery.recoverReady();
    task = repositories.tasks.getById(fixture.task.id);
    assert.equal(task?.status, 'RUNNING');
    assert.equal(repositories.approvals.getById(approval.id)?.status, 'STALE');
    assert.equal(
      repositories.approvals.getById(currentRuntimeApproval.id)?.status,
      'PENDING',
    );
    assert.deepEqual(
      repositories.taskItems.listByTaskId(fixture.task.id)
        .map((item) => item.contentText)
        .sort(),
      ['recovered commentary', 'npm test\nall tests passed'].sort(),
    );

    assert.equal(
      repositories.inbox.getById(fixture.task.sourceInboxId)?.status,
      'PROCESSED',
    );
    fixture.recovery.markConnectionLost(3);
    fixture.appServer.turn = makeTurn('completed');
    await fixture.recovery.recoverReady();
    task = new BridgeRepositories(fixture.database).tasks.getById(fixture.task.id);
    assert.equal(task?.status, 'SUCCEEDED');
    assert.equal(task?.finalText, 'done');
    assert.equal(
      repositories.inbox.getById(fixture.task.sourceInboxId)?.status,
      'PROCESSED',
    );
    assert.match(
      repositories.taskItems.listByTaskId(fixture.task.id)
        .map((item) => item.contentText)
        .join('\n'),
      /done/,
    );
    assert.equal(fixture.appServer.requestCount, 2);
  } finally {
    dispose(fixture);
  }
});

test('startup reconciles an active task without requiring a prior disconnect event', async () => {
  const fixture = createFixture();
  try {
    await fixture.recovery.recoverReady();

    assert.equal(fixture.appServer.requestCount, 1);
    assert.equal(
      new BridgeRepositories(fixture.database).tasks.getById(fixture.task.id)?.status,
      'RUNNING',
    );
  } finally {
    dispose(fixture);
  }
});

test('recovers only card-creating tasks with a fully persisted CardKit identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-card-recovery-'));
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
  try {
    const repositories = new BridgeRepositories(database);
    const binding = repositories.threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-card',
      projectId: 'project-test',
      workspacePath: config.codexCwd,
      threadId: 'thread-card',
      nowMs: 1,
    });
    const attachedInbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-attached',
      messageId: 'message-attached',
      chatId: 'chat-test',
      rootMessageId: 'root-card',
      payloadDigest: 'digest-attached',
      receivedAtMs: 2,
    }).record;
    const attached = repositories.tasks.create({
      bindingId: binding.id,
      sourceInboxId: attachedInbox.id,
      prompt: 'resume after card attach',
      status: 'CARD_CREATING',
      nowMs: 3,
    });
    repositories.tasks.attachCard(attached.id, 'card-id', 'card-message-id', 4);

    const unknownInbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-unknown',
      messageId: 'message-unknown',
      chatId: 'chat-test',
      rootMessageId: 'root-card',
      payloadDigest: 'digest-unknown',
      receivedAtMs: 5,
    }).record;
    const unknown = repositories.tasks.create({
      bindingId: binding.id,
      sourceInboxId: unknownInbox.id,
      prompt: 'unknown card outcome',
      status: 'CARD_CREATING',
      nowMs: 6,
    });
    let slotChecks = 0;
    const recovery = new RecoveryService(
      database,
      config,
      new FakeAppServer(),
      new FakeProjections(),
      { onSlotAvailable: async () => { slotChecks += 1; } },
    );

    await recovery.recoverReady();

    assert.equal(repositories.tasks.getById(attached.id)?.status, 'QUEUED');
    assert.equal(repositories.tasks.getById(unknown.id)?.status, 'NEEDS_REVIEW');
    assert.equal(
      repositories.tasks.getById(unknown.id)?.errorCode,
      'INITIAL_CARD_IDENTITY_UNKNOWN',
    );
    assert.equal(slotChecks, 1);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not resend a dispatch-unknown task when durable turn identity is missing', async () => {
  const fixture = createFixture(false);
  try {
    await fixture.recovery.recoverReady();
    const task = new BridgeRepositories(fixture.database).tasks.getById(fixture.task.id);

    assert.equal(task?.status, 'DISPATCH_UNKNOWN');
    assert.equal(task?.errorCode, 'RECOVERY_IDENTITY_INCOMPLETE');
    assert.equal(fixture.appServer.requestCount, 0);
    assert.equal(
      new BridgeRepositories(fixture.database).tasks.findAnyActive()?.id,
      fixture.task.id,
    );
  } finally {
    dispose(fixture);
  }
});

test('resumes the thread before recovering a provably unsent STARTING turn request', async () => {
  const recovered: string[] = [];
  const fixture = createFixture('starting', undefined, async (taskId, method) => {
    recovered.push(`${taskId}:${method}`);
  });
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.rpcIntents.prepare({
      operationKey: `${fixture.task.id}:turn-start`,
      taskId: fixture.task.id,
      method: 'turn/start',
      requestDigest: 'turn-start-digest',
      connectionEpoch: 1,
      nowMs: 8,
    });

    await fixture.recovery.recoverReady();

    assert.deepEqual(recovered, [`${fixture.task.id}:thread/resume`]);
  } finally {
    dispose(fixture);
  }
});

test('selects thread/resume only when a durable target thread is present', async () => {
  const threadResumeMethods: RecoverableDispatchMethod[] = [];
  const threadResumeFixture = createFixture(
    'starting',
    undefined,
    async (_taskId, method) => { threadResumeMethods.push(method); },
  );
  try {
    await threadResumeFixture.recovery.recoverReady();
    assert.deepEqual(threadResumeMethods, ['thread/resume']);
  } finally {
    dispose(threadResumeFixture);
  }
});

test('does not create a replacement thread when durable target identity is missing', async () => {
  const recoveredMethods: RecoverableDispatchMethod[] = [];
  const fixture = createFixture(
    'starting',
    undefined,
    async (_taskId, method) => { recoveredMethods.push(method); },
  );
  try {
    fixture.database.prepare(`
      UPDATE thread_binding
      SET thread_id = NULL
      WHERE id = ?
    `).run(fixture.task.bindingId);

    await fixture.recovery.recoverReady();

    assert.deepEqual(recoveredMethods, []);
    assert.equal(
      new BridgeRepositories(fixture.database).tasks.getById(fixture.task.id)?.status,
      'DISPATCH_UNKNOWN',
    );
  } finally {
    dispose(fixture);
  }
});

test('fails closed for SENT, UNKNOWN and RESOLVED STARTING requests', async () => {
  for (const state of ['SENT', 'UNKNOWN', 'RESOLVED'] as const) {
    const recovered: string[] = [];
    const fixture = createFixture('starting', undefined, async (taskId, method) => {
      recovered.push(`${taskId}:${method}`);
    });
    try {
      const repositories = new BridgeRepositories(fixture.database);
      const intent = repositories.rpcIntents.prepare({
        operationKey: `${fixture.task.id}:turn-start`,
        taskId: fixture.task.id,
        method: 'turn/start',
        requestDigest: 'turn-start-digest',
        connectionEpoch: 1,
        nowMs: 8,
      });
      repositories.rpcIntents.markSent(intent.id, 'rpc-8', 9);
      if (state !== 'SENT') {
        repositories.rpcIntents.resolve(intent.id, state, 10);
      }

      await fixture.recovery.recoverReady();

      assert.deepEqual(recovered, [], state);
      assert.equal(
        repositories.tasks.getById(fixture.task.id)?.status,
        'DISPATCH_UNKNOWN',
        state,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('reprojects a terminal task when its terminal outbox row is missing', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.attachCard(fixture.task.id, 'card-test', 'card-message-test', 8);
    repositories.tasks.transition(fixture.task.id, 'RUNNING', 'SUCCEEDED', 9, {
      finalText: 'done',
    });

    await fixture.recovery.recoverReady();

    assert.ok(fixture.projections.taskIds.includes(fixture.task.id));
    assert.equal(fixture.appServer.requestCount, 0);
  } finally {
    dispose(fixture);
  }
});

test('marks uncertain approval responses unknown without replaying an old epoch', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    const intent = repositories.rpcIntents.prepare({
      operationKey: 'approval-response:crash-window',
      taskId: fixture.task.id,
      method: APPROVAL_RESPONSE_RPC_METHOD,
      requestDigest: 'approval-response-digest',
      connectionEpoch: 1,
      nowMs: 8,
    });

    await fixture.recovery.recoverReady();

    const recoveredIntent = fixture.database.prepare(`
      SELECT state, error_code AS errorCode FROM rpc_intent WHERE id = ?
    `).get(intent.id);
    assert.equal(recoveredIntent?.state, 'UNKNOWN');
    assert.equal(recoveredIntent?.errorCode, 'APPROVAL_RESPONSE_RECOVERY_UNKNOWN');
    assert.equal(repositories.tasks.getById(fixture.task.id)?.status, 'DISPATCH_UNKNOWN');
    assert.equal(fixture.appServer.requestCount, 1);
  } finally {
    dispose(fixture);
  }
});

test('replays only a provably unsent durable steer command after task reconciliation', async () => {
  const recoveredInboxIds: string[] = [];
  const fixture = createFixture(
    true,
    undefined,
    undefined,
    async (inboxId) => { recoveredInboxIds.push(inboxId); },
  );
  try {
    const repositories = new BridgeRepositories(fixture.database);
    const steerInbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-steer-recovery',
      messageId: 'message-steer-recovery',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      payloadDigest: 'digest-steer-recovery',
      payloadText: 'persisted follow-up',
      receivedAtMs: 8,
    }).record;
    repositories.inbox.transition(steerInbox.id, 'RECEIVED', 'ACCEPTED', 9);
    repositories.rpcIntents.prepare({
      operationKey: `inbox:${steerInbox.id}:turn-steer`,
      taskId: fixture.task.id,
      method: 'turn/steer',
      requestDigest: 'steer-digest',
      connectionEpoch: 1,
      nowMs: 9,
    });

    await fixture.recovery.recoverReady();

    assert.deepEqual(recoveredInboxIds, [steerInbox.id]);
    assert.equal(repositories.inbox.getById(steerInbox.id)?.status, 'ACCEPTED');
  } finally {
    dispose(fixture);
  }
});

test('marks a crash-window SENT steer unknown instead of replaying it', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    const steerInbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-steer-sent',
      messageId: 'message-steer-sent',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      payloadDigest: 'digest-steer-sent',
      payloadText: 'possibly sent follow-up',
      receivedAtMs: 8,
    }).record;
    repositories.inbox.transition(steerInbox.id, 'RECEIVED', 'ACCEPTED', 9);
    const intent = repositories.rpcIntents.prepare({
      operationKey: `inbox:${steerInbox.id}:turn-steer`,
      taskId: fixture.task.id,
      method: 'turn/steer',
      requestDigest: 'steer-sent-digest',
      connectionEpoch: 1,
      nowMs: 9,
    });
    repositories.rpcIntents.markSent(intent.id, 'rpc-steer', 10);

    await fixture.recovery.recoverReady();

    assert.equal(repositories.rpcIntents.findByOperationKey(intent.operationKey)?.state, 'UNKNOWN');
    assert.equal(repositories.inbox.getById(steerInbox.id)?.status, 'PROCESSED');
    assert.equal(
      repositories.inbox.getById(steerInbox.id)?.errorCode,
      'STEER_OUTCOME_UNKNOWN',
    );
  } finally {
    dispose(fixture);
  }
});

test('retries cancellation after authoritative recovery confirms the turn is active', async () => {
  const recoveredTaskIds: string[] = [];
  const fixture = createFixture(true, async (taskId) => {
    recoveredTaskIds.push(taskId);
  });
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.requestCancellation(fixture.task.id, 8);

    await fixture.recovery.recoverReady();
    assert.deepEqual(recoveredTaskIds, [fixture.task.id]);

    repositories.rpcIntents.prepare({
      operationKey: `${fixture.task.id}:turn-interrupt`,
      taskId: fixture.task.id,
      method: 'turn/interrupt',
      requestDigest: 'interrupt-digest',
      connectionEpoch: 2,
      nowMs: 20,
    });
    await fixture.recovery.recoverReady();

    assert.deepEqual(recoveredTaskIds, [fixture.task.id, fixture.task.id]);

    const intent = repositories.rpcIntents.findByOperationKey(
      `${fixture.task.id}:turn-interrupt`,
    );
    assert.ok(intent);
    repositories.rpcIntents.failPrepared(intent.id, 21, 'APP_SERVER_NOT_READY');
    await fixture.recovery.recoverReady();

    assert.deepEqual(recoveredTaskIds, [fixture.task.id, fixture.task.id, fixture.task.id]);

    repositories.rpcIntents.reprepareUnsent({
      operationKey: `${fixture.task.id}:turn-interrupt`,
      taskId: fixture.task.id,
      method: 'turn/interrupt',
      requestDigest: 'interrupt-digest',
      connectionEpoch: 2,
      nowMs: 22,
    });
    repositories.rpcIntents.markSent(intent.id, 'rpc-interrupt', 23);
    await fixture.recovery.recoverReady();

    assert.deepEqual(recoveredTaskIds, [
      fixture.task.id,
      fixture.task.id,
      fixture.task.id,
      fixture.task.id,
    ]);
  } finally {
    dispose(fixture);
  }
});

test('drains deferred approval work after cancellation recovery and before queue release', async () => {
  const fixture = createFixture();
  try {
    const order: string[] = [];
    const repositories = new BridgeRepositories(fixture.database);
    repositories.tasks.requestCancellation(fixture.task.id, 8);
    const recovery = new RecoveryService(
      fixture.database,
      config,
      fixture.appServer,
      fixture.projections,
      {
        onPendingCancellation: async () => { order.push('cancellation'); },
        onRecoveryComplete: async () => { order.push('approval-drain'); },
        onSlotAvailable: async () => { order.push('slot'); },
      },
    );

    await recovery.recoverReady();

    assert.deepEqual(order, ['cancellation', 'approval-drain', 'slot']);
  } finally {
    dispose(fixture);
  }
});

test('supervisor reconnects after recovery bookkeeping and reconciliation failures', async () => {
  class FakeLifecycleClient implements AppServerLifecycleClient {
    public state: AppServerConnectionState = 'DISCONNECTED';
    public startCount = 0;
    private epoch = 0;
    private readonly listeners = new Set<(event: AppServerClientEvent) => void>();

    public get connectionEpoch(): number {
      return this.epoch;
    }

    public async start(): Promise<unknown> {
      this.startCount += 1;
      this.epoch += 1;
      this.state = 'READY';
      return {};
    }

    public async stop(): Promise<void> {
      this.state = 'CLOSED';
    }

    public async request<TResult>(): Promise<TResult> {
      throw new Error('request is not used by this supervisor test');
    }

    public subscribe(listener: (event: AppServerClientEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    public fail(): void {
      this.state = 'FAILED';
      for (const listener of this.listeners) {
        listener({ type: 'state', state: 'FAILED', epoch: this.epoch });
      }
    }
  }

  class FakeRecovery implements RecoveryCoordinator {
    public recoverCount = 0;
    public failMark = false;
    public failNextRecovery = false;

    public markConnectionLost(): void {
      if (this.failMark) {
        this.failMark = false;
        throw new Error('recovery bookkeeping failed');
      }
    }

    public async recoverReady(): Promise<void> {
      this.recoverCount += 1;
      if (this.failNextRecovery) {
        this.failNextRecovery = false;
        throw new Error('snapshot reconciliation failed');
      }
    }
  }

  const client = new FakeLifecycleClient();
  const recovery = new FakeRecovery();
  const errors: Error[] = [];
  const supervisor = new AppServerSupervisor(client, recovery, {
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 2,
    onError: (error) => errors.push(error),
  });
  await supervisor.start();
  recovery.failMark = true;
  recovery.failNextRecovery = true;
  client.fail();

  await waitUntil(() => client.startCount >= 3 && recovery.recoverCount >= 3);
  assert.equal(client.state, 'READY');
  assert.equal(errors.length, 2);
  await supervisor.stop();
});

test('supervisor stop waits for an active recovery to settle', async () => {
  const recoveryEntered = createDeferred();
  const releaseRecovery = createDeferred();
  const stopCalled = createDeferred();

  class FakeLifecycleClient implements AppServerLifecycleClient {
    public state: AppServerConnectionState = 'DISCONNECTED';
    public startCount = 0;
    public stopCount = 0;
    private epoch = 0;
    private readonly listeners = new Set<(event: AppServerClientEvent) => void>();

    public get connectionEpoch(): number {
      return this.epoch;
    }

    public async start(): Promise<unknown> {
      this.startCount += 1;
      this.epoch += 1;
      this.state = 'READY';
      return {};
    }

    public async stop(): Promise<void> {
      this.stopCount += 1;
      this.state = 'CLOSED';
      stopCalled.resolve();
    }

    public async request<TResult>(): Promise<TResult> {
      throw new Error('request is not used by this supervisor test');
    }

    public subscribe(listener: (event: AppServerClientEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    public fail(): void {
      this.state = 'FAILED';
      for (const listener of this.listeners) {
        listener({ type: 'state', state: 'FAILED', epoch: this.epoch });
      }
    }
  }

  class BlockingRecovery implements RecoveryCoordinator {
    public recoverCount = 0;

    public markConnectionLost(): void {}

    public async recoverReady(): Promise<void> {
      this.recoverCount += 1;
      if (this.recoverCount === 1) {
        return;
      }
      recoveryEntered.resolve();
      await releaseRecovery.promise;
    }
  }

  const client = new FakeLifecycleClient();
  const recovery = new BlockingRecovery();
  const supervisor = new AppServerSupervisor(client, recovery, {
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
  });
  await supervisor.start();
  client.fail();
  await recoveryEntered.promise;

  let stopCompleted = false;
  const stopPromise = supervisor.stop().then(() => {
    stopCompleted = true;
  });
  await stopCalled.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    assert.equal(stopCompleted, false);
    assert.equal(client.stopCount, 1);
  } finally {
    releaseRecovery.resolve();
    await stopPromise;
  }
  assert.equal(stopCompleted, true);
  assert.equal(client.startCount, 2);
});

test('supervisor stop closes a deferred reconnect and skips recovery after start settles', async () => {
  const reconnectEntered = createDeferred();
  const releaseReconnect = createDeferred();

  class DeferredLifecycleClient implements AppServerLifecycleClient {
    public state: AppServerConnectionState = 'DISCONNECTED';
    public startCount = 0;
    public stopCount = 0;
    private epoch = 0;
    private readonly listeners = new Set<(event: AppServerClientEvent) => void>();

    public get connectionEpoch(): number {
      return this.epoch;
    }

    public async start(): Promise<unknown> {
      this.startCount += 1;
      this.epoch += 1;
      if (this.startCount > 1) {
        this.state = 'CONNECTING';
        reconnectEntered.resolve();
        await releaseReconnect.promise;
      }
      this.state = 'READY';
      return {};
    }

    public async stop(): Promise<void> {
      this.stopCount += 1;
      this.state = 'CLOSED';
    }

    public async request<TResult>(): Promise<TResult> {
      throw new Error('request is not used by this supervisor test');
    }

    public subscribe(listener: (event: AppServerClientEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    public fail(): void {
      this.state = 'FAILED';
      for (const listener of this.listeners) {
        listener({ type: 'state', state: 'FAILED', epoch: this.epoch });
      }
    }
  }

  class CountingRecovery implements RecoveryCoordinator {
    public recoverCount = 0;

    public markConnectionLost(): void {}

    public async recoverReady(): Promise<void> {
      this.recoverCount += 1;
    }
  }

  const client = new DeferredLifecycleClient();
  const recovery = new CountingRecovery();
  const supervisor = new AppServerSupervisor(client, recovery, {
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
  });
  await supervisor.start();
  client.fail();
  await reconnectEntered.promise;

  let stopCompleted = false;
  const stopPromise = supervisor.stop().then(() => {
    stopCompleted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopCompleted, false);
  assert.equal(client.stopCount, 1);

  releaseReconnect.resolve();
  await stopPromise;

  assert.equal(client.startCount, 2);
  assert.equal(client.stopCount, 2);
  assert.equal(recovery.recoverCount, 1);
  assert.equal(client.state, 'CLOSED');
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'condition did not become true before timeout');
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}
