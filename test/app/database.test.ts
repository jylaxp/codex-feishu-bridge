import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { BridgeDatabase } from '../../src/app/db/database';
import {
  BridgeRepositories,
  RepositoryConflictError,
  type TaskRecord,
} from '../../src/app/db/repositories';
import { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from '../../src/app/db/schema';

interface TestDatabase {
  readonly root: string;
  readonly path: string;
  readonly database: BridgeDatabase;
}

function createTestDatabase(): TestDatabase {
  const root = mkdtempSync(join(tmpdir(), 'codex-bridge-db-'));
  const path = join(root, 'nested', 'bridge.db');
  const database = new BridgeDatabase(path);
  assert.equal(existsSync(join(root, 'nested')), false, 'constructor must not perform filesystem IO');
  database.open();
  return { root, path, database };
}

function disposeTestDatabase(testDatabase: TestDatabase): void {
  testDatabase.database.close();
  rmSync(testDatabase.root, { recursive: true, force: true });
}

function seedTask(
  repositories: BridgeRepositories,
  nowMs: number,
  threadId = 'codex-thread-test',
): TaskRecord {
  const inbox = repositories.inbox.record({
    tenantKey: 'tenant-test',
    eventId: `event-${nowMs}`,
    messageId: `message-${nowMs}`,
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    senderOpenId: 'user-test',
    payloadDigest: `digest-${nowMs}`,
    receivedAtMs: nowMs,
  }).record;
  const binding = repositories.threadBindings.getOrCreate({
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    projectId: 'project-test',
    workspacePath: '/workspace/test',
    threadId,
    nowMs,
  });
  return repositories.tasks.create({
    bindingId: binding.id,
    sourceInboxId: inbox.id,
    prompt: 'Run the requested task',
    nowMs,
  });
}

test('opens explicitly with hardened pragmas and idempotent disk migrations', () => {
  const testDatabase = createTestDatabase();
  try {
    assert.equal(testDatabase.database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(testDatabase.database.getPragmas(), {
      journalMode: 'wal',
      synchronous: 2,
      busyTimeoutMs: 5_000,
      foreignKeys: true,
      trustedSchema: false,
    });

    const tableCount = testDatabase.database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get()?.count;
    assert.equal(tableCount, 9);

    testDatabase.database.close();
    const reopened = new BridgeDatabase(testDatabase.path);
    reopened.open();
    try {
      assert.equal(reopened.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
      const reopenedTableCount = reopened.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).get()?.count;
      assert.equal(reopenedTableCount, 9);
    } finally {
      reopened.close();
    }
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('upgrades an empty v1 disk database through all current migrations', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-bridge-v1-db-'));
  const databasePath = join(root, 'nested', 'bridge.db');
  mkdirSync(join(root, 'nested'));
  const rawDatabase = new DatabaseSync(databasePath);
  try {
    rawDatabase.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT;
    `);
    const versionOneMigration = SCHEMA_MIGRATIONS.find((migration) => migration.version === 1);
    assert.ok(versionOneMigration);
    rawDatabase.exec(versionOneMigration.sql);
    rawDatabase.prepare(`
      INSERT INTO meta (key, value, updated_at_ms) VALUES ('schema_version', '1', 1)
    `).run();
  } finally {
    rawDatabase.close();
  }

  const database = new BridgeDatabase(databasePath);
  try {
    database.open();
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    const columns = database.prepare('PRAGMA table_info(approval)').all();
    assert.ok(columns.some((column) => column.name === 'action_token_hashes_json'));
    const taskColumns = database.prepare('PRAGMA table_info(task)').all();
    assert.ok(taskColumns.some((column) => column.name === 'cancel_token_hash'));
    const inboxColumns = database.prepare('PRAGMA table_info(inbox_event)').all();
    assert.ok(inboxColumns.some((column) => column.name === 'payload_text'));
    const chatBindingColumns = database.prepare('PRAGMA table_info(chat_thread_binding)').all();
    assert.ok(chatBindingColumns.some((column) => column.name === 'thread_id'));
    assert.ok(chatBindingColumns.some((column) => column.name === 'workspace_path'));
    assert.ok(chatBindingColumns.some((column) => column.name === 'revision'));
    const threadBindingIndexes = database.prepare('PRAGMA index_list(thread_binding)').all();
    assert.ok(threadBindingIndexes.some((index) => (
      index.name === 'idx_thread_binding_thread_id' && index.unique === 0
    )));
    assert.ok(!threadBindingIndexes.some((index) => index.name === 'uq_thread_binding_thread_id'));
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('chat bindings can be rebound explicitly and deleted within tenant scope', () => {
  const testDatabase = createTestDatabase();
  try {
    const chatBindings = new BridgeRepositories(testDatabase.database).chatThreadBindings;
    const created = chatBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'codex-thread-1',
      workspacePath: '/workspace/test',
      boundByOpenId: 'user-1',
      threadTitle: 'First task',
      nowMs: 2_000,
    });
    assert.deepEqual(created, {
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'codex-thread-1',
      workspacePath: '/workspace/test',
      boundByOpenId: 'user-1',
      threadTitle: 'First task',
      revision: 1,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    assert.deepEqual(chatBindings.get('tenant-test', 'chat-test'), created);

    const rebound = chatBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'codex-thread-2',
      workspacePath: '/workspace/test-2',
      boundByOpenId: 'user-2',
      nowMs: 2_100,
    });
    assert.equal(rebound.threadId, 'codex-thread-2');
    assert.equal(rebound.boundByOpenId, 'user-2');
    assert.equal(rebound.threadTitle, null);
    assert.equal(rebound.workspacePath, '/workspace/test-2');
    assert.equal(rebound.revision, 2);
    assert.equal(rebound.createdAtMs, 2_000);
    assert.equal(rebound.updatedAtMs, 2_100);

    const otherTenant = chatBindings.upsert({
      tenantKey: 'tenant-other',
      chatId: 'chat-test',
      threadId: 'codex-thread-2',
      workspacePath: '/workspace/other',
      boundByOpenId: 'user-3',
      nowMs: 2_200,
    });
    assert.equal(otherTenant.threadId, 'codex-thread-2');
    assert.equal(chatBindings.delete('tenant-test', 'chat-test', 2_300), true);
    assert.equal(chatBindings.getRevision('tenant-test', 'chat-test'), 3);
    assert.equal(chatBindings.delete('tenant-test', 'chat-test', 2_400), false);
    assert.equal(chatBindings.getRevision('tenant-test', 'chat-test'), 4);
    assert.equal(chatBindings.get('tenant-test', 'chat-test'), undefined);
    assert.equal(chatBindings.get('tenant-other', 'chat-test')?.threadId, 'codex-thread-2');
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('root bindings pin the initial thread while allowing roots to share a thread', () => {
  const testDatabase = createTestDatabase();
  try {
    const threadBindings = new BridgeRepositories(testDatabase.database).threadBindings;
    const first = threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-1',
      projectId: 'project-test',
      workspacePath: '/workspace/test',
      threadId: 'codex-thread-shared',
      nowMs: 3_000,
    });
    const second = threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-2',
      projectId: 'project-test',
      workspacePath: '/workspace/test',
      threadId: 'codex-thread-shared',
      nowMs: 3_100,
    });
    assert.notEqual(first.id, second.id);
    assert.equal(first.threadId, 'codex-thread-shared');
    assert.equal(second.threadId, 'codex-thread-shared');

    const replayAfterChatRebind = threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-1',
      projectId: 'project-test',
      workspacePath: '/workspace/test',
      threadId: 'codex-thread-new',
      nowMs: 3_200,
    });
    assert.equal(replayAfterChatRebind.id, first.id);
    assert.equal(replayAfterChatRebind.threadId, 'codex-thread-shared');
    assert.equal(replayAfterChatRebind.updatedAtMs, 3_000);

    testDatabase.database.prepare(`
      INSERT INTO thread_binding (
        id, tenant_key, chat_id, root_message_id, project_id, workspace_path,
        thread_id, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      'binding-null-root',
      'tenant-test',
      'chat-test',
      'root-null',
      'project-test',
      '/workspace/test',
      3_300,
      3_300,
    );
    const recoveredNullRoot = threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-null',
      projectId: 'project-test',
      workspacePath: '/workspace/test',
      threadId: 'codex-thread-selected',
      nowMs: 3_400,
    });
    assert.equal(recoveredNullRoot.id, 'binding-null-root');
    assert.equal(recoveredNullRoot.threadId, 'codex-thread-selected');
    assert.equal(recoveredNullRoot.updatedAtMs, 3_400);
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('BEGIN IMMEDIATE transaction rolls back the complete repository unit of work', () => {
  const testDatabase = createTestDatabase();
  try {
    assert.throws(() => {
      testDatabase.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        repositories.inbox.record({
          tenantKey: 'tenant-test',
          eventId: 'event-rollback',
          messageId: 'message-rollback',
          chatId: 'chat-test',
          rootMessageId: 'root-test',
          payloadDigest: 'digest-rollback',
          receivedAtMs: 1_000,
        });
        throw new Error('force rollback');
      });
    }, /force rollback/);
    assert.equal(new BridgeRepositories(testDatabase.database).inbox.count(), 0);
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('inbox event identity is idempotent and rejects a mismatched replay', () => {
  const testDatabase = createTestDatabase();
  try {
    const inbox = new BridgeRepositories(testDatabase.database).inbox;
    const input = {
      tenantKey: 'tenant-test',
      eventId: 'event-unique',
      messageId: 'message-unique',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      senderOpenId: 'user-test',
      payloadDigest: 'digest-original',
      payloadText: 'durable text',
      receivedAtMs: 2_000,
    } as const;

    const first = inbox.record(input);
    const replay = inbox.record(input);
    assert.equal(first.created, true);
    assert.equal(first.record.payloadText, 'durable text');
    assert.equal(replay.created, false);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(inbox.count(), 1);

    assert.throws(
      () => inbox.record({ ...input, payloadDigest: 'digest-tampered' }),
      (error: unknown) => (
        error instanceof RepositoryConflictError
        && error.code === 'INBOX_IDENTITY_CONFLICT'
      ),
    );
    assert.equal(inbox.count(), 1);
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('integration lookups return thread, active task, next queue, and ordered items', () => {
  const testDatabase = createTestDatabase();
  try {
    const repositories = new BridgeRepositories(testDatabase.database);
    const activeTask = seedTask(repositories, 2_500, 'codex-thread-1');
    const binding = repositories.threadBindings.getById(activeTask.bindingId);
    assert.ok(binding);
    assert.equal(repositories.tasks.bindTurn(activeTask.id, 'turn-1', 2_502), true);
    assert.equal(
      repositories.tasks.transition(activeTask.id, 'RECEIVED', 'STARTING', 2_503),
      true,
    );

    assert.equal(
      repositories.threadBindings.findByLarkRoot(
        'tenant-test',
        'chat-test',
        'root-test',
      )?.id,
      binding.id,
    );
    assert.equal(repositories.tasks.findByTurnId('turn-1')?.id, activeTask.id);
    assert.equal(repositories.tasks.findActiveByBindingId(binding.id)?.id, activeTask.id);
    assert.equal(repositories.tasks.findAnyActive()?.id, activeTask.id);
    assert.deepEqual(repositories.tasks.findActive().map((task) => task.id), [activeTask.id]);

    const firstQueued = seedTask(repositories, 2_600);
    const secondQueued = seedTask(repositories, 2_700);
    assert.equal(repositories.tasks.transition(firstQueued.id, 'RECEIVED', 'QUEUED', 2_601), true);
    assert.equal(repositories.tasks.transition(secondQueued.id, 'RECEIVED', 'QUEUED', 2_701), true);
    assert.equal(repositories.tasks.findNextQueued()?.id, firstQueued.id);

    repositories.taskItems.upsert({
      taskId: activeTask.id,
      itemId: 'item-second',
      itemType: 'agentMessage',
      status: 'STARTED',
      contentText: 'second',
      nowMs: 2_900,
    });
    repositories.taskItems.upsert({
      taskId: activeTask.id,
      itemId: 'item-first',
      itemType: 'reasoning',
      status: 'COMPLETED',
      contentText: 'first',
      nowMs: 2_800,
    });
    const terminalReplay = repositories.taskItems.upsert({
      taskId: activeTask.id,
      itemId: 'item-first',
      itemType: 'reasoning',
      status: 'FAILED',
      contentText: 'late conflicting terminal state',
      nowMs: 3_000,
    });
    assert.equal(terminalReplay.status, 'COMPLETED');
    assert.equal(terminalReplay.contentText, 'first');
    assert.deepEqual(
      repositories.taskItems.listByTaskId(activeTask.id).map((item) => item.itemId),
      ['item-first', 'item-second'],
    );
    assert.equal(repositories.tasks.transition(activeTask.id, 'STARTING', 'RECOVERING', 3_100), true);
    assert.deepEqual(repositories.tasks.findRecovering().map((task) => task.id), [activeTask.id]);
    assert.equal(repositories.tasks.attachCard(activeTask.id, 'card-1', 'card-message-1', 3_101), true);
    assert.equal(
      repositories.tasks.attachCancelTokenHash(activeTask.id, 'cancel-token-hash', 3_102),
      true,
    );
    assert.equal(
      repositories.tasks.findCancellationTarget(
        'cancel-token-hash',
        'tenant-test',
        'wrong-chat',
        'card-message-1',
      ),
      undefined,
    );
    assert.equal(
      repositories.tasks.consumeCancellation({
        tokenHash: 'cancel-token-hash',
        tenantKey: 'tenant-test',
        chatId: 'chat-test',
        cardMessageId: 'card-message-1',
        operatorOpenId: 'user-test',
        allowPrivilegedCancellation: false,
        updatedAtMs: 3_103,
      })?.id,
      activeTask.id,
    );
    assert.equal(
      repositories.tasks.consumeCancellation({
        tokenHash: 'cancel-token-hash',
        tenantKey: 'tenant-test',
        chatId: 'chat-test',
        cardMessageId: 'card-message-1',
        operatorOpenId: 'user-test',
        allowPrivilegedCancellation: false,
        updatedAtMs: 3_104,
      }),
      undefined,
    );
    assert.equal(repositories.tasks.transition(activeTask.id, 'RECOVERING', 'SUCCEEDED', 3_105), true);
    assert.equal(repositories.tasks.attachCancelTokenHash(activeTask.id, 'late-token', 3_106), false);
    assert.equal(repositories.tasks.transition(activeTask.id, 'SUCCEEDED', 'RUNNING', 3_107), false);
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('approval decision is scoped and consumed with compare-and-set semantics', () => {
  const testDatabase = createTestDatabase();
  try {
    const repositories = new BridgeRepositories(testDatabase.database);
    const task = seedTask(repositories, 3_000);
    const approval = repositories.approvals.createPending({
      taskId: task.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'card-test',
      connectionEpoch: 7,
      requestId: 'rpc-request-1',
      method: 'item/commandExecution/requestApproval',
      itemId: 'item-1',
      decisionTokenHashes: {
        accept: 'sha256-accept-token',
        decline: 'sha256-decline-token',
      },
      expiresAtMs: 10_000,
      nowMs: 3_000,
    });
    assert.equal(
      repositories.approvals.findPendingByDecisionTokenHash(
        'accept',
        'sha256-accept-token',
        3_500,
      )?.approval.id,
      approval.id,
    );
    assert.equal(
      repositories.approvals.findPendingByDecisionTokenHash(
        'decline',
        'sha256-accept-token',
        3_500,
      ),
      undefined,
    );
    assert.equal(
      repositories.approvals.findPendingByDecisionTokenHash(
        'accept',
        'sha256-accept-token',
        10_001,
      ),
      undefined,
    );

    const wrongScope = repositories.approvals.decide({
      approvalId: approval.id,
      tenantKey: 'tenant-test',
      chatId: 'other-chat',
      cardId: 'card-test',
      connectionEpoch: 7,
      actionTokenHash: 'sha256-accept-token',
      decision: 'accept',
      decidedByOpenId: 'approver-test',
      nowMs: 4_000,
    });
    assert.equal(wrongScope, false);

    const wrongDecisionToken = repositories.approvals.decide({
      approvalId: approval.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'card-test',
      connectionEpoch: 7,
      actionTokenHash: 'sha256-decline-token',
      decision: 'accept',
      decidedByOpenId: 'approver-test',
      nowMs: 4_001,
    });
    assert.equal(wrongDecisionToken, false);

    const accepted = repositories.approvals.decide({
      approvalId: approval.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'card-test',
      connectionEpoch: 7,
      actionTokenHash: 'sha256-accept-token',
      decision: 'accept',
      decidedByOpenId: 'approver-test',
      nowMs: 4_002,
    });
    const replay = repositories.approvals.decide({
      approvalId: approval.id,
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      cardId: 'card-test',
      connectionEpoch: 7,
      actionTokenHash: 'sha256-decline-token',
      decision: 'decline',
      decidedByOpenId: 'approver-test',
      nowMs: 4_003,
    });

    assert.equal(accepted, true);
    assert.equal(replay, false);
    assert.equal(repositories.approvals.getById(approval.id)?.decision, 'accept');
    assert.equal(
      repositories.approvals.findPendingByDecisionTokenHash(
        'accept',
        'sha256-accept-token',
        4_004,
      ),
      undefined,
    );
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('outbox claims survive reopen and expired leases are reclaimed', () => {
  const testDatabase = createTestDatabase();
  try {
    const repositories = new BridgeRepositories(testDatabase.database);
    const task = seedTask(repositories, 5_000);
    const queued = repositories.cardOutbox.enqueue({
      taskId: task.id,
      operation: 'UPDATE_CARD',
      projectionRevision: 1,
      cardSequence: 0,
      idempotencyKey: 'outbox-idempotency-1',
      payloadJson: '{"status":"running"}',
      nowMs: 5_100,
    });
    const firstClaim = repositories.cardOutbox.claimDue('worker-a', 5_100, 1_000, 10);
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0]?.id, queued.id);
    assert.equal(firstClaim[0]?.attemptCount, 1);

    testDatabase.database.close();
    const reopened = new BridgeDatabase(testDatabase.path);
    reopened.open();
    try {
      const reopenedOutbox = new BridgeRepositories(reopened).cardOutbox;
      assert.equal(reopenedOutbox.claimDue('worker-b', 6_100, 1_000, 10).length, 0);
      const reclaimed = reopenedOutbox.claimDue('worker-b', 6_101, 1_000, 10);
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]?.id, queued.id);
      assert.equal(reclaimed[0]?.leaseOwner, 'worker-b');
      assert.equal(reclaimed[0]?.attemptCount, 2);
      assert.equal(reopenedOutbox.markDelivered(queued.id, 'worker-a', 6_102), false);
      assert.equal(reopenedOutbox.markDelivered(queued.id, 'worker-b', 6_102), true);

      const conflicting = reopenedOutbox.enqueue({
        taskId: task.id,
        operation: 'UPDATE_CARD',
        projectionRevision: 2,
        cardSequence: 1,
        idempotencyKey: 'outbox-idempotency-2',
        payloadJson: '{"status":"completed"}',
        nowMs: 6_200,
      });
      assert.equal(reopenedOutbox.claimDue('worker-c', 6_200, 1_000, 10).length, 1);
      assert.equal(reopenedOutbox.markSequenceConflict(conflicting.id, 'worker-a', 6_201), false);
      assert.equal(reopenedOutbox.markSequenceConflict(conflicting.id, 'worker-c', 6_201), true);
      const terminal = reopenedOutbox.findByIdempotencyKey('outbox-idempotency-2');
      assert.equal(terminal?.state, 'FAILED');
      assert.equal(terminal?.lastErrorCode, 'CARD_SEQUENCE_CONFLICT');
      assert.equal(reopenedOutbox.claimDue('worker-d', 10_000, 1_000, 10).length, 0);

      const inFlight = reopenedOutbox.enqueue({
        taskId: task.id,
        operation: 'UPDATE_CARD',
        projectionRevision: 3,
        cardSequence: 1,
        idempotencyKey: 'outbox-idempotency-3',
        payloadJson: '{"revision":3}',
        nowMs: 10_100,
      });
      reopenedOutbox.enqueue({
        taskId: task.id,
        operation: 'UPDATE_CARD',
        projectionRevision: 4,
        cardSequence: 1,
        idempotencyKey: 'outbox-idempotency-4',
        payloadJson: '{"revision":4}',
        nowMs: 10_101,
      });
      reopenedOutbox.enqueue({
        taskId: task.id,
        operation: 'UPDATE_CARD',
        projectionRevision: 5,
        cardSequence: 1,
        idempotencyKey: 'outbox-idempotency-5',
        payloadJson: '{"revision":5}',
        nowMs: 10_102,
      });
      assert.equal(reopenedOutbox.claimDue('worker-e', 10_102, 1_000, 1)[0]?.id, inFlight.id);
      assert.equal(reopenedOutbox.supersedePendingBeforeRevision(task.id, 5, 10_103), 1);
      assert.equal(reopenedOutbox.findByIdempotencyKey('outbox-idempotency-3')?.state, 'IN_FLIGHT');
      assert.equal(reopenedOutbox.findByIdempotencyKey('outbox-idempotency-4')?.state, 'SUPERSEDED');
      assert.equal(reopenedOutbox.findByIdempotencyKey('outbox-idempotency-5')?.state, 'PENDING');
    } finally {
      reopened.close();
    }
  } finally {
    disposeTestDatabase(testDatabase);
  }
});

test('card delivery sequence acknowledgement and final close checkpoint are atomic', () => {
  const testDatabase = createTestDatabase();
  try {
    const repositories = new BridgeRepositories(testDatabase.database);
    const task = seedTask(repositories, 20_000);
    const update = repositories.cardOutbox.enqueue({
      taskId: task.id,
      operation: 'UPDATE_CARD',
      projectionRevision: 1,
      cardSequence: 0,
      idempotencyKey: 'atomic-update',
      payloadJson: '{}',
      nowMs: 20_001,
    });
    repositories.cardOutbox.claimDue('worker-a', 20_001, 100, 1);

    assert.equal(repositories.cardOutbox.acknowledgeDeliveredSequence(
      update.id,
      'wrong-worker',
      task.id,
      0,
      1,
      20_002,
    ), false);
    assert.equal(repositories.tasks.getById(task.id)?.cardSequence, 0);
    assert.equal(repositories.cardOutbox.findByIdempotencyKey('atomic-update')?.state, 'IN_FLIGHT');

    assert.equal(repositories.cardOutbox.acknowledgeDeliveredSequence(
      update.id,
      'worker-a',
      task.id,
      0,
      1,
      20_003,
    ), true);
    assert.equal(repositories.tasks.getById(task.id)?.cardSequence, 1);
    assert.equal(repositories.cardOutbox.findByIdempotencyKey('atomic-update')?.state, 'DELIVERED');

    const finalization = repositories.cardOutbox.enqueue({
      taskId: task.id,
      operation: 'FINALIZE_CARD',
      projectionRevision: 2,
      cardSequence: 1,
      idempotencyKey: 'atomic-final',
      payloadJson: '{}',
      nowMs: 20_010,
    });
    repositories.cardOutbox.claimDue('worker-b', 20_010, 100, 1);
    assert.equal(repositories.cardOutbox.checkpointFinalClose(
      finalization.id,
      'worker-b',
      task.id,
      1,
      2,
      20_011,
    ), true);
    assert.equal(repositories.tasks.getById(task.id)?.cardSequence, 2);
    const checkpoint = repositories.cardOutbox.findByIdempotencyKey('atomic-final');
    assert.equal(checkpoint?.operation, 'FINALIZE_CARD_REPLACE');
    assert.equal(checkpoint?.cardSequence, 2);
    assert.equal(checkpoint?.state, 'IN_FLIGHT');

    testDatabase.database.close();
    const reopened = new BridgeDatabase(testDatabase.path);
    reopened.open();
    try {
      const reclaimed = new BridgeRepositories(reopened).cardOutbox.claimDue(
        'worker-c',
        20_111,
        100,
        1,
      );
      assert.equal(reclaimed[0]?.operation, 'FINALIZE_CARD_REPLACE');
      assert.equal(reclaimed[0]?.cardSequence, 2);
    } finally {
      reopened.close();
    }
  } finally {
    if (testDatabase.database.isOpen) {
      disposeTestDatabase(testDatabase);
    } else {
      rmSync(testDatabase.root, { recursive: true, force: true });
    }
  }
});
