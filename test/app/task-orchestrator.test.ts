import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CardKitJson } from '../../src/app/cards/layouts';
import {
  AppServerConnectionError,
  AppServerRpcError,
  TrackedRequestIdentity,
} from '../../src/app/codex/app-server-client';
import { DesktopIpcRequestError } from '../../src/app/codex/desktop-ipc-client';
import { Thread, Turn } from '../../src/app/codex/protocol';
import { BridgeDatabase } from '../../src/app/db/database';
import { BridgeRepositories } from '../../src/app/db/repositories';
import { BridgeConfig } from '../../src/app/domain';
import { InboundTextMessage } from '../../src/app/lark/intake';
import {
  OrchestratorAppServer,
  OrchestratorCardClient,
  ProjectionRequester,
  TaskOrchestrator,
  TurnStartEventCoordinator,
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

class FakeAppServer implements OrchestratorAppServer {
  public readonly connectionEpoch = 7;
  public readonly methods: string[] = [];
  public readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  private nextId = 1;
  public failBeforeSendMethod: string | undefined;
  public failAfterSendMethod: string | undefined;
  public desktopProvablyUnsentMethod: string | undefined;
  public rpcFailureMethod: string | undefined;
  public threadResponseId = 'thread-test';
  public turnResponseId = 'turn-test';

  public async requestTracked<TResult>(
    method: string,
    params: unknown,
    beforeSend: (identity: TrackedRequestIdentity) => void,
  ): Promise<TResult> {
    if (method === this.failBeforeSendMethod) {
      this.failBeforeSendMethod = undefined;
      throw new Error('App Server not ready before transport write');
    }
    const id = this.nextId;
    this.nextId += 1;
    beforeSend({ id, epoch: this.connectionEpoch });
    this.methods.push(method);
    this.calls.push({ method, params });
    if (method === this.failAfterSendMethod) {
      throw new AppServerConnectionError('connection lost after transport write', this.connectionEpoch);
    }
    if (method === this.desktopProvablyUnsentMethod) {
      throw new DesktopIpcRequestError(
        'DESKTOP_IPC_REMOTE_REJECTED',
        'PROVABLY_UNSENT',
        this.connectionEpoch,
        method,
        String(id),
      );
    }
    if (method === this.rpcFailureMethod) {
      throw new AppServerRpcError(method, {
        code: -32_000,
        message: 'request rejected',
      });
    }
    if (method === 'thread/resume') {
      return {
        thread: makeThread(this.threadResponseId),
        model: 'test-model',
        modelProvider: 'openai',
        cwd: config.codexCwd,
        initialTurnsPage: null,
      } as TResult;
    }
    if (method === 'turn/start') {
      return { turn: makeTurn(this.turnResponseId) } as TResult;
    }
    if (method === 'turn/steer') {
      return { turnId: 'turn-test' } as TResult;
    }
    if (method === 'turn/interrupt') {
      return {} as TResult;
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

class FakeCardClient implements OrchestratorCardClient {
  public readonly operations: string[] = [];
  public failCreate = false;
  public nextCreateGate: Promise<void> | undefined;

  public async createCard(_card: CardKitJson): Promise<string> {
    this.operations.push('card:create');
    const gate = this.nextCreateGate;
    this.nextCreateGate = undefined;
    await gate;
    if (this.failCreate) {
      throw new Error('CardKit unavailable');
    }
    return `card-${this.operations.length}`;
  }

  public async replyCard(
    _rootMessageId: string,
    _cardId: string,
    _idempotencyKey: string,
  ): Promise<string> {
    this.operations.push('card:reply');
    return `card-message-${this.operations.length}`;
  }
}

class FakeProjections implements ProjectionRequester {
  public readonly requests: Array<readonly [string, boolean]> = [];

  public request(taskId: string, immediate = false): void {
    this.requests.push([taskId, immediate]);
  }
}

class FakeTurnEvents implements TurnStartEventCoordinator {
  public readonly calls: Array<{
    readonly kind: 'begin' | 'abandon' | 'drain';
    readonly taskId: string;
    readonly threadId: string;
    readonly turnId?: string;
    readonly persisted?: boolean;
  }> = [];
  public completeTaskOnDrain = false;

  public constructor(private readonly database: BridgeDatabase) {}

  public beginTurnStart(taskId: string, threadId: string): void {
    this.calls.push({ kind: 'begin', taskId, threadId });
  }

  public abandonTurnStart(taskId: string, threadId: string): void {
    this.calls.push({ kind: 'abandon', taskId, threadId });
  }

  public drainTurnStart(taskId: string, threadId: string, turnId: string): void {
    const repositories = new BridgeRepositories(this.database);
    const persisted = repositories.tasks.findByTurnId(turnId)?.id === taskId;
    this.calls.push({ kind: 'drain', taskId, threadId, turnId, persisted });
    if (this.completeTaskOnDrain) {
      repositories.tasks.transition(taskId, 'RUNNING', 'SUCCEEDED', 20_000, {
        finalText: 'fast result',
      });
    }
  }
}

interface Fixture {
  readonly root: string;
  readonly database: BridgeDatabase;
  readonly appServer: FakeAppServer;
  readonly cards: FakeCardClient;
  readonly projections: FakeProjections;
  readonly turnEvents: FakeTurnEvents;
  readonly orchestrator: TaskOrchestrator;
  readonly executionClient: FakeAppServer;
}

interface FixtureOptions {
  readonly useSeparateExecutionClient?: boolean;
  readonly resumeThreadBeforeTurnStart?: boolean;
}

function createFixture(
  configOverride: Partial<BridgeConfig> = {},
  options: FixtureOptions = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'codex-orchestrator-'));
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
  new BridgeRepositories(database).chatThreadBindings.upsert({
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    threadId: 'thread-test',
    workspacePath: config.codexCwd,
    boundByOpenId: 'user-test',
    threadTitle: 'Selected ChatGPT task',
    nowMs: 9_500,
  });
  const appServer = new FakeAppServer();
  const executionClient = options.useSeparateExecutionClient
    ? new FakeAppServer()
    : appServer;
  const cards = new FakeCardClient();
  const projections = new FakeProjections();
  const turnEvents = new FakeTurnEvents(database);
  const bridgeConfig = { ...config, ...configOverride };
  let nowMs = 10_000;
  const orchestrator = new TaskOrchestrator(
    database,
    bridgeConfig,
    appServer,
    cards,
    projections,
    {
      runtimeInstanceId: 'runtime-orchestrator-test',
      turnEvents,
      executionClient,
      resumeThreadBeforeTurnStart: options.resumeThreadBeforeTurnStart,
      now: () => {
        nowMs += 1;
        return nowMs;
      },
    },
  );
  return {
    root,
    database,
    appServer,
    cards,
    projections,
    turnEvents,
    orchestrator,
    executionClient,
  };
}

function dispose(fixture: Fixture): void {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function message(
  eventId = 'event-1',
  messageId = 'message-1',
  rootMessageId = 'root-1',
  text = 'Implement the requested change',
): InboundTextMessage {
  return {
    tenantKey: 'tenant-test',
    eventId,
    messageId,
    chatId: 'chat-test',
    rootMessageId,
    senderOpenId: 'user-test',
    text,
    payloadDigest: `digest-${eventId}`,
    createdAtMs: 9_000,
  };
}

function makeThread(id: string): Thread {
  return {
    id,
    sessionId: `session-${id}`,
    preview: '',
    cwd: config.codexCwd,
    modelProvider: 'openai',
    status: { type: 'idle' },
    name: null,
    turns: [],
  };
}

function makeTurn(id: string): Turn {
  return {
    id,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for test condition');
}

test('persists, creates the initial card, then starts exactly one App Server turn', async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const replay = await fixture.orchestrator.handleInbound(message());
    const repositories = new BridgeRepositories(fixture.database);
    const task = repositories.tasks.findByTurnId('turn-test');

    assert.equal(result.type, 'started');
    assert.equal(replay.type, 'duplicate');
    assert.deepEqual(fixture.cards.operations, ['card:create', 'card:reply']);
    assert.deepEqual(fixture.appServer.methods, ['thread/resume', 'turn/start']);
    assert.deepEqual(fixture.appServer.calls.map((call) => ({
      method: call.method,
      threadId: (call.params as { readonly threadId?: string }).threadId,
      cwd: (call.params as { readonly cwd?: string }).cwd,
    })), [
      { method: 'thread/resume', threadId: 'thread-test', cwd: config.codexCwd },
      { method: 'turn/start', threadId: 'thread-test', cwd: config.codexCwd },
    ]);
    assert.equal(task?.status, 'RUNNING');
    assert.ok(task?.cancelTokenHash);
    assert.equal(repositories.inbox.count(), 1);
    assert.deepEqual(fixture.turnEvents.calls.map((call) => call.kind), ['begin', 'drain']);
    assert.equal(fixture.turnEvents.calls[1]?.turnId, 'turn-test');
    assert.equal(fixture.turnEvents.calls[1]?.persisted, true);
  } finally {
    dispose(fixture);
  }
});

test('dispatches through the Desktop execution client without resuming a second runtime', async () => {
  const fixture = createFixture({}, {
    useSeparateExecutionClient: true,
    resumeThreadBeforeTurnStart: false,
  });
  fixture.executionClient.turnResponseId = 'turn-desktop';
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const repositories = new BridgeRepositories(fixture.database);

    assert.equal(result.type, 'started');
    assert.deepEqual(fixture.appServer.methods, []);
    assert.deepEqual(fixture.executionClient.methods, ['turn/start']);
    assert.equal(repositories.tasks.findByTurnId('turn-desktop')?.status, 'RUNNING');
    assert.deepEqual(fixture.turnEvents.calls.map((call) => call.kind), ['begin', 'drain']);
  } finally {
    dispose(fixture);
  }
});

test('keeps the early event window when Desktop accepted a turn with an unknown outcome', async () => {
  const fixture = createFixture({}, {
    useSeparateExecutionClient: true,
    resumeThreadBeforeTurnStart: false,
  });
  fixture.executionClient.failAfterSendMethod = 'turn/start';
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const task = new BridgeRepositories(fixture.database).tasks.findAnyActive();

    assert.equal(result.type, 'failed');
    assert.equal(task?.status, 'DISPATCH_UNKNOWN');
    assert.deepEqual(fixture.turnEvents.calls.map((call) => call.kind), ['begin']);
    assert.equal(
      fixture.executionClient.methods.filter((method) => method === 'turn/start').length,
      1,
    );
  } finally {
    dispose(fixture);
  }
});

test('fails a Desktop turn cleanly when the router proves it was not delivered', async () => {
  const fixture = createFixture({}, {
    useSeparateExecutionClient: true,
    resumeThreadBeforeTurnStart: false,
  });
  fixture.executionClient.desktopProvablyUnsentMethod = 'turn/start';
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const task = fixture.database.prepare('SELECT status FROM task').get();
    const intent = fixture.database.prepare(`
      SELECT state FROM rpc_intent WHERE method = 'turn/start'
    `).get();

    assert.equal(result.type, 'failed');
    assert.equal(task?.status, 'FAILED');
    assert.equal(intent?.state, 'FAILED');
    assert.deepEqual(fixture.turnEvents.calls.map((call) => call.kind), [
      'begin',
      'abandon',
    ]);
    assert.equal(
      fixture.executionClient.methods.filter((method) => method === 'turn/start').length,
      1,
    );
  } finally {
    dispose(fixture);
  }
});

test('dispatches the selected thread with its persisted workspace', async () => {
  const fixture = createFixture();
  try {
    const selectedWorkspace = '/workspace/selected-project';
    new BridgeRepositories(fixture.database).chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-selected',
      workspacePath: selectedWorkspace,
      boundByOpenId: 'user-test',
      nowMs: 9_700,
    });
    fixture.appServer.threadResponseId = 'thread-selected';

    const result = await fixture.orchestrator.handleInbound(
      message('event-selected', 'message-selected', 'root-selected', 'Use selected task'),
    );

    assert.equal(result.type, 'started');
    assert.deepEqual(fixture.appServer.calls.map((call) => ({
      threadId: (call.params as { readonly threadId?: string }).threadId,
      cwd: (call.params as { readonly cwd?: string }).cwd,
    })), [
      { threadId: 'thread-selected', cwd: selectedWorkspace },
      { threadId: 'thread-selected', cwd: selectedWorkspace },
    ]);
    assert.equal(
      new BridgeRepositories(fixture.database).threadBindings.findByLarkRoot(
        'tenant-test',
        'chat-test',
        'root-selected',
      )?.workspacePath,
      selectedWorkspace,
    );
  } finally {
    dispose(fixture);
  }
});

test('rejects normal work when the Feishu chat has no selected ChatGPT task', async () => {
  const fixture = createFixture();
  try {
    new BridgeRepositories(fixture.database).chatThreadBindings.delete(
      'tenant-test',
      'chat-test',
      9_600,
    );

    const result = await fixture.orchestrator.handleInbound(message());
    new BridgeRepositories(fixture.database).chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-rebound',
      workspacePath: config.codexCwd,
      boundByOpenId: 'user-test',
      nowMs: 9_700,
    });
    const replayAfterBinding = await fixture.orchestrator.handleInbound(message());

    assert.deepEqual(result, { type: 'unbound', chatId: 'chat-test' });
    assert.deepEqual(replayAfterBinding, { type: 'unbound', chatId: 'chat-test' });
    const repositories = new BridgeRepositories(fixture.database);
    assert.equal(repositories.inbox.count(), 1);
    const rejected = fixture.database.prepare(`
      SELECT status, error_code AS errorCode FROM inbox_event WHERE message_id = ?
    `).get('message-1');
    assert.equal(rejected?.status, 'REJECTED');
    assert.equal(rejected?.errorCode, 'CHAT_THREAD_UNBOUND');
    assert.deepEqual(fixture.cards.operations, []);
    assert.deepEqual(fixture.appServer.methods, []);
  } finally {
    dispose(fixture);
  }
});

test('treats an early buffered successful completion as an accepted dispatch', async () => {
  const fixture = createFixture();
  fixture.turnEvents.completeTaskOnDrain = true;
  try {
    const result = await fixture.orchestrator.handleInbound(message());

    assert.equal(result.type, 'started');
    assert.equal(
      new BridgeRepositories(fixture.database).tasks.findByTurnId('turn-test')?.status,
      'SUCCEEDED',
    );
  } finally {
    dispose(fixture);
  }
});

test('pins each Lark root to the selected ChatGPT task captured on first use', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    const repositories = new BridgeRepositories(fixture.database);
    repositories.chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-rebound',
      workspacePath: config.codexCwd,
      boundByOpenId: 'user-test',
      threadTitle: 'Replacement task',
      nowMs: 20_000,
    });

    const queued = await fixture.orchestrator.handleInbound(
      message('event-rebound', 'message-rebound', 'root-rebound', 'Use the new binding'),
    );
    await fixture.orchestrator.handleInbound(
      message('event-old-root', 'message-old-root', 'root-1', 'Continue the original root'),
    );

    assert.equal(queued.type, 'queued');
    assert.equal(
      repositories.threadBindings.findByLarkRoot('tenant-test', 'chat-test', 'root-1')?.threadId,
      'thread-test',
    );
    assert.equal(
      repositories.threadBindings.findByLarkRoot(
        'tenant-test',
        'chat-test',
        'root-rebound',
      )?.threadId,
      'thread-rebound',
    );
  } finally {
    dispose(fixture);
  }
});

test('uses local receipt time so a future Lark message clock cannot break persistence', async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.orchestrator.handleInbound({
      ...message(),
      createdAtMs: Date.now() + 24 * 60 * 60 * 1_000,
    });

    assert.equal(result.type, 'started');
    assert.equal(new BridgeRepositories(fixture.database).inbox.count(), 1);
  } finally {
    dispose(fixture);
  }
});

test('steers an active root and queues a different root without starting a second turn', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    const steered = await fixture.orchestrator.handleInbound(
      message('event-2', 'message-2', 'root-1', 'Additional constraint'),
    );
    const queued = await fixture.orchestrator.handleInbound(
      message('event-3', 'message-3', 'root-2', 'Independent task'),
    );

    assert.equal(steered.type, 'steered');
    assert.equal(queued.type, 'queued');
    assert.deepEqual(fixture.appServer.methods, [
      'thread/resume',
      'turn/start',
      'turn/steer',
    ]);
    assert.equal(new BridgeRepositories(fixture.database).tasks.findNextQueued()?.status, 'QUEUED');
  } finally {
    dispose(fixture);
  }
});

test('preserves durable FIFO when a later CardKit create finishes first', async () => {
  const fixture = createFixture();
  let releaseFirstCreate!: () => void;
  fixture.cards.nextCreateGate = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  const first = fixture.orchestrator.handleInbound(
    message('event-first', 'message-first', 'root-first', 'First task'),
  );
  try {
    await waitFor(() => fixture.cards.operations.length === 1);

    const second = await fixture.orchestrator.handleInbound(
      message('event-second', 'message-second', 'root-second', 'Second task'),
    );
    assert.equal(second.type, 'queued');
    assert.deepEqual(fixture.appServer.methods, []);

    releaseFirstCreate();
    const firstOutcome = await first;
    assert.equal(firstOutcome.type, 'started');
    assert.deepEqual(fixture.appServer.methods, ['thread/resume', 'turn/start']);

    const repositories = new BridgeRepositories(fixture.database);
    assert.equal(repositories.tasks.findByTurnId('turn-test')?.prompt, 'First task');
    assert.equal(repositories.tasks.findNextQueued()?.prompt, 'Second task');
  } finally {
    releaseFirstCreate();
    await Promise.allSettled([first]);
    dispose(fixture);
  }
});

test('cancelling a queued task atomically completes its source inbox', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    await fixture.orchestrator.handleInbound(
      message('event-queued', 'message-queued', 'root-queued', 'Queued task'),
    );
    const repositories = new BridgeRepositories(fixture.database);
    const queued = repositories.tasks.findNextQueued();
    assert.ok(queued);
    repositories.tasks.requestCancellation(queued.id, 20_000);

    await fixture.orchestrator.interruptTask(queued.id);

    const interrupted = repositories.tasks.getById(queued.id);
    const inbox = repositories.inbox.getById(queued.sourceInboxId);
    assert.equal(interrupted?.status, 'INTERRUPTED');
    assert.equal(interrupted?.errorCode, 'CANCELLED_BEFORE_START');
    assert.equal(inbox?.status, 'PROCESSED');
    assert.equal(inbox?.errorCode, 'CANCELLED_BEFORE_START');
  } finally {
    dispose(fixture);
  }
});

test('queued cancellation rolls back when its source inbox cannot complete', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    await fixture.orchestrator.handleInbound(
      message('event-queued-rollback', 'message-queued-rollback', 'root-queued', 'Queued task'),
    );
    const repositories = new BridgeRepositories(fixture.database);
    const queued = repositories.tasks.findNextQueued();
    assert.ok(queued);
    assert.equal(repositories.inbox.transition(
      queued.sourceInboxId,
      'ACCEPTED',
      'REJECTED',
      20_000,
      'TEST_INCONSISTENT_INBOX',
    ), true);

    await assert.rejects(
      fixture.orchestrator.interruptTask(queued.id),
      /source inbox could not enter processed state/,
    );

    assert.equal(repositories.tasks.getById(queued.id)?.status, 'QUEUED');
    assert.equal(repositories.inbox.getById(queued.sourceInboxId)?.status, 'REJECTED');
  } finally {
    dispose(fixture);
  }
});

test('surfaces an unknown steer outcome without causing the Lark event to retry', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    fixture.appServer.failAfterSendMethod = 'turn/steer';

    const outcome = await fixture.orchestrator.handleInbound(
      message('event-unknown-steer', 'message-unknown-steer', 'root-1', 'One more constraint'),
    );
    const inbox = fixture.database.prepare(`
      SELECT status, error_code AS errorCode
      FROM inbox_event
      WHERE event_id = ?
    `).get('event-unknown-steer');
    const task = new BridgeRepositories(fixture.database).tasks.findByTurnId('turn-test');

    assert.equal(outcome.type, 'steer_unknown');
    assert.equal(inbox?.status, 'PROCESSED');
    assert.equal(inbox?.errorCode, 'STEER_OUTCOME_UNKNOWN');
    assert.equal(task?.errorCode, 'STEER_OUTCOME_UNKNOWN');
    assert.ok(fixture.projections.requests.some(([taskId, immediate]) => (
      taskId === task?.id && immediate
    )));
  } finally {
    dispose(fixture);
  }
});

test('persists and replays a steer when transport proves no bytes were sent', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    fixture.appServer.failBeforeSendMethod = 'turn/steer';
    const pendingMessage = message(
      'event-pending-steer',
      'message-pending-steer',
      'root-1',
      'Durable follow-up text',
    );

    const pending = await fixture.orchestrator.handleInbound(pendingMessage);
    const repositories = new BridgeRepositories(fixture.database);
    const inbox = fixture.database.prepare(`
      SELECT id, status, payload_text AS payloadText
      FROM inbox_event
      WHERE event_id = ?
    `).get(pendingMessage.eventId);
    const intentBeforeRecovery = repositories.rpcIntents.findByOperationKey(
      `inbox:${String(inbox?.id)}:turn-steer`,
    );

    assert.equal(pending.type, 'steer_pending');
    assert.equal(inbox?.status, 'ACCEPTED');
    assert.equal(inbox?.payloadText, pendingMessage.text);
    assert.equal(intentBeforeRecovery?.state, 'FAILED');
    assert.equal(intentBeforeRecovery?.rpcId, null);

    const recovered = await fixture.orchestrator.recoverUnsentSteer(String(inbox?.id));
    const intentAfterRecovery = repositories.rpcIntents.findByOperationKey(
      `inbox:${String(inbox?.id)}:turn-steer`,
    );

    assert.equal(recovered.type, 'steered');
    assert.equal(repositories.inbox.getById(String(inbox?.id))?.status, 'PROCESSED');
    assert.equal(intentAfterRecovery?.state, 'RESOLVED');
    assert.equal(
      fixture.appServer.methods.filter((method) => method === 'turn/steer').length,
      1,
    );
  } finally {
    dispose(fixture);
  }
});

test('rejects new independent work before CardKit side effects when the queue is full', async () => {
  const fixture = createFixture({ maxQueuedTasks: 1 });
  try {
    await fixture.orchestrator.handleInbound(message());
    const queued = await fixture.orchestrator.handleInbound(
      message('event-capacity-1', 'message-capacity-1', 'root-capacity-1', 'Queued task'),
    );
    const rejected = await fixture.orchestrator.handleInbound(
      message('event-capacity-2', 'message-capacity-2', 'root-capacity-2', 'Rejected task'),
    );
    const rejectedInbox = fixture.database.prepare(`
      SELECT status, error_code AS errorCode
      FROM inbox_event
      WHERE event_id = 'event-capacity-2'
    `).get();
    const taskCount = fixture.database.prepare('SELECT COUNT(*) AS count FROM task').get()?.count;

    assert.equal(queued.type, 'queued');
    assert.equal(rejected.type, 'rejected_capacity');
    assert.equal(rejectedInbox?.status, 'REJECTED');
    assert.equal(rejectedInbox?.errorCode, 'QUEUE_CAPACITY_EXCEEDED');
    assert.equal(taskCount, 2);
    assert.deepEqual(fixture.cards.operations, [
      'card:create',
      'card:reply',
      'card:create',
      'card:reply',
    ]);
  } finally {
    dispose(fixture);
  }
});

test('re-enables cancellation after a definitive interrupt rejection', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    const repositories = new BridgeRepositories(fixture.database);
    const task = repositories.tasks.findByTurnId('turn-test');
    assert.ok(task);
    repositories.tasks.requestCancellation(task.id, 20_000);
    fixture.appServer.rpcFailureMethod = 'turn/interrupt';

    await assert.rejects(() => fixture.orchestrator.interruptTask(task.id));

    assert.equal(repositories.tasks.getById(task.id)?.cancelRequested, false);
    repositories.tasks.requestCancellation(task.id, 20_001);
    fixture.appServer.rpcFailureMethod = undefined;

    await fixture.orchestrator.interruptTask(task.id);

    assert.equal(repositories.tasks.getById(task.id)?.cancelRequested, true);
    assert.equal(
      fixture.appServer.methods.filter((method) => method === 'turn/interrupt').length,
      2,
    );
  } finally {
    dispose(fixture);
  }
});

test('does not start the model when the initial CardKit card cannot be created', async () => {
  const fixture = createFixture();
  fixture.cards.failCreate = true;
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const status = fixture.database.prepare('SELECT status FROM task').get()?.status;

    assert.equal(result.type, 'failed');
    assert.equal(status, 'FAILED');
    assert.deepEqual(fixture.appServer.methods, []);
  } finally {
    dispose(fixture);
  }
});

test('marks a PREPARED RPC failed when transport write provably never started', async () => {
  const fixture = createFixture();
  fixture.appServer.failBeforeSendMethod = 'thread/resume';
  try {
    const result = await fixture.orchestrator.handleInbound(message());
    const intent = fixture.database.prepare(`
      SELECT state, rpc_id AS rpcId FROM rpc_intent WHERE method = 'thread/resume'
    `).get();

    assert.equal(result.type, 'failed');
    assert.equal(intent?.state, 'FAILED');
    assert.equal(intent?.rpcId, null);
  } finally {
    dispose(fixture);
  }
});

test('abandons the early notification window when turn/start is rejected', async () => {
  const fixture = createFixture();
  fixture.appServer.rpcFailureMethod = 'turn/start';
  try {
    const result = await fixture.orchestrator.handleInbound(message());

    assert.equal(result.type, 'failed');
    assert.deepEqual(fixture.turnEvents.calls.map((call) => call.kind), [
      'begin',
      'abandon',
    ]);
  } finally {
    dispose(fixture);
  }
});

test('skips a definitively failed queued task and starts the next durable task', async () => {
  const fixture = createFixture();
  try {
    await fixture.orchestrator.handleInbound(message());
    await fixture.orchestrator.handleInbound(
      message('event-queued-1', 'message-queued-1', 'root-queued-1', 'First queued task'),
    );
    await fixture.orchestrator.handleInbound(
      message('event-queued-2', 'message-queued-2', 'root-queued-2', 'Second queued task'),
    );
    const repositories = new BridgeRepositories(fixture.database);
    const active = repositories.tasks.findByTurnId('turn-test');
    assert.ok(active);
    repositories.tasks.transition(active.id, 'RUNNING', 'SUCCEEDED', 30_000);
    fixture.appServer.failBeforeSendMethod = 'thread/resume';
    fixture.appServer.turnResponseId = 'turn-next';

    const startedTaskId = await fixture.orchestrator.startNextQueued();
    const firstQueued = fixture.database.prepare(`
      SELECT status FROM task WHERE prompt = 'First queued task'
    `).get();
    const secondQueued = fixture.database.prepare(`
      SELECT id, status, turn_id AS turnId FROM task WHERE prompt = 'Second queued task'
    `).get();

    assert.equal(firstQueued?.status, 'FAILED');
    assert.equal(secondQueued?.status, 'RUNNING');
    assert.equal(secondQueued?.turnId, 'turn-next');
    assert.equal(startedTaskId, secondQueued?.id);
  } finally {
    dispose(fixture);
  }
});

test('recovery resumes a durable thread before starting a never-sent turn', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    const inbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-recovery',
      messageId: 'message-recovery',
      chatId: 'chat-test',
      rootMessageId: 'root-recovery',
      senderOpenId: 'user-test',
      payloadDigest: 'digest-recovery',
      receivedAtMs: 9_100,
    }).record;
    repositories.inbox.transition(inbox.id, 'RECEIVED', 'ACCEPTED', 9_101);
    const binding = repositories.threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-recovery',
      projectId: 'project-recovery',
      workspacePath: config.codexCwd,
      threadId: 'thread-test',
      nowMs: 9_102,
    });
    const task = repositories.tasks.create({
      bindingId: binding.id,
      sourceInboxId: inbox.id,
      prompt: 'Recover this never-sent turn',
      status: 'STARTING',
      nowMs: 9_103,
    });

    await fixture.orchestrator.recoverUnsentDispatch(task.id, 'thread/resume');

    assert.deepEqual(fixture.appServer.methods, ['thread/resume', 'turn/start']);
    assert.equal(repositories.tasks.getById(task.id)?.status, 'RUNNING');
    assert.equal(repositories.tasks.getById(task.id)?.turnId, 'turn-test');
    const resumeIntent = fixture.database.prepare(`
      SELECT operation_key AS operationKey
      FROM rpc_intent
      WHERE method = 'thread/resume'
    `).get();
    assert.equal(
      resumeIntent?.operationKey,
      `${task.id}:thread-resume:recovery:runtime-orchestrator-test:7`,
    );
  } finally {
    dispose(fixture);
  }
});
