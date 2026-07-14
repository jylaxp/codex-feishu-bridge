import { randomUUID } from 'node:crypto';
import { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import type { ApprovalDecision, TaskItemStatus, TaskStatus } from '../domain';
import { DatabaseExecutor } from './database';

export type { ApprovalDecision, TaskItemStatus, TaskStatus } from '../domain';

export type InboxStatus = 'RECEIVED' | 'ACCEPTED' | 'PROCESSED' | 'REJECTED';
export type RpcIntentState = 'PREPARED' | 'SENT' | 'RESOLVED' | 'FAILED' | 'UNKNOWN';
export type ApprovalStatus = 'PENDING' | 'DECIDED' | 'EXPIRED' | 'STALE' | 'CANCELLED';
export type DecisionTokenHashes = Readonly<Partial<Record<ApprovalDecision, string>>>;
export type CardOutboxState =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'RETRY'
  | 'DELIVERED'
  | 'SUPERSEDED'
  | 'FAILED';

export const APPROVAL_RESPONSE_RPC_METHOD = 'approval/respond';

interface TransactionalDatabaseExecutor extends DatabaseExecutor {
  transaction<T>(work: (executor: DatabaseExecutor) => T): T;
}

class AtomicCardDeliveryError extends Error {}

export type RepositoryConflictCode =
  | 'INBOX_IDENTITY_CONFLICT'
  | 'THREAD_BINDING_CONFLICT'
  | 'RPC_INTENT_CONFLICT'
  | 'OUTBOX_IDEMPOTENCY_CONFLICT';

/** Conflict caused by replaying an idempotency identity with different data. */
export class RepositoryConflictError extends Error {
  public constructor(
    public readonly code: RepositoryConflictCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export interface InboxEventRecord {
  readonly id: string;
  readonly tenantKey: string;
  readonly eventId: string | null;
  readonly messageId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly senderOpenId: string | null;
  readonly payloadDigest: string;
  readonly payloadText: string | null;
  readonly status: InboxStatus;
  readonly errorCode: string | null;
  readonly receivedAtMs: number;
  readonly updatedAtMs: number;
}

export interface RecordInboxEventInput {
  readonly tenantKey: string;
  readonly eventId?: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly senderOpenId?: string;
  readonly payloadDigest: string;
  readonly payloadText?: string;
  readonly receivedAtMs: number;
}

export interface RecordInboxEventResult {
  readonly record: InboxEventRecord;
  readonly created: boolean;
}

/** Idempotent storage for inbound Lark events. */
export class InboxEventRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Records one delivery, returning the existing row for an identical replay. */
  public record(input: RecordInboxEventInput): RecordInboxEventResult {
    const id = randomUUID();
    const result = this.executor.prepare(`
      INSERT INTO inbox_event (
        id, tenant_key, event_id, message_id, chat_id, root_message_id,
        sender_open_id, payload_digest, payload_text, status, received_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      id,
      input.tenantKey,
      input.eventId ?? null,
      input.messageId,
      input.chatId,
      input.rootMessageId,
      input.senderOpenId ?? null,
      input.payloadDigest,
      input.payloadText ?? null,
      input.receivedAtMs,
      input.receivedAtMs,
    );

    const created = changes(result.changes) === 1;
    const record = created
      ? this.getById(id)
      : this.findReplay(input.tenantKey, input.eventId, input.messageId);
    if (record === undefined) {
      throw new RepositoryConflictError(
        'INBOX_IDENTITY_CONFLICT',
        'Inbound event identity conflicted with an unrelated delivery',
      );
    }
    if (!isSameInboxIdentity(record, input)) {
      throw new RepositoryConflictError(
        'INBOX_IDENTITY_CONFLICT',
        'Inbound event replay does not match the original delivery',
      );
    }
    return { record, created };
  }

  /** Finds an inbound event by its internal UUID. */
  public getById(id: string): InboxEventRecord | undefined {
    return mapInboxRow(this.executor.prepare('SELECT * FROM inbox_event WHERE id = ?').get(id));
  }

  /** Performs a compare-and-set status transition. */
  public transition(
    id: string,
    expectedStatus: InboxStatus,
    nextStatus: InboxStatus,
    updatedAtMs: number,
    errorCode: string | null = null,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE inbox_event
      SET status = ?, updated_at_ms = ?, error_code = ?
      WHERE id = ? AND status = ?
    `).run(nextStatus, updatedAtMs, errorCode, id, expectedStatus);
    return changes(result.changes) === 1;
  }

  /** Returns the number of durable inbox rows. */
  public count(): number {
    return requireNumber(this.executor.prepare('SELECT COUNT(*) AS count FROM inbox_event').get(), 'count');
  }

  private findReplay(
    tenantKey: string,
    eventId: string | undefined,
    messageId: string,
  ): InboxEventRecord | undefined {
    const byMessage = mapInboxRow(this.executor.prepare(`
      SELECT * FROM inbox_event WHERE tenant_key = ? AND message_id = ?
    `).get(tenantKey, messageId));
    if (byMessage !== undefined) {
      return byMessage;
    }
    if (eventId === undefined) {
      return undefined;
    }
    return mapInboxRow(this.executor.prepare(`
      SELECT * FROM inbox_event WHERE tenant_key = ? AND event_id = ?
    `).get(tenantKey, eventId));
  }
}

export interface ThreadBindingRecord {
  readonly id: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly threadId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface GetOrCreateThreadBindingInput {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly threadId: string;
  readonly nowMs: number;
}

/** Persists the stable mapping from a Lark root message to a Codex thread. */
export class ThreadBindingRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Returns the existing binding or creates it exactly once. */
  public getOrCreate(input: GetOrCreateThreadBindingInput): ThreadBindingRecord {
    const id = randomUUID();
    this.executor.prepare(`
      INSERT INTO thread_binding (
        id, tenant_key, chat_id, root_message_id, project_id, workspace_path,
        thread_id, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_key, chat_id, root_message_id) DO NOTHING
    `).run(
      id,
      input.tenantKey,
      input.chatId,
      input.rootMessageId,
      input.projectId,
      input.workspacePath,
      input.threadId,
      input.nowMs,
      input.nowMs,
    );
    const row = this.executor.prepare(`
      SELECT * FROM thread_binding
      WHERE tenant_key = ? AND chat_id = ? AND root_message_id = ?
    `).get(input.tenantKey, input.chatId, input.rootMessageId);
    let record = requireThreadBinding(row);
    if (record.projectId !== input.projectId || record.workspacePath !== input.workspacePath) {
      throw new RepositoryConflictError(
        'THREAD_BINDING_CONFLICT',
        'Lark root message is already bound to a different project or workspace',
      );
    }
    if (record.threadId === null) {
      this.executor.prepare(`
        UPDATE thread_binding
        SET thread_id = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
        WHERE id = ? AND thread_id IS NULL
      `).run(input.threadId, input.nowMs, record.id);
      record = requireThreadBinding(this.executor.prepare(`
        SELECT * FROM thread_binding WHERE id = ?
      `).get(record.id));
    }
    return record;
  }

  /** Finds a binding by internal UUID. */
  public getById(id: string): ThreadBindingRecord | undefined {
    return mapThreadBindingRow(
      this.executor.prepare('SELECT * FROM thread_binding WHERE id = ?').get(id),
    );
  }

  /** Finds a binding using the tenant-scoped Lark root identity. */
  public findByLarkRoot(
    tenantKey: string,
    chatId: string,
    rootMessageId: string,
  ): ThreadBindingRecord | undefined {
    return mapThreadBindingRow(this.executor.prepare(`
      SELECT * FROM thread_binding
      WHERE tenant_key = ? AND chat_id = ? AND root_message_id = ?
    `).get(tenantKey, chatId, rootMessageId));
  }
}

export interface ChatThreadBindingRecord {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly workspacePath: string;
  readonly boundByOpenId: string;
  readonly threadTitle: string | null;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface UpsertChatThreadBindingInput {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly workspacePath: string;
  readonly boundByOpenId: string;
  readonly threadTitle?: string;
  readonly nowMs: number;
}

/** Persists the explicit mapping from a Lark chat to a user-selected ChatGPT thread. */
export class ChatThreadBindingRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Finds the selected ChatGPT thread for one tenant-scoped Lark chat. */
  public get(tenantKey: string, chatId: string): ChatThreadBindingRecord | undefined {
    return mapChatThreadBindingRow(this.executor.prepare(`
      SELECT * FROM chat_thread_binding
      WHERE tenant_key = ? AND chat_id = ? AND thread_id IS NOT NULL
    `).get(tenantKey, chatId));
  }

  /** Returns the monotonic generation, including after an explicit unbind. */
  public getRevision(tenantKey: string, chatId: string): number {
    const row = this.executor.prepare(`
      SELECT revision FROM chat_thread_binding
      WHERE tenant_key = ? AND chat_id = ?
    `).get(tenantKey, chatId);
    return row === undefined ? 0 : requireNumber(row, 'revision');
  }

  /** Creates or explicitly replaces the selected thread while preserving the initial bind time. */
  public upsert(input: UpsertChatThreadBindingInput): ChatThreadBindingRecord {
    this.executor.prepare(`
      INSERT INTO chat_thread_binding (
        tenant_key, chat_id, thread_id, workspace_path, bound_by_open_id, thread_title,
        revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (tenant_key, chat_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        workspace_path = excluded.workspace_path,
        bound_by_open_id = excluded.bound_by_open_id,
        thread_title = excluded.thread_title,
        revision = chat_thread_binding.revision + 1,
        updated_at_ms = MAX(chat_thread_binding.updated_at_ms + 1, excluded.updated_at_ms)
    `).run(
      input.tenantKey,
      input.chatId,
      input.threadId,
      input.workspacePath,
      input.boundByOpenId,
      input.threadTitle ?? null,
      input.nowMs,
      input.nowMs,
    );
    return requireChatThreadBinding(this.executor.prepare(`
      SELECT * FROM chat_thread_binding
      WHERE tenant_key = ? AND chat_id = ?
    `).get(input.tenantKey, input.chatId));
  }

  /** Clears the active binding while retaining and advancing its anti-replay generation. */
  public delete(tenantKey: string, chatId: string, nowMs: number): boolean {
    const removed = this.get(tenantKey, chatId) !== undefined;
    this.executor.prepare(`
      INSERT INTO chat_thread_binding (
        tenant_key, chat_id, thread_id, workspace_path, bound_by_open_id, thread_title,
        revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, 1, ?, ?)
      ON CONFLICT (tenant_key, chat_id) DO UPDATE SET
        thread_id = NULL,
        workspace_path = NULL,
        bound_by_open_id = NULL,
        thread_title = NULL,
        revision = chat_thread_binding.revision + 1,
        updated_at_ms = MAX(chat_thread_binding.updated_at_ms + 1, excluded.updated_at_ms)
    `).run(tenantKey, chatId, nowMs, nowMs);
    return removed;
  }
}

export interface TaskRecord {
  readonly id: string;
  readonly bindingId: string;
  readonly sourceInboxId: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly turnId: string | null;
  readonly cardId: string | null;
  readonly cardMessageId: string | null;
  readonly cardSequence: number;
  readonly projectionRevision: number;
  readonly finalText: string | null;
  readonly errorCode: string | null;
  readonly cancelRequested: boolean;
  readonly cancelTokenHash?: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface CreateTaskInput {
  readonly bindingId: string;
  readonly sourceInboxId: string;
  readonly prompt: string;
  readonly status?: TaskStatus;
  readonly nowMs: number;
}

export interface ConsumeCancellationInput {
  readonly tokenHash: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly cardMessageId: string;
  readonly operatorOpenId: string;
  readonly allowPrivilegedCancellation: boolean;
  readonly updatedAtMs: number;
}

/** Durable task lifecycle operations. */
export class TaskRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Creates a task linked to one durable inbound event. */
  public create(input: CreateTaskInput): TaskRecord {
    const id = randomUUID();
    this.executor.prepare(`
      INSERT INTO task (
        id, binding_id, source_inbox_id, prompt, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.bindingId,
      input.sourceInboxId,
      input.prompt,
      input.status ?? 'RECEIVED',
      input.nowMs,
      input.nowMs,
    );
    return requireTask(this.executor.prepare('SELECT * FROM task WHERE id = ?').get(id));
  }

  /** Finds a task by internal UUID. */
  public getById(id: string): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare('SELECT * FROM task WHERE id = ?').get(id));
  }

  /** Finds the task bound to an App Server turn. */
  public findByTurnId(turnId: string): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare('SELECT * FROM task WHERE turn_id = ?').get(turnId));
  }

  /** Finds the active task for a root binding, if one exists. */
  public findActiveByBindingId(bindingId: string): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      SELECT *
      FROM task
      WHERE binding_id = ?
        AND status IN (
          'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETING',
          'DISPATCH_UNKNOWN', 'RECOVERING'
        )
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 1
    `).get(bindingId));
  }

  /** Returns the oldest globally queued task without mutating its state. */
  public findNextQueued(): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      SELECT *
      FROM task
      WHERE status = 'QUEUED'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 1
    `).get());
  }

  /** Returns the earliest not-yet-started task in durable insertion order. */
  public findOldestWaiting(): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      SELECT task.*
      FROM task
      WHERE status IN ('CARD_CREATING', 'QUEUED')
      ORDER BY task.rowid ASC
      LIMIT 1
    `).get());
  }

  /** Counts tasks waiting for an execution slot or initial CardKit identity. */
  public countWaiting(): number {
    return requireNumber(this.executor.prepare(`
      SELECT COUNT(*) AS count
      FROM task
      WHERE status IN ('CARD_CREATING', 'QUEUED')
    `).get(), 'count');
  }

  /** Lists tasks interrupted while the initial CardKit identity was being persisted. */
  public findCardCreating(): readonly TaskRecord[] {
    return this.executor.prepare(`
      SELECT * FROM task
      WHERE status = 'CARD_CREATING'
      ORDER BY created_at_ms ASC, id ASC
    `).all().map(requireTask);
  }

  /** Returns the globally active task, if one exists. */
  public findAnyActive(): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      SELECT * FROM task
      WHERE status IN (
        'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETING',
        'DISPATCH_UNKNOWN', 'RECOVERING'
      )
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 1
    `).get());
  }

  /** Lists all non-terminal active tasks for startup reconciliation. */
  public findActive(): readonly TaskRecord[] {
    return this.executor.prepare(`
      SELECT * FROM task
      WHERE status IN (
        'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETING',
        'DISPATCH_UNKNOWN', 'RECOVERING'
      )
      ORDER BY updated_at_ms ASC, id ASC
    `).all().map(requireTask);
  }

  /** Lists terminal tasks whose durable terminal card projection is missing. */
  public findTerminalWithoutOutbox(): readonly TaskRecord[] {
    return this.executor.prepare(`
      SELECT task.*
      FROM task
      WHERE task.status IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
        AND task.card_id IS NOT NULL
        AND task.card_message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM card_outbox
          WHERE card_outbox.idempotency_key = task.id || ':terminal'
        )
      ORDER BY task.updated_at_ms ASC, task.id ASC
    `).all().map(requireTask);
  }

  /** Lists tasks already marked for reconnect recovery. */
  public findRecovering(): readonly TaskRecord[] {
    return this.executor.prepare(`
      SELECT * FROM task
      WHERE status IN ('DISPATCH_UNKNOWN', 'RECOVERING')
      ORDER BY updated_at_ms ASC, id ASC
    `).all().map(requireTask);
  }

  /** Lists consumed cancellations whose authoritative turn is still active. */
  public findPendingCancellationsWithTurnIdentity(): readonly TaskRecord[] {
    return this.executor.prepare(`
      SELECT task.*
      FROM task
      INNER JOIN thread_binding ON thread_binding.id = task.binding_id
      WHERE task.cancel_requested = 1
        AND task.turn_id IS NOT NULL
        AND thread_binding.thread_id IS NOT NULL
        AND task.status IN ('RUNNING', 'AWAITING_APPROVAL', 'COMPLETING', 'RECOVERING')
      ORDER BY task.updated_at_ms ASC, task.id ASC
    `).all().map(requireTask);
  }

  /** Attaches a single-use cancellation token hash before task termination. */
  public attachCancelTokenHash(id: string, tokenHash: string, updatedAtMs: number): boolean {
    if (tokenHash.length === 0) {
      throw new RangeError('Cancellation token hash must be non-empty');
    }
    const result = this.executor.prepare(`
      UPDATE task
      SET cancel_token_hash = ?, updated_at_ms = ?
      WHERE id = ?
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
        AND cancel_requested = 0
        AND (cancel_token_hash IS NULL OR cancel_token_hash = ?)
    `).run(tokenHash, updatedAtMs, id, tokenHash);
    return changes(result.changes) === 1;
  }

  /** Finds an unconsumed cancellation target using its full Lark scope. */
  public findCancellationTarget(
    tokenHash: string,
    tenantKey: string,
    chatId: string,
    cardMessageId: string,
  ): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      SELECT task.*
      FROM task
      INNER JOIN thread_binding ON thread_binding.id = task.binding_id
      WHERE task.cancel_token_hash = ?
        AND task.cancel_requested = 0
        AND task.status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
        AND thread_binding.tenant_key = ?
        AND thread_binding.chat_id = ?
        AND task.card_message_id = ?
      LIMIT 1
    `).get(tokenHash, tenantKey, chatId, cardMessageId));
  }

  /** Atomically consumes a scoped cancellation token and returns its task. */
  public consumeCancellation(
    input: ConsumeCancellationInput,
  ): TaskRecord | undefined {
    return mapTaskRow(this.executor.prepare(`
      UPDATE task
      SET cancel_requested = 1, updated_at_ms = ?
      WHERE id = (
        SELECT task.id
        FROM task
        INNER JOIN thread_binding ON thread_binding.id = task.binding_id
        INNER JOIN inbox_event ON inbox_event.id = task.source_inbox_id
        WHERE task.cancel_token_hash = ?
          AND task.cancel_requested = 0
          AND task.status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
          AND thread_binding.tenant_key = ?
          AND thread_binding.chat_id = ?
          AND task.card_message_id = ?
          AND (? = 1 OR inbox_event.sender_open_id = ?)
        LIMIT 1
      )
      AND cancel_requested = 0
      AND status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
      RETURNING *
    `).get(
      input.updatedAtMs,
      input.tokenHash,
      input.tenantKey,
      input.chatId,
      input.cardMessageId,
      input.allowPrivilegedCancellation ? 1 : 0,
      input.operatorOpenId,
    ));
  }

  /** Re-enables a cancellation action after a provably definitive RPC failure. */
  public clearCancellationRequest(id: string, updatedAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET cancel_requested = 0, updated_at_ms = ?
      WHERE id = ?
        AND cancel_requested = 1
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
    `).run(updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /** Records or clears a non-terminal operational warning shown on the task card. */
  public setOperationalError(
    id: string,
    errorCode: string | null,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET error_code = ?, updated_at_ms = ?
      WHERE id = ?
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
    `).run(errorCode, updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /** Performs a compare-and-set lifecycle transition. */
  public transition(
    id: string,
    expectedStatus: TaskStatus,
    nextStatus: TaskStatus,
    updatedAtMs: number,
    terminal?: { readonly finalText?: string; readonly errorCode?: string },
  ): boolean {
    if (isTerminalTaskStatus(expectedStatus)) {
      return false;
    }
    const completedAtMs = isTerminalTaskStatus(nextStatus) ? updatedAtMs : null;
    const result = this.executor.prepare(`
      UPDATE task
      SET status = ?, updated_at_ms = ?, completed_at_ms = ?, final_text = ?, error_code = ?
      WHERE id = ? AND status = ?
    `).run(
      nextStatus,
      updatedAtMs,
      completedAtMs,
      terminal?.finalText ?? null,
      terminal?.errorCode ?? null,
      id,
      expectedStatus,
    );
    return changes(result.changes) === 1;
  }

  /** Binds an App Server turn without replacing a different turn. */
  public bindTurn(id: string, turnId: string, updatedAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET turn_id = ?, updated_at_ms = ?
      WHERE id = ? AND (turn_id IS NULL OR turn_id = ?)
    `).run(turnId, updatedAtMs, id, turnId);
    return changes(result.changes) === 1;
  }

  /** Persists the CardKit identity after the initial card is created. */
  public attachCard(
    id: string,
    cardId: string,
    cardMessageId: string,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET card_id = ?, card_message_id = ?, updated_at_ms = ?
      WHERE id = ?
        AND (
          (card_id IS NULL AND card_message_id IS NULL)
          OR (card_id = ? AND card_message_id = ?)
        )
    `).run(cardId, cardMessageId, updatedAtMs, id, cardId, cardMessageId);
    return changes(result.changes) === 1;
  }

  /** Atomically advances the persisted card sequence after a successful update. */
  public advanceCardSequence(
    id: string,
    expectedSequence: number,
    nextSequence: number,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET card_sequence = ?, updated_at_ms = ?
      WHERE id = ? AND card_sequence = ? AND ? > card_sequence
    `).run(nextSequence, updatedAtMs, id, expectedSequence, nextSequence);
    return changes(result.changes) === 1;
  }

  /** Increments the projection revision and returns the new value. */
  public incrementProjectionRevision(id: string, updatedAtMs: number): number | undefined {
    const row = this.executor.prepare(`
      UPDATE task
      SET projection_revision = projection_revision + 1, updated_at_ms = ?
      WHERE id = ?
      RETURNING projection_revision
    `).get(updatedAtMs, id);
    return optionalNumber(row, 'projection_revision');
  }

  /** Records a durable cancellation request once. */
  public requestCancellation(id: string, updatedAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE task
      SET cancel_requested = 1, updated_at_ms = ?
      WHERE id = ? AND cancel_requested = 0
    `).run(updatedAtMs, id);
    return changes(result.changes) === 1;
  }
}

export interface TaskItemRecord {
  readonly taskId: string;
  readonly itemId: string;
  readonly itemType: string;
  readonly phase: string | null;
  readonly status: TaskItemStatus;
  readonly contentText: string | null;
  readonly terminalPayloadJson: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface UpsertTaskItemInput {
  readonly taskId: string;
  readonly itemId: string;
  readonly itemType: string;
  readonly phase?: string;
  readonly status: TaskItemStatus;
  readonly contentText?: string;
  readonly terminalPayloadJson?: string;
  readonly nowMs: number;
}

/** Stores reduced App Server item state without per-token inserts. */
export class TaskItemRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Inserts or replaces the latest reduced item snapshot. */
  public upsert(input: UpsertTaskItemInput): TaskItemRecord {
    this.executor.prepare(`
      INSERT INTO task_item (
        task_id, item_id, item_type, phase, status, content_text,
        terminal_payload_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, item_id) DO UPDATE SET
        item_type = excluded.item_type,
        phase = excluded.phase,
        status = excluded.status,
        content_text = excluded.content_text,
        terminal_payload_json = excluded.terminal_payload_json,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.updated_at_ms >= task_item.updated_at_ms
        AND (
          task_item.status = 'STARTED'
          OR task_item.status = excluded.status
        )
    `).run(
      input.taskId,
      input.itemId,
      input.itemType,
      input.phase ?? null,
      input.status,
      input.contentText ?? null,
      input.terminalPayloadJson ?? null,
      input.nowMs,
      input.nowMs,
    );
    return requireTaskItem(this.executor.prepare(`
      SELECT * FROM task_item WHERE task_id = ? AND item_id = ?
    `).get(input.taskId, input.itemId));
  }

  /** Lists reduced items in deterministic lifecycle order. */
  public listByTaskId(taskId: string): readonly TaskItemRecord[] {
    return this.executor.prepare(`
      SELECT *
      FROM task_item
      WHERE task_id = ?
      ORDER BY created_at_ms ASC, item_id ASC
    `).all(taskId).map(requireTaskItem);
  }
}

export interface RpcIntentRecord {
  readonly id: string;
  readonly operationKey: string;
  readonly taskId: string | null;
  readonly method: string;
  readonly requestDigest: string;
  readonly connectionEpoch: number;
  readonly rpcId: string | null;
  readonly state: RpcIntentState;
  readonly errorCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly resolvedAtMs: number | null;
}

export interface PrepareRpcIntentInput {
  readonly operationKey: string;
  readonly taskId?: string;
  readonly method: string;
  readonly requestDigest: string;
  readonly connectionEpoch: number;
  readonly nowMs: number;
}

/** Implements the prepare/send/resolve intent protocol around App Server RPC. */
export class RpcIntentRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Creates a prepared intent or returns an identical idempotent replay. */
  public prepare(input: PrepareRpcIntentInput): RpcIntentRecord {
    const id = randomUUID();
    this.executor.prepare(`
      INSERT INTO rpc_intent (
        id, operation_key, task_id, method, request_digest, connection_epoch,
        state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)
      ON CONFLICT (operation_key) DO NOTHING
    `).run(
      id,
      input.operationKey,
      input.taskId ?? null,
      input.method,
      input.requestDigest,
      input.connectionEpoch,
      input.nowMs,
      input.nowMs,
    );
    const record = requireRpcIntent(this.executor.prepare(`
      SELECT * FROM rpc_intent WHERE operation_key = ?
    `).get(input.operationKey));
    if (
      record.taskId !== (input.taskId ?? null)
      || record.method !== input.method
      || record.requestDigest !== input.requestDigest
      || record.connectionEpoch !== input.connectionEpoch
    ) {
      throw new RepositoryConflictError(
        'RPC_INTENT_CONFLICT',
        'RPC operation key was replayed with different request data',
      );
    }
    return record;
  }

  /** Marks a prepared request as sent and binds its JSON-RPC ID. */
  public markSent(id: string, rpcId: string, updatedAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE rpc_intent
      SET state = 'SENT', rpc_id = ?, updated_at_ms = ?
      WHERE id = ? AND state = 'PREPARED'
    `).run(rpcId, updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /** Fails a request only while durable state still proves it was never sent. */
  public failPrepared(id: string, updatedAtMs: number, errorCode: string): boolean {
    const result = this.executor.prepare(`
      UPDATE rpc_intent
      SET state = 'FAILED', error_code = ?, updated_at_ms = ?, resolved_at_ms = ?
      WHERE id = ? AND state = 'PREPARED' AND rpc_id IS NULL
    `).run(errorCode, updatedAtMs, updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /**
   * Re-prepares a provably unsent request for the current connection epoch.
   * All request identity fields must still match the original durable intent.
   */
  public reprepareUnsent(input: PrepareRpcIntentInput): boolean {
    const result = this.executor.prepare(`
      UPDATE rpc_intent
      SET state = 'PREPARED', connection_epoch = ?, error_code = NULL,
          updated_at_ms = ?, resolved_at_ms = NULL
      WHERE operation_key = ?
        AND task_id IS ?
        AND method = ?
        AND request_digest = ?
        AND rpc_id IS NULL
        AND state IN ('PREPARED', 'FAILED')
    `).run(
      input.connectionEpoch,
      input.nowMs,
      input.operationKey,
      input.taskId ?? null,
      input.method,
      input.requestDigest,
    );
    return changes(result.changes) === 1;
  }

  /** Finds an intent by its stable operation key. */
  public findByOperationKey(operationKey: string): RpcIntentRecord | undefined {
    const row = this.executor.prepare(`
      SELECT * FROM rpc_intent WHERE operation_key = ?
    `).get(operationKey);
    return row === undefined ? undefined : requireRpcIntent(row);
  }

  /** Resolves a sent intent exactly once. */
  public resolve(
    id: string,
    nextState: Extract<RpcIntentState, 'RESOLVED' | 'FAILED' | 'UNKNOWN'>,
    updatedAtMs: number,
    errorCode: string | null = null,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE rpc_intent
      SET state = ?, error_code = ?, updated_at_ms = ?, resolved_at_ms = ?
      WHERE id = ? AND state = 'SENT'
    `).run(nextState, errorCode, updatedAtMs, updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /** Marks an unsafely interrupted send window as outcome-unknown. */
  public markUnknown(id: string, updatedAtMs: number, errorCode: string): boolean {
    const result = this.executor.prepare(`
      UPDATE rpc_intent
      SET state = 'UNKNOWN', error_code = ?, updated_at_ms = ?, resolved_at_ms = ?
      WHERE id = ? AND state IN ('PREPARED', 'SENT', 'UNKNOWN')
    `).run(errorCode, updatedAtMs, updatedAtMs, id);
    return changes(result.changes) === 1;
  }

  /** Lists durable response intents whose final send outcome is not provable. */
  public findUncertainByMethod(method: string): readonly RpcIntentRecord[] {
    return this.executor.prepare(`
      SELECT * FROM rpc_intent
      WHERE method = ? AND state IN ('PREPARED', 'SENT', 'UNKNOWN')
      ORDER BY created_at_ms ASC, id ASC
    `).all(method).map(requireRpcIntent);
  }

  /** Lists every durable intent for a method in deterministic creation order. */
  public findByMethod(method: string): readonly RpcIntentRecord[] {
    return this.executor.prepare(`
      SELECT * FROM rpc_intent
      WHERE method = ?
      ORDER BY created_at_ms ASC, id ASC
    `).all(method).map(requireRpcIntent);
  }
}

export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly cardId: string;
  readonly connectionEpoch: number;
  readonly requestId: string;
  readonly method: string;
  readonly itemId: string | null;
  readonly status: ApprovalStatus;
  readonly availableDecisions: readonly ApprovalDecision[];
  readonly decisionTokenHashes: DecisionTokenHashes;
  readonly decision: ApprovalDecision | null;
  readonly decidedByOpenId: string | null;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly decidedAtMs: number | null;
}

export interface CreateApprovalInput {
  readonly taskId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly cardId: string;
  readonly connectionEpoch: number;
  readonly requestId: string;
  readonly method: string;
  readonly itemId?: string;
  readonly decisionTokenHashes: DecisionTokenHashes;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly cardId: string;
  readonly connectionEpoch: number;
  readonly actionTokenHash: string;
  readonly decision: ApprovalDecision;
  readonly decidedByOpenId: string;
  readonly nowMs: number;
}

export interface PendingApprovalDecision {
  readonly approval: ApprovalRecord;
  readonly decision: ApprovalDecision;
}

/** Approval request persistence with token, scope, expiry, epoch, and CAS checks. */
export class ApprovalRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Stores a pending server-initiated approval request. */
  public createPending(input: CreateApprovalInput): ApprovalRecord {
    const decisionTokenHashes = normalizeDecisionTokenHashes(input.decisionTokenHashes);
    const availableDecisions = Object.keys(decisionTokenHashes) as ApprovalDecision[];
    const id = randomUUID();
    this.executor.prepare(`
      INSERT INTO approval (
        id, task_id, tenant_key, chat_id, card_id, connection_epoch, request_id,
        method, item_id, status, available_decisions_json, action_token_hash,
        action_token_hashes_json, expires_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.tenantKey,
      input.chatId,
      input.cardId,
      input.connectionEpoch,
      input.requestId,
      input.method,
      input.itemId ?? null,
      JSON.stringify(availableDecisions),
      `v2-marker:${id}`,
      JSON.stringify(decisionTokenHashes),
      input.expiresAtMs,
      input.nowMs,
      input.nowMs,
    );
    return requireApproval(this.executor.prepare('SELECT * FROM approval WHERE id = ?').get(id));
  }

  /**
   * Consumes a pending approval once. Returns false for replay, expiry, stale
   * epoch, wrong card/chat/tenant, wrong token, or an unavailable decision.
   */
  public decide(input: DecideApprovalInput): boolean {
    const current = this.getById(input.approvalId);
    if (
      current === undefined
      || current.decisionTokenHashes[input.decision] !== input.actionTokenHash
    ) {
      return false;
    }
    const result = this.executor.prepare(`
      UPDATE approval
      SET status = 'DECIDED', decision = ?, decided_by_open_id = ?,
          decided_at_ms = ?, updated_at_ms = ?
      WHERE id = ?
        AND status = 'PENDING'
        AND tenant_key = ?
        AND chat_id = ?
        AND card_id = ?
        AND connection_epoch = ?
        AND json_extract(action_token_hashes_json, ?) = ?
        AND expires_at_ms >= ?
    `).run(
      input.decision,
      input.decidedByOpenId,
      input.nowMs,
      input.nowMs,
      input.approvalId,
      input.tenantKey,
      input.chatId,
      input.cardId,
      input.connectionEpoch,
      approvalDecisionJsonPath(input.decision),
      input.actionTokenHash,
      input.nowMs,
    );
    return changes(result.changes) === 1;
  }

  /** Finds an approval by internal UUID. */
  public getById(id: string): ApprovalRecord | undefined {
    return mapApprovalRow(this.executor.prepare('SELECT * FROM approval WHERE id = ?').get(id));
  }

  /** Finds an idempotent server request within one App Server connection epoch. */
  public findByRequest(
    connectionEpoch: number,
    requestId: string,
    method: string,
  ): ApprovalRecord | undefined {
    return mapApprovalRow(this.executor.prepare(`
      SELECT * FROM approval
      WHERE connection_epoch = ? AND request_id = ? AND method = ?
    `).get(connectionEpoch, requestId, method));
  }

  /** Finds a live approval through one fixed decision-bound token path. */
  public findPendingByDecisionTokenHash(
    decision: ApprovalDecision,
    actionTokenHash: string,
    nowMs: number,
  ): PendingApprovalDecision | undefined {
    const row = findPendingApprovalRow(
      this.executor,
      decision,
      actionTokenHash,
      nowMs,
    );
    const approval = mapApprovalRow(row);
    return approval === undefined ? undefined : { approval, decision };
  }

  /** Invalidates approvals belonging to earlier App Server connections. */
  public markStaleBeforeEpoch(connectionEpoch: number, updatedAtMs: number): number {
    const result = this.executor.prepare(`
      UPDATE approval
      SET status = 'STALE', updated_at_ms = ?
      WHERE status = 'PENDING' AND connection_epoch < ?
    `).run(updatedAtMs, connectionEpoch);
    return changes(result.changes);
  }

  /** Invalidates pending requests created by an earlier bridge process. */
  public markPendingStaleExceptRuntime(
    runtimeInstanceId: string,
    updatedAtMs: number,
  ): number {
    const result = this.executor.prepare(`
      UPDATE approval
      SET status = 'STALE', updated_at_ms = ?
      WHERE status = 'PENDING'
        AND COALESCE(json_extract(request_id, '$.runtimeInstanceId'), '') <> ?
    `).run(updatedAtMs, runtimeInstanceId);
    return changes(result.changes);
  }

  /** Cancels a pending approval whose task can no longer accept the request. */
  public cancelPending(id: string, updatedAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE approval
      SET status = 'CANCELLED', updated_at_ms = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(updatedAtMs, id);
    return changes(result.changes) === 1;
  }
}

export interface CardOutboxRecord {
  readonly id: string;
  readonly taskId: string;
  readonly operation: string;
  readonly projectionRevision: number;
  readonly cardSequence: number;
  readonly idempotencyKey: string;
  readonly payloadJson: string;
  readonly state: CardOutboxState;
  readonly attemptCount: number;
  readonly nextAttemptAtMs: number;
  readonly leaseOwner: string | null;
  readonly leaseUntilMs: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deliveredAtMs: number | null;
}

export interface EnqueueCardUpdateInput {
  readonly taskId: string;
  readonly operation: string;
  readonly projectionRevision: number;
  readonly cardSequence: number;
  readonly idempotencyKey: string;
  readonly payloadJson: string;
  readonly nowMs: number;
}

/** Durable CardKit delivery queue with atomic leases. */
export class CardOutboxRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Enqueues one card projection or returns its identical idempotent replay. */
  public enqueue(input: EnqueueCardUpdateInput): CardOutboxRecord {
    const id = randomUUID();
    this.executor.prepare(`
      INSERT INTO card_outbox (
        id, task_id, operation, projection_revision, card_sequence,
        idempotency_key, payload_json, state, next_attempt_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      id,
      input.taskId,
      input.operation,
      input.projectionRevision,
      input.cardSequence,
      input.idempotencyKey,
      input.payloadJson,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    );
    const record = this.findByIdempotencyKey(input.idempotencyKey);
    if (record === undefined || !isSameOutboxIdentity(record, input)) {
      throw new RepositoryConflictError(
        'OUTBOX_IDEMPOTENCY_CONFLICT',
        'Card outbox identity was replayed with different projection data',
      );
    }
    return record;
  }

  /**
   * Atomically claims due rows. Expired IN_FLIGHT leases are recoverable after
   * process restart without an in-memory lock registry.
   */
  public claimDue(
    leaseOwner: string,
    nowMs: number,
    leaseDurationMs: number,
    limit: number,
  ): readonly CardOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Outbox claim limit must be an integer between 1 and 100');
    }
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RangeError('Outbox lease duration must be a positive integer');
    }
    const leaseUntilMs = nowMs + leaseDurationMs;
    const rows = this.executor.prepare(`
      WITH due AS (
        SELECT id
        FROM card_outbox
        WHERE next_attempt_at_ms <= ?
          AND (
            state IN ('PENDING', 'RETRY')
            OR (state = 'IN_FLIGHT' AND lease_until_ms < ?)
          )
        ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, id ASC
        LIMIT ?
      )
      UPDATE card_outbox
      SET state = 'IN_FLIGHT',
          lease_owner = ?,
          lease_until_ms = ?,
          attempt_count = attempt_count + 1,
          updated_at_ms = ?
      WHERE id IN (SELECT id FROM due)
      RETURNING *
    `).all(nowMs, nowMs, limit, leaseOwner, leaseUntilMs, nowMs);
    return rows.map(requireCardOutbox).sort(compareOutboxOrder);
  }

  /** Marks a leased delivery successful exactly once. */
  public markDelivered(id: string, leaseOwner: string, deliveredAtMs: number): boolean {
    const result = this.executor.prepare(`
      UPDATE card_outbox
      SET state = 'DELIVERED', lease_owner = NULL, lease_until_ms = NULL,
          delivered_at_ms = ?, updated_at_ms = ?, last_error_code = NULL
      WHERE id = ? AND state = 'IN_FLIGHT' AND lease_owner = ?
    `).run(deliveredAtMs, deliveredAtMs, id, leaseOwner);
    return changes(result.changes) === 1;
  }

  /** Atomically advances the task sequence and acknowledges outbox delivery. */
  public acknowledgeDeliveredSequence(
    id: string,
    leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    nextSequence: number,
    deliveredAtMs: number,
  ): boolean {
    return this.atomicDeliveryMutation((executor) => {
      const repositories = new BridgeRepositories(executor);
      if (!repositories.tasks.advanceCardSequence(
        taskId,
        expectedSequence,
        nextSequence,
        deliveredAtMs,
      )) {
        return false;
      }
      if (!repositories.cardOutbox.markDelivered(id, leaseOwner, deliveredAtMs)) {
        throw new AtomicCardDeliveryError();
      }
      return true;
    });
  }

  /**
   * Persists the successful close-streaming step with its sequence CAS. A
   * reclaimed row can identify the replace-only stage from its operation.
   */
  public checkpointFinalClose(
    id: string,
    leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    closedSequence: number,
    updatedAtMs: number,
  ): boolean {
    return this.atomicDeliveryMutation((executor) => {
      const repositories = new BridgeRepositories(executor);
      if (!repositories.tasks.advanceCardSequence(
        taskId,
        expectedSequence,
        closedSequence,
        updatedAtMs,
      )) {
        return false;
      }
      const checkpointed = executor.prepare(`
        UPDATE card_outbox
        SET operation = 'FINALIZE_CARD_REPLACE', card_sequence = ?, updated_at_ms = ?
        WHERE id = ? AND state = 'IN_FLIGHT' AND lease_owner = ?
          AND operation = 'FINALIZE_CARD'
      `).run(closedSequence, updatedAtMs, id, leaseOwner);
      if (changes(checkpointed.changes) !== 1) {
        throw new AtomicCardDeliveryError();
      }
      return true;
    });
  }

  private atomicDeliveryMutation(
    work: (executor: DatabaseExecutor) => boolean,
  ): boolean {
    const transaction = transactionalExecutor(this.executor);
    try {
      return transaction.transaction(work);
    } catch (error) {
      if (error instanceof AtomicCardDeliveryError) {
        return false;
      }
      throw error;
    }
  }

  /** Releases a leased row for a bounded external retry policy. */
  public markRetry(
    id: string,
    leaseOwner: string,
    nextAttemptAtMs: number,
    errorCode: string,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE card_outbox
      SET state = 'RETRY', next_attempt_at_ms = ?, last_error_code = ?,
          lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ?
      WHERE id = ? AND state = 'IN_FLIGHT' AND lease_owner = ?
    `).run(nextAttemptAtMs, errorCode, updatedAtMs, id, leaseOwner);
    return changes(result.changes) === 1;
  }

  /** Terminates a leased delivery after a non-retryable CardKit failure. */
  public markFailed(
    id: string,
    leaseOwner: string,
    errorCode: string,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE card_outbox
      SET state = 'FAILED', last_error_code = ?, lease_owner = NULL,
          lease_until_ms = NULL, updated_at_ms = ?
      WHERE id = ? AND state = 'IN_FLIGHT' AND lease_owner = ?
    `).run(errorCode, updatedAtMs, id, leaseOwner);
    return changes(result.changes) === 1;
  }

  /** Discards a claimed projection after a newer durable revision exists. */
  public markClaimedSuperseded(
    id: string,
    leaseOwner: string,
    updatedAtMs: number,
  ): boolean {
    const result = this.executor.prepare(`
      UPDATE card_outbox
      SET state = 'SUPERSEDED', lease_owner = NULL, lease_until_ms = NULL,
          updated_at_ms = ?
      WHERE id = ? AND state = 'IN_FLIGHT' AND lease_owner = ?
    `).run(updatedAtMs, id, leaseOwner);
    return changes(result.changes) === 1;
  }

  /**
   * Terminates a delivery whose CardKit sequence can no longer be proven.
   * Sequence conflicts are never retried with a guessed sequence.
   */
  public markSequenceConflict(id: string, leaseOwner: string, updatedAtMs: number): boolean {
    return this.markFailed(id, leaseOwner, 'CARD_SEQUENCE_CONFLICT', updatedAtMs);
  }

  /** Supersedes older unclaimed projections while preserving active leases. */
  public supersedePendingBeforeRevision(
    taskId: string,
    projectionRevision: number,
    updatedAtMs: number,
  ): number {
    const result = this.executor.prepare(`
      UPDATE card_outbox
      SET state = 'SUPERSEDED', lease_owner = NULL, lease_until_ms = NULL,
          updated_at_ms = ?
      WHERE task_id = ?
        AND projection_revision < ?
        AND state IN ('PENDING', 'RETRY')
    `).run(updatedAtMs, taskId, projectionRevision);
    return changes(result.changes);
  }

  /** Finds an outbox row by its external idempotency key. */
  public findByIdempotencyKey(idempotencyKey: string): CardOutboxRecord | undefined {
    return mapCardOutboxRow(this.executor.prepare(`
      SELECT * FROM card_outbox WHERE idempotency_key = ?
    `).get(idempotencyKey));
  }

  /** Counts durable terminal delivery failures for operational health checks. */
  public countFailed(): number {
    const row = this.executor.prepare(`
      SELECT COUNT(*) AS count FROM card_outbox WHERE state = 'FAILED'
    `).get();
    return requireNumber(row, 'count');
  }
}

/** Typed access to application metadata other than the managed schema version. */
export class MetaRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  /** Reads a metadata value. */
  public get(key: string): string | undefined {
    const row = this.executor.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row === undefined ? undefined : requireString(row, 'value');
  }

  /** Upserts a metadata value. The reserved schema key is migration-owned. */
  public set(key: string, value: string, updatedAtMs: number): void {
    if (key === 'schema_version') {
      throw new RangeError('schema_version is managed by database migrations');
    }
    this.executor.prepare(`
      INSERT INTO meta (key, value, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        value = excluded.value,
        updated_at_ms = excluded.updated_at_ms
    `).run(key, value, updatedAtMs);
  }
}

/** Convenient repository bundle for a connection or transaction executor. */
export class BridgeRepositories {
  public readonly meta: MetaRepository;
  public readonly inbox: InboxEventRepository;
  public readonly threadBindings: ThreadBindingRepository;
  public readonly chatThreadBindings: ChatThreadBindingRepository;
  public readonly tasks: TaskRepository;
  public readonly taskItems: TaskItemRepository;
  public readonly rpcIntents: RpcIntentRepository;
  public readonly approvals: ApprovalRepository;
  public readonly cardOutbox: CardOutboxRepository;

  public constructor(executor: DatabaseExecutor) {
    this.meta = new MetaRepository(executor);
    this.inbox = new InboxEventRepository(executor);
    this.threadBindings = new ThreadBindingRepository(executor);
    this.chatThreadBindings = new ChatThreadBindingRepository(executor);
    this.tasks = new TaskRepository(executor);
    this.taskItems = new TaskItemRepository(executor);
    this.rpcIntents = new RpcIntentRepository(executor);
    this.approvals = new ApprovalRepository(executor);
    this.cardOutbox = new CardOutboxRepository(executor);
  }
}

type SqlRow = Record<string, SQLOutputValue>;

function mapInboxRow(row: SqlRow | undefined): InboxEventRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: requireString(row, 'id'),
    tenantKey: requireString(row, 'tenant_key'),
    eventId: optionalString(row, 'event_id'),
    messageId: requireString(row, 'message_id'),
    chatId: requireString(row, 'chat_id'),
    rootMessageId: requireString(row, 'root_message_id'),
    senderOpenId: optionalString(row, 'sender_open_id'),
    payloadDigest: requireString(row, 'payload_digest'),
    payloadText: optionalString(row, 'payload_text'),
    status: requireString(row, 'status') as InboxStatus,
    errorCode: optionalString(row, 'error_code'),
    receivedAtMs: requireNumber(row, 'received_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
  };
}

function requireThreadBinding(row: SqlRow | undefined): ThreadBindingRecord {
  const record = mapThreadBindingRow(row);
  if (record === undefined) {
    throw new Error('Thread binding insert did not return a row');
  }
  return record;
}

function mapThreadBindingRow(row: SqlRow | undefined): ThreadBindingRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: requireString(row, 'id'),
    tenantKey: requireString(row, 'tenant_key'),
    chatId: requireString(row, 'chat_id'),
    rootMessageId: requireString(row, 'root_message_id'),
    projectId: requireString(row, 'project_id'),
    workspacePath: requireString(row, 'workspace_path'),
    threadId: optionalString(row, 'thread_id'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
  };
}

function requireChatThreadBinding(row: SqlRow | undefined): ChatThreadBindingRecord {
  const record = mapChatThreadBindingRow(row);
  if (record === undefined) {
    throw new Error('Chat thread binding upsert did not return a row');
  }
  return record;
}

function mapChatThreadBindingRow(row: SqlRow | undefined): ChatThreadBindingRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    tenantKey: requireString(row, 'tenant_key'),
    chatId: requireString(row, 'chat_id'),
    threadId: requireString(row, 'thread_id'),
    workspacePath: requireString(row, 'workspace_path'),
    boundByOpenId: requireString(row, 'bound_by_open_id'),
    threadTitle: optionalString(row, 'thread_title'),
    revision: requireNumber(row, 'revision'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
  };
}

function requireTask(row: SqlRow | undefined): TaskRecord {
  const record = mapTaskRow(row);
  if (record === undefined) {
    throw new Error('Task insert did not return a row');
  }
  return record;
}

function mapTaskRow(row: SqlRow | undefined): TaskRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: requireString(row, 'id'),
    bindingId: requireString(row, 'binding_id'),
    sourceInboxId: requireString(row, 'source_inbox_id'),
    prompt: requireString(row, 'prompt'),
    status: requireString(row, 'status') as TaskStatus,
    turnId: optionalString(row, 'turn_id'),
    cardId: optionalString(row, 'card_id'),
    cardMessageId: optionalString(row, 'card_message_id'),
    cardSequence: requireNumber(row, 'card_sequence'),
    projectionRevision: requireNumber(row, 'projection_revision'),
    finalText: optionalString(row, 'final_text'),
    errorCode: optionalString(row, 'error_code'),
    cancelRequested: requireNumber(row, 'cancel_requested') === 1,
    cancelTokenHash: optionalString(row, 'cancel_token_hash'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
    completedAtMs: optionalNumber(row, 'completed_at_ms') ?? null,
  };
}

function requireTaskItem(row: SqlRow | undefined): TaskItemRecord {
  if (row === undefined) {
    throw new Error('Task item upsert did not return a row');
  }
  return {
    taskId: requireString(row, 'task_id'),
    itemId: requireString(row, 'item_id'),
    itemType: requireString(row, 'item_type'),
    phase: optionalString(row, 'phase'),
    status: requireString(row, 'status') as TaskItemStatus,
    contentText: optionalString(row, 'content_text'),
    terminalPayloadJson: optionalString(row, 'terminal_payload_json'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
  };
}

function requireRpcIntent(row: SqlRow | undefined): RpcIntentRecord {
  if (row === undefined) {
    throw new Error('RPC intent insert did not return a row');
  }
  return {
    id: requireString(row, 'id'),
    operationKey: requireString(row, 'operation_key'),
    taskId: optionalString(row, 'task_id'),
    method: requireString(row, 'method'),
    requestDigest: requireString(row, 'request_digest'),
    connectionEpoch: requireNumber(row, 'connection_epoch'),
    rpcId: optionalString(row, 'rpc_id'),
    state: requireString(row, 'state') as RpcIntentState,
    errorCode: optionalString(row, 'error_code'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
    resolvedAtMs: optionalNumber(row, 'resolved_at_ms') ?? null,
  };
}

function requireApproval(row: SqlRow | undefined): ApprovalRecord {
  const record = mapApprovalRow(row);
  if (record === undefined) {
    throw new Error('Approval insert did not return a row');
  }
  return record;
}

function findPendingApprovalRow(
  executor: DatabaseExecutor,
  decision: ApprovalDecision,
  actionTokenHash: string,
  nowMs: number,
): SqlRow | undefined {
  switch (decision) {
    case 'accept':
      return executor.prepare(`
        SELECT * FROM approval
        WHERE status = 'PENDING' AND expires_at_ms >= ?
          AND json_extract(action_token_hashes_json, '$.accept') = ?
        LIMIT 1
      `).get(nowMs, actionTokenHash);
    case 'acceptForSession':
      return executor.prepare(`
        SELECT * FROM approval
        WHERE status = 'PENDING' AND expires_at_ms >= ?
          AND json_extract(action_token_hashes_json, '$.acceptForSession') = ?
        LIMIT 1
      `).get(nowMs, actionTokenHash);
    case 'decline':
      return executor.prepare(`
        SELECT * FROM approval
        WHERE status = 'PENDING' AND expires_at_ms >= ?
          AND json_extract(action_token_hashes_json, '$.decline') = ?
        LIMIT 1
      `).get(nowMs, actionTokenHash);
    case 'cancel':
      return executor.prepare(`
        SELECT * FROM approval
        WHERE status = 'PENDING' AND expires_at_ms >= ?
          AND json_extract(action_token_hashes_json, '$.cancel') = ?
        LIMIT 1
      `).get(nowMs, actionTokenHash);
    default:
      return assertNever(decision);
  }
}

function mapApprovalRow(row: SqlRow | undefined): ApprovalRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  const decisionTokenHashes = parseDecisionTokenHashes(
    requireString(row, 'action_token_hashes_json'),
  );
  const availableDecisions = Object.keys(decisionTokenHashes) as ApprovalDecision[];
  const decision = optionalString(row, 'decision');
  if (decision !== null && !isApprovalDecision(decision)) {
    throw new TypeError('Approval row contains an invalid decision');
  }
  return {
    id: requireString(row, 'id'),
    taskId: requireString(row, 'task_id'),
    tenantKey: requireString(row, 'tenant_key'),
    chatId: requireString(row, 'chat_id'),
    cardId: requireString(row, 'card_id'),
    connectionEpoch: requireNumber(row, 'connection_epoch'),
    requestId: requireString(row, 'request_id'),
    method: requireString(row, 'method'),
    itemId: optionalString(row, 'item_id'),
    status: requireString(row, 'status') as ApprovalStatus,
    availableDecisions,
    decisionTokenHashes,
    decision,
    decidedByOpenId: optionalString(row, 'decided_by_open_id'),
    expiresAtMs: requireNumber(row, 'expires_at_ms'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
    decidedAtMs: optionalNumber(row, 'decided_at_ms') ?? null,
  };
}

function requireCardOutbox(row: SqlRow): CardOutboxRecord {
  return mapCardOutboxRow(row) as CardOutboxRecord;
}

function mapCardOutboxRow(row: SqlRow | undefined): CardOutboxRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: requireString(row, 'id'),
    taskId: requireString(row, 'task_id'),
    operation: requireString(row, 'operation'),
    projectionRevision: requireNumber(row, 'projection_revision'),
    cardSequence: requireNumber(row, 'card_sequence'),
    idempotencyKey: requireString(row, 'idempotency_key'),
    payloadJson: requireString(row, 'payload_json'),
    state: requireString(row, 'state') as CardOutboxState,
    attemptCount: requireNumber(row, 'attempt_count'),
    nextAttemptAtMs: requireNumber(row, 'next_attempt_at_ms'),
    leaseOwner: optionalString(row, 'lease_owner'),
    leaseUntilMs: optionalNumber(row, 'lease_until_ms') ?? null,
    lastErrorCode: optionalString(row, 'last_error_code'),
    createdAtMs: requireNumber(row, 'created_at_ms'),
    updatedAtMs: requireNumber(row, 'updated_at_ms'),
    deliveredAtMs: optionalNumber(row, 'delivered_at_ms') ?? null,
  };
}

function requireString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Database column ${column} is not a string`);
  }
  return value;
}

function optionalString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Database column ${column} is not a nullable string`);
  }
  return value;
}

function requireNumber(row: SqlRow | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Database column ${column} is not a safe integer`);
  }
  return value;
}

function optionalNumber(row: SqlRow | undefined, column: string): number | undefined {
  const value = row?.[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Database column ${column} is not a nullable safe integer`);
  }
  return value;
}

function changes(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('SQLite change count exceeded the JavaScript safe integer range');
  }
  return result;
}

function transactionalExecutor(executor: DatabaseExecutor): TransactionalDatabaseExecutor {
  const candidate = executor as Partial<TransactionalDatabaseExecutor>;
  if (typeof candidate.transaction !== 'function') {
    throw new TypeError('Atomic card delivery requires a transactional database executor');
  }
  return candidate as TransactionalDatabaseExecutor;
}

function isSameInboxIdentity(record: InboxEventRecord, input: RecordInboxEventInput): boolean {
  return record.tenantKey === input.tenantKey
    && record.eventId === (input.eventId ?? null)
    && record.messageId === input.messageId
    && record.chatId === input.chatId
    && record.rootMessageId === input.rootMessageId
    && record.senderOpenId === (input.senderOpenId ?? null)
    && record.payloadDigest === input.payloadDigest
    && record.payloadText === (input.payloadText ?? null);
}

function isSameOutboxIdentity(
  record: CardOutboxRecord,
  input: EnqueueCardUpdateInput,
): boolean {
  return record.taskId === input.taskId
    && record.operation === input.operation
    && record.projectionRevision === input.projectionRevision
    && record.cardSequence === input.cardSequence
    && record.idempotencyKey === input.idempotencyKey
    && record.payloadJson === input.payloadJson;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'accept'
    || value === 'acceptForSession'
    || value === 'decline'
    || value === 'cancel';
}

function normalizeDecisionTokenHashes(input: DecisionTokenHashes): DecisionTokenHashes {
  const inputRecord = input as Readonly<Record<string, unknown>>;
  const unexpectedDecision = Object.keys(inputRecord).find((key) => !isApprovalDecision(key));
  if (unexpectedDecision !== undefined) {
    throw new RangeError(`Unsupported approval decision: ${unexpectedDecision}`);
  }

  const normalized: Partial<Record<ApprovalDecision, string>> = {};
  for (const decision of APPROVAL_DECISIONS) {
    const tokenHash = inputRecord[decision];
    if (tokenHash === undefined) {
      continue;
    }
    if (typeof tokenHash !== 'string' || tokenHash.length === 0) {
      throw new RangeError(`Approval token hash for ${decision} must be non-empty`);
    }
    normalized[decision] = tokenHash;
  }
  if (Object.keys(normalized).length === 0) {
    throw new RangeError('Approval must contain at least one decision-bound token hash');
  }
  return Object.freeze(normalized);
}

function parseDecisionTokenHashes(serialized: string): DecisionTokenHashes {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Approval row contains invalid decision token hashes');
  }
  try {
    return normalizeDecisionTokenHashes(parsed as Readonly<Record<string, unknown>>);
  } catch (error) {
    if (Object.keys(parsed).length === 0) {
      return Object.freeze({});
    }
    throw error;
  }
}

function approvalDecisionJsonPath(decision: ApprovalDecision): string {
  return `$.${decision}`;
}

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = Object.freeze([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]);

function assertNever(value: never): never {
  throw new RangeError(`Unsupported approval decision: ${String(value)}`);
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'INTERRUPTED';
}

function compareOutboxOrder(left: CardOutboxRecord, right: CardOutboxRecord): number {
  return left.nextAttemptAtMs - right.nextAttemptAtMs
    || left.createdAtMs - right.createdAtMs
    || left.id.localeCompare(right.id);
}

// Keep SQL input types visible to downstream repository extensions without
// weakening prepared-statement binding to unknown/any values.
export type RepositorySqlInput = SQLInputValue;
export type RepositoryStatement = StatementSync;
