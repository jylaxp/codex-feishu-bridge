import { createHash, randomUUID } from 'node:crypto';

import { deriveTaskCancelToken, hashActionToken } from './action-tokens';
import { buildTaskProjection, describeTaskTarget } from './cards/projector';
import { CardKitJson } from './cards/layouts';
import {
  AppServerConnectionError,
  AppServerNotReadyError,
  AppServerRpcError,
  TrackedRequestIdentity,
} from './codex/app-server-client';
import {
  Thread,
  ThreadResumeParams,
  ThreadResumeResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
} from './codex/protocol';
import { BridgeConfig } from './domain';
import { BridgeDatabase } from './db/database';
import {
  BridgeRepositories,
  InboxEventRecord,
  TaskRecord,
  ThreadBindingRecord,
} from './db/repositories';
import { InboundTextMessage } from './lark/intake';
import { isPathWithinRoot } from './preflight';

export interface OrchestratorAppServer {
  readonly connectionEpoch: number;
  requestTracked<TResult>(
    method: string,
    params: unknown,
    beforeSend: (identity: TrackedRequestIdentity) => void,
    timeoutMs?: number,
  ): Promise<TResult>;
}

export interface OrchestratorCardClient {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
}

export interface ProjectionRequester {
  request(taskId: string, immediate?: boolean): void;
}

/** Fail-closed bridge between turn/start dispatch and early App Server notifications. */
export interface TurnStartEventCoordinator {
  beginTurnStart(taskId: string, threadId: string): void;
  abandonTurnStart(taskId: string, threadId: string): void;
  drainTurnStart(taskId: string, threadId: string, turnId: string): unknown;
}

export interface TaskOrchestratorOptions {
  readonly runtimeInstanceId: string;
  readonly now?: () => number;
  readonly turnEvents?: TurnStartEventCoordinator;
}

export type RecoverableDispatchMethod = 'thread/resume' | 'turn/start';

export type InboundTaskOutcome =
  | { readonly type: 'duplicate'; readonly inboxId: string }
  | { readonly type: 'steered'; readonly taskId: string }
  | { readonly type: 'steer_pending'; readonly taskId: string }
  | { readonly type: 'steer_rejected'; readonly taskId: string }
  | { readonly type: 'steer_unknown'; readonly taskId: string }
  | { readonly type: 'unbound'; readonly chatId: string }
  | { readonly type: 'rejected_capacity'; readonly inboxId: string }
  | { readonly type: 'started'; readonly taskId: string }
  | { readonly type: 'queued'; readonly taskId: string }
  | { readonly type: 'failed'; readonly taskId: string };

interface AcceptedInbound {
  readonly inbox: InboxEventRecord;
  readonly binding: ThreadBindingRecord;
  readonly activeTask: TaskRecord | undefined;
  readonly task: TaskRecord | undefined;
  readonly duplicate: boolean;
  readonly capacityRejected: boolean;
}

interface DispatchTarget {
  readonly threadId: string;
  readonly workspacePath: string;
}

class DurableRpcError extends Error {
  public constructor(
    public readonly outcomeUnknown: boolean,
    public readonly provablyUnsent: boolean,
    public readonly errorCode: string,
    cause: unknown,
  ) {
    super(`Durable App Server request failed: ${errorCode}`, { cause });
    this.name = 'DurableRpcError';
  }
}

const PROJECT_ID_PREFIX = 'workspace-';

/** Coordinates durable Lark inbox, initial CardKit delivery, and App Server turns. */
export class TaskOrchestrator {
  private readonly runtimeInstanceId: string;
  private readonly now: () => number;
  private readonly turnEvents: TurnStartEventCoordinator | undefined;
  private readonly inFlightSteers = new Map<string, Promise<InboundTaskOutcome>>();

  public constructor(
    private readonly database: BridgeDatabase,
    private readonly config: BridgeConfig,
    private readonly appServer: OrchestratorAppServer,
    private readonly cardClient: OrchestratorCardClient,
    private readonly projections: ProjectionRequester,
    options: TaskOrchestratorOptions,
  ) {
    if (!options.runtimeInstanceId.trim()) {
      throw new Error('TaskOrchestrator runtimeInstanceId must not be blank');
    }
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.now = options.now ?? Date.now;
    this.turnEvents = options.turnEvents;
  }

  public async handleInbound(message: InboundTextMessage): Promise<InboundTaskOutcome> {
    const accepted = this.persistInbound(message);
    if (!accepted) {
      return { type: 'unbound', chatId: message.chatId };
    }
    if (accepted.capacityRejected) {
      return { type: 'rejected_capacity', inboxId: accepted.inbox.id };
    }

    if (accepted.activeTask?.turnId && accepted.binding.threadId) {
      return this.runSteer(accepted, accepted.inbox.payloadText ?? message.text);
    }
    if (accepted.duplicate) {
      return { type: 'duplicate', inboxId: accepted.inbox.id };
    }

    const task = accepted.task;
    if (!task) {
      throw new Error('Accepted inbound message did not create a task');
    }

    const cancelToken = deriveTaskCancelToken(this.config.larkAppSecret, task.id);
    const cancelTokenHash = hashActionToken(cancelToken);
    const tokenAttached = new BridgeRepositories(this.database).tasks.attachCancelTokenHash(
      task.id,
      cancelTokenHash,
      this.now(),
    );
    if (!tokenAttached) {
      this.failBeforeDispatch(task, accepted.inbox, 'CANCEL_TOKEN_PERSIST_FAILED');
      await this.startNextQueued();
      return { type: 'failed', taskId: task.id };
    }

    try {
      await this.createInitialCard(task, accepted.binding, cancelToken);
    } catch {
      this.failBeforeDispatch(task, accepted.inbox, 'CARD_INITIALIZATION_FAILED');
      await this.startNextQueued();
      return { type: 'failed', taskId: task.id };
    }

    const shouldStart = this.claimExecutionSlot(task.id);
    if (!shouldStart) {
      this.projections.request(task.id, true);
      await this.startNextQueued();
      return { type: 'queued', taskId: task.id };
    }

    await this.dispatchTask(task.id);
    const dispatched = new BridgeRepositories(this.database).tasks.getById(task.id);
    if (dispatched && isTerminalTask(dispatched.status)) {
      await this.startNextQueued();
    }
    return dispatched?.turnId && isAcceptedDispatchState(dispatched.status)
      ? { type: 'started', taskId: task.id }
      : { type: 'failed', taskId: task.id };
  }

  /** Replays a persisted steer only when its RPC intent proves no send occurred. */
  public async recoverUnsentSteer(inboxId: string): Promise<InboundTaskOutcome> {
    const repositories = new BridgeRepositories(this.database);
    const inbox = repositories.inbox.getById(inboxId);
    const intent = repositories.rpcIntents.findByOperationKey(steerOperationKey(inboxId));
    const task = intent?.taskId ? repositories.tasks.getById(intent.taskId) : undefined;
    const binding = task ? repositories.threadBindings.getById(task.bindingId) : undefined;
    if (!inbox || inbox.status !== 'ACCEPTED' || !task || !binding || !inbox.payloadText) {
      return { type: 'duplicate', inboxId };
    }
    if (!isSteerableTask(task) || !task.turnId || !binding.threadId) {
      repositories.inbox.transition(
        inbox.id,
        'ACCEPTED',
        'REJECTED',
        this.now(),
        'STEER_TARGET_NOT_ACTIVE',
      );
      this.projections.request(task.id, true);
      return { type: 'steer_rejected', taskId: task.id };
    }
    return this.runSteer({
      inbox,
      binding,
      activeTask: task,
      task: undefined,
      duplicate: true,
      capacityRejected: false,
    }, inbox.payloadText);
  }

  /** Starts the oldest queued task when no write turn is active. */
  public async startNextQueued(): Promise<string | null> {
    while (true) {
      const task = this.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        if (repositories.tasks.findAnyActive()) {
          return undefined;
        }
        const waiting = repositories.tasks.findOldestWaiting();
        if (!waiting || waiting.status === 'CARD_CREATING') {
          return undefined;
        }
        return repositories.tasks.transition(waiting.id, 'QUEUED', 'STARTING', this.now())
          ? waiting
          : undefined;
      });
      if (!task) {
        return null;
      }
      await this.dispatchTask(task.id);
      const refreshed = new BridgeRepositories(this.database).tasks.getById(task.id);
      if (!refreshed || !isTerminalTask(refreshed.status)) {
        return task.id;
      }
    }
  }

  /** Sends an interrupt for a previously authenticated and consumed cancel action. */
  public async interruptTask(taskId: string): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const task = repositories.tasks.getById(taskId);
    if (!task) {
      throw new Error('Task does not exist');
    }
    if (task.status === 'QUEUED') {
      const interrupted = this.database.transaction((executor) => {
        const transactionalRepositories = new BridgeRepositories(executor);
        const nowMs = this.now();
        if (!transactionalRepositories.tasks.transition(
          task.id,
          'QUEUED',
          'INTERRUPTED',
          nowMs,
          { errorCode: 'CANCELLED_BEFORE_START' },
        )) {
          return false;
        }
        const inboxProcessed = transactionalRepositories.inbox.transition(
          task.sourceInboxId,
          'ACCEPTED',
          'PROCESSED',
          nowMs,
          'CANCELLED_BEFORE_START',
        );
        if (!inboxProcessed) {
          throw new Error('Queued task source inbox could not enter processed state');
        }
        return true;
      });
      if (!interrupted) {
        throw new Error('Queued task could not enter interrupted state');
      }
      this.projections.request(task.id, true);
      await this.startNextQueued();
      return;
    }
    const binding = repositories.threadBindings.getById(task.bindingId);
    if (!task.turnId || !binding?.threadId) {
      repositories.tasks.requestCancellation(task.id, this.now());
      return;
    }

    const params: TurnInterruptParams = { threadId: binding.threadId, turnId: task.turnId };
    await this.sendInterrupt(
      task,
      params,
      `${task.id}:turn-interrupt:user:${randomUUID()}`,
      false,
    );
  }

  /** Retries an idempotent interrupt only after recovery proved the turn is active. */
  public async recoverPendingCancellation(taskId: string): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const task = repositories.tasks.getById(taskId);
    const binding = task ? repositories.threadBindings.getById(task.bindingId) : undefined;
    if (
      !task?.cancelRequested
      || !task.turnId
      || !binding?.threadId
      || isTerminalTask(task.status)
    ) {
      return;
    }
    const params: TurnInterruptParams = {
      threadId: binding.threadId,
      turnId: task.turnId,
    };
    await this.sendInterrupt(
      task,
      params,
      `${task.id}:turn-interrupt:recovery:${this.runtimeInstanceId}:` +
        `${this.appServer.connectionEpoch}`,
      false,
    );
  }

  /** Replays only a durable STARTING RPC whose intent proves no send occurred. */
  public async recoverUnsentDispatch(
    taskId: string,
    method: RecoverableDispatchMethod,
  ): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const task = repositories.tasks.getById(taskId);
    const binding = task ? repositories.threadBindings.getById(task.bindingId) : undefined;
    if (!task || !binding || task.status !== 'STARTING' || task.turnId) {
      return;
    }

    try {
      const target = requireDispatchTarget(binding, this.config);

      if (method === 'thread/resume') {
        await this.resumeThread(
          task,
          target,
          false,
          `${task.id}:thread-resume:recovery:${this.runtimeInstanceId}:` +
            `${this.appServer.connectionEpoch}`,
        );
      }
      const turn = await this.startTurn(
        task,
        target,
        method === 'thread/resume' || method === 'turn/start',
      );
      await this.completeDispatch(task, target.threadId, turn.id);
    } catch (error) {
      this.failDispatch(task, error);
    }
  }

  private persistInbound(message: InboundTextMessage): AcceptedInbound | undefined {
    return this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const inboxResult = repositories.inbox.record({
        tenantKey: message.tenantKey,
        eventId: message.eventId,
        messageId: message.messageId,
        chatId: message.chatId,
        rootMessageId: message.rootMessageId,
        senderOpenId: message.senderOpenId,
        payloadDigest: message.payloadDigest,
        payloadText: message.text,
        // `received_at` is a local durability timestamp. Using the remote
        // message clock here would let normal clock skew violate the DB's
        // monotonic updated_at constraint on the next transition.
        receivedAtMs: this.now(),
      });
      if (
        !inboxResult.created
        && inboxResult.record.status === 'REJECTED'
        && inboxResult.record.errorCode === 'CHAT_THREAD_UNBOUND'
      ) {
        return undefined;
      }
      const chatBinding = repositories.chatThreadBindings.get(
        message.tenantKey,
        message.chatId,
      );
      if (!chatBinding) {
        if (inboxResult.created && !repositories.inbox.transition(
          inboxResult.record.id,
          'RECEIVED',
          'REJECTED',
          this.now(),
          'CHAT_THREAD_UNBOUND',
        )) {
          throw new Error('Unbound inbound event could not enter REJECTED state');
        }
        return undefined;
      }
      const existingBinding = repositories.threadBindings.findByLarkRoot(
        message.tenantKey,
        message.chatId,
        message.rootMessageId,
      );
      const binding = existingBinding?.threadId
        ? existingBinding
        : repositories.threadBindings.getOrCreate({
            tenantKey: message.tenantKey,
            chatId: message.chatId,
            rootMessageId: message.rootMessageId,
            projectId: projectId(chatBinding.workspacePath),
            workspacePath: chatBinding.workspacePath,
            threadId: chatBinding.threadId,
            nowMs: this.now(),
          });
      if (!inboxResult.created) {
        const steerIntent = repositories.rpcIntents.findByOperationKey(
          steerOperationKey(inboxResult.record.id),
        );
        const steerTask = steerIntent?.taskId
          ? repositories.tasks.getById(steerIntent.taskId)
          : undefined;
        return {
          inbox: inboxResult.record,
          binding,
          activeTask: steerTask,
          task: undefined,
          duplicate: true,
          capacityRejected: inboxResult.record.errorCode === 'QUEUE_CAPACITY_EXCEEDED',
        };
      }

      const activeTask = repositories.tasks.findActiveByBindingId(binding.id);
      const canSteer = activeTask?.turnId && binding.threadId
        && isSteerableTask(activeTask);
      if (canSteer) {
        const params = buildSteerParams(
          binding.threadId as string,
          activeTask.turnId as string,
          inboxResult.record,
          message.text,
        );
        repositories.rpcIntents.prepare({
          operationKey: steerOperationKey(inboxResult.record.id),
          taskId: activeTask.id,
          method: 'turn/steer',
          requestDigest: sha256(JSON.stringify(params)),
          connectionEpoch: this.appServer.connectionEpoch,
          nowMs: this.now(),
        });
      } else if (repositories.tasks.countWaiting() >= this.config.maxQueuedTasks) {
        if (!repositories.inbox.transition(
          inboxResult.record.id,
          'RECEIVED',
          'REJECTED',
          this.now(),
          'QUEUE_CAPACITY_EXCEEDED',
        )) {
          throw new Error('Inbound event could not enter REJECTED state');
        }
        return {
          inbox: repositories.inbox.getById(inboxResult.record.id) as InboxEventRecord,
          binding,
          activeTask: undefined,
          task: undefined,
          duplicate: false,
          capacityRejected: true,
        };
      }

      if (!repositories.inbox.transition(
        inboxResult.record.id,
        'RECEIVED',
        'ACCEPTED',
        this.now(),
      )) {
        throw new Error('Inbound event could not enter ACCEPTED state');
      }
      const task = canSteer
        ? undefined
        : repositories.tasks.create({
            bindingId: binding.id,
            sourceInboxId: inboxResult.record.id,
            prompt: message.text,
            status: 'CARD_CREATING',
            nowMs: this.now(),
          });
      return {
        inbox: repositories.inbox.getById(inboxResult.record.id) as InboxEventRecord,
        binding,
        activeTask: canSteer ? activeTask : undefined,
        task,
        duplicate: false,
        capacityRejected: false,
      };
    });
  }

  private runSteer(
    accepted: AcceptedInbound,
    text: string,
  ): Promise<InboundTaskOutcome> {
    const existing = this.inFlightSteers.get(accepted.inbox.id);
    if (existing) {
      return existing;
    }
    const operation = this.reconcileAndSteer(accepted, text);
    this.inFlightSteers.set(accepted.inbox.id, operation);
    void operation.finally(() => {
      if (this.inFlightSteers.get(accepted.inbox.id) === operation) {
        this.inFlightSteers.delete(accepted.inbox.id);
      }
    }).catch(() => undefined);
    return operation;
  }

  private async reconcileAndSteer(
    accepted: AcceptedInbound,
    text: string,
  ): Promise<InboundTaskOutcome> {
    const repositories = new BridgeRepositories(this.database);
    const inbox = repositories.inbox.getById(accepted.inbox.id);
    const intent = repositories.rpcIntents.findByOperationKey(steerOperationKey(accepted.inbox.id));
    const task = accepted.activeTask;
    if (!inbox || !intent || !task) {
      return { type: 'duplicate', inboxId: accepted.inbox.id };
    }
    if (inbox.status !== 'ACCEPTED') {
      return { type: 'duplicate', inboxId: inbox.id };
    }
    if (intent.state === 'RESOLVED') {
      this.convergeSteerResult(task.id, inbox.id, 'PROCESSED', null);
      this.projections.request(task.id, true);
      return { type: 'steered', taskId: task.id };
    }
    if (intent.state === 'UNKNOWN') {
      this.convergeSteerResult(
        task.id,
        inbox.id,
        'PROCESSED',
        'STEER_OUTCOME_UNKNOWN',
      );
      this.projections.request(task.id, true);
      return { type: 'steer_unknown', taskId: task.id };
    }
    if (intent.state === 'SENT') {
      return { type: 'steer_pending', taskId: task.id };
    }
    if (intent.state === 'FAILED' && intent.rpcId !== null) {
      this.convergeSteerResult(
        task.id,
        inbox.id,
        'REJECTED',
        intent.errorCode ?? 'STEER_REJECTED',
      );
      this.projections.request(task.id, true);
      return { type: 'steer_rejected', taskId: task.id };
    }
    if (!isSteerableTask(task) || !task.turnId || !accepted.binding.threadId) {
      this.convergeSteerResult(
        task.id,
        inbox.id,
        'REJECTED',
        'STEER_TARGET_NOT_ACTIVE',
      );
      this.projections.request(task.id, true);
      return { type: 'steer_rejected', taskId: task.id };
    }
    return this.steerActiveTask(accepted, text);
  }

  private async steerActiveTask(
    accepted: AcceptedInbound,
    text: string,
  ): Promise<InboundTaskOutcome> {
    const task = accepted.activeTask as TaskRecord & { readonly turnId: string };
    const threadId = accepted.binding.threadId as string;
    const params = buildSteerParams(threadId, task.turnId, accepted.inbox, text);
    try {
      await this.durableRequest(
        task.id,
        `inbox:${accepted.inbox.id}:turn-steer`,
        'turn/steer',
        params,
        true,
      );
      this.convergeSteerResult(task.id, accepted.inbox.id, 'PROCESSED', null);
      this.projections.request(task.id, true);
      return { type: 'steered', taskId: task.id };
    } catch (error) {
      const outcomeUnknown = error instanceof DurableRpcError && error.outcomeUnknown;
      const provablyUnsent = error instanceof DurableRpcError && error.provablyUnsent;
      if (provablyUnsent) {
        new BridgeRepositories(this.database).tasks.setOperationalError(
          task.id,
          'STEER_RETRY_PENDING',
          this.now(),
        );
        this.projections.request(task.id, true);
        return { type: 'steer_pending', taskId: task.id };
      }
      const errorCode = outcomeUnknown
        ? 'STEER_OUTCOME_UNKNOWN'
        : stableRpcErrorCode(error);
      this.convergeSteerResult(
        task.id,
        accepted.inbox.id,
        outcomeUnknown ? 'PROCESSED' : 'REJECTED',
        errorCode,
      );
      this.projections.request(task.id, true);
      if (outcomeUnknown) {
        return { type: 'steer_unknown', taskId: task.id };
      }
      return { type: 'steer_rejected', taskId: task.id };
    }
  }

  private async createInitialCard(
    task: TaskRecord,
    binding: ThreadBindingRecord,
    cancelToken: string,
  ): Promise<void> {
    const projection = buildTaskProjection(task, [], {
      maxTextLength: this.config.maxTextLength,
      cancelToken,
      targetLabel: describeTaskTarget(binding),
    });
    const cardId = await this.cardClient.createCard(projection.card);
    const cardMessageId = await this.cardClient.replyCard(
      binding.rootMessageId,
      cardId,
      task.id,
    );
    const attached = new BridgeRepositories(this.database).tasks.attachCard(
      task.id,
      cardId,
      cardMessageId,
      this.now(),
    );
    if (!attached) {
      throw new Error('Initial card identity conflicted with durable task state');
    }
  }

  private claimExecutionSlot(taskId: string): boolean {
    try {
      return this.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        const active = repositories.tasks.findAnyActive();
        const oldestWaiting = repositories.tasks.findOldestWaiting();
        if (!oldestWaiting) {
          throw new Error('Card-ready task disappeared from the waiting queue');
        }
        if (active || oldestWaiting.id !== taskId) {
          if (!repositories.tasks.transition(
            taskId,
            'CARD_CREATING',
            'QUEUED',
            this.now(),
          )) {
            throw new Error('Card-ready task could not enter the durable queue');
          }
          return false;
        }
        return repositories.tasks.transition(taskId, 'CARD_CREATING', 'STARTING', this.now());
      });
    } catch (error) {
      if (!isActiveSlotConstraint(error)) {
        throw error;
      }
      const queued = new BridgeRepositories(this.database).tasks.transition(
        taskId,
        'CARD_CREATING',
        'QUEUED',
        this.now(),
      );
      if (queued) {
        return false;
      }
      throw error;
    }
  }

  private async dispatchTask(taskId: string): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const task = repositories.tasks.getById(taskId);
    const binding = task ? repositories.threadBindings.getById(task.bindingId) : undefined;
    if (!task || !binding || task.status !== 'STARTING') {
      return;
    }

    try {
      const target = requireDispatchTarget(binding, this.config);
      await this.resumeThread(task, target);
      const turn = await this.startTurn(task, target);
      await this.completeDispatch(task, target.threadId, turn.id);
    } catch (error) {
      this.failDispatch(task, error);
    }
  }

  private async completeDispatch(
    task: TaskRecord,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    try {
      this.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        const nowMs = this.now();
        if (!repositories.tasks.bindTurn(task.id, turnId, nowMs)) {
          throw new DurableRpcError(
            true,
            false,
            'TURN_IDENTITY_PERSIST_FAILED',
            new Error('App Server turn identity conflicted with durable task state'),
          );
        }
        const current = repositories.tasks.getById(task.id);
        if (!current || current.turnId !== turnId) {
          throw new Error('Durable task did not retain the App Server turn identity');
        }
        if (
          current.status === 'STARTING'
          && !repositories.tasks.transition(task.id, 'STARTING', 'RUNNING', nowMs)
        ) {
          throw new Error('Started task could not enter RUNNING state');
        }
        if (current.status !== 'STARTING' && !isDispatchCompletionState(current.status)) {
          throw new Error('Task reached an invalid state while completing dispatch');
        }
        convergeInboxProcessed(repositories, task.sourceInboxId, nowMs, null);
      });
      this.turnEvents?.drainTurnStart(task.id, threadId, turnId);
    } catch (error) {
      this.turnEvents?.abandonTurnStart(task.id, threadId);
      throw error;
    }
    this.projections.request(task.id, true);

    const refreshed = new BridgeRepositories(this.database).tasks.getById(task.id);
    if (refreshed?.cancelRequested) {
      await this.interruptTask(task.id);
    }
  }

  private failDispatch(task: TaskRecord, error: unknown): void {
    const durableError = error instanceof DurableRpcError ? error : undefined;
    const nextStatus = durableError?.outcomeUnknown ? 'DISPATCH_UNKNOWN' : 'FAILED';
    const errorCode = stableRpcErrorCode(error);
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const nowMs = this.now();
      const current = repositories.tasks.getById(task.id);
      if (!current) {
        throw new Error('Failed dispatch task no longer exists');
      }
      if (current.status === 'STARTING') {
        if (!repositories.tasks.transition(task.id, 'STARTING', nextStatus, nowMs, {
          errorCode,
        })) {
          throw new Error('Failed dispatch task could not reach its durable state');
        }
      } else if (!isDispatchCompletionState(current.status)) {
        throw new Error('Failed dispatch task reached an unexpected concurrent state');
      }
      convergeInboxProcessed(repositories, task.sourceInboxId, nowMs, errorCode);
    });
    this.projections.request(task.id, true);
  }

  private convergeSteerResult(
    taskId: string,
    inboxId: string,
    inboxStatus: 'PROCESSED' | 'REJECTED',
    errorCode: string | null,
  ): void {
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const nowMs = this.now();
      if (!repositories.inbox.transition(
        inboxId,
        'ACCEPTED',
        inboxStatus,
        nowMs,
        errorCode,
      )) {
        const currentInbox = repositories.inbox.getById(inboxId);
        if (currentInbox?.status !== inboxStatus) {
          throw new Error('Steer source inbox could not converge');
        }
      }
      const task = repositories.tasks.getById(taskId);
      if (task && !isTerminalTask(task.status)) {
        if (!repositories.tasks.setOperationalError(taskId, errorCode, nowMs)) {
          throw new Error('Steer task warning could not converge');
        }
      }
    });
  }

  private async sendInterrupt(
    task: TaskRecord,
    params: TurnInterruptParams,
    operationKey: string,
    allowUnsentRetry: boolean,
  ): Promise<void> {
    try {
      await this.durableRequest<Record<string, never>>(
        task.id,
        operationKey,
        'turn/interrupt',
        params,
        allowUnsentRetry,
      );
    } catch (error) {
      if (error instanceof DurableRpcError && !error.outcomeUnknown) {
        new BridgeRepositories(this.database).tasks.clearCancellationRequest(
          task.id,
          this.now(),
        );
        this.projections.request(task.id, true);
      }
      throw error;
    }
  }

  private async resumeThread(
    task: TaskRecord,
    target: DispatchTarget,
    allowUnsentRetry = false,
    operationKey = `${task.id}:thread-resume`,
  ): Promise<void> {
    const params: ThreadResumeParams = {
      threadId: target.threadId,
      cwd: target.workspacePath,
      runtimeWorkspaceRoots: [target.workspacePath],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      excludeTurns: false,
    };
    const response = await this.durableRequest<ThreadResumeResponse>(
      task.id,
      operationKey,
      'thread/resume',
      params,
      allowUnsentRetry,
    );
    if (requireThreadId(response.thread) !== target.threadId) {
      throw new Error('App Server resumed a different thread');
    }
  }

  private async startTurn(
    task: TaskRecord,
    target: DispatchTarget,
    allowUnsentRetry = false,
  ): Promise<TurnStartResponse['turn']> {
    const params: TurnStartParams = {
      threadId: target.threadId,
      clientUserMessageId: task.sourceInboxId,
      input: [{ type: 'text', text: task.prompt, text_elements: [] }],
      cwd: target.workspacePath,
      runtimeWorkspaceRoots: [target.workspacePath],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [target.workspacePath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
    this.turnEvents?.beginTurnStart(task.id, target.threadId);
    try {
      const response = await this.durableRequest<TurnStartResponse>(
        task.id,
        `${task.id}:turn-start`,
        'turn/start',
        params,
        allowUnsentRetry,
      );
      if (!response.turn || typeof response.turn.id !== 'string' || !response.turn.id) {
        throw new Error('App Server turn/start returned no turn identity');
      }
      return response.turn;
    } catch (error) {
      this.turnEvents?.abandonTurnStart(task.id, target.threadId);
      throw error;
    }
  }

  private async durableRequest<TResult>(
    taskId: string,
    operationKey: string,
    method: string,
    params: unknown,
    allowUnsentRetry = false,
  ): Promise<TResult> {
    const epoch = this.appServer.connectionEpoch;
    const repositories = new BridgeRepositories(this.database);
    const preparedInput = {
      operationKey,
      taskId,
      method,
      requestDigest: sha256(JSON.stringify(params)),
      connectionEpoch: epoch,
      nowMs: this.now(),
    };
    const existing = repositories.rpcIntents.findByOperationKey(operationKey);
    if (allowUnsentRetry && existing) {
      if (!repositories.rpcIntents.reprepareUnsent(preparedInput)) {
        throw new DurableRpcError(
          true,
          false,
          'RPC_INTENT_OUTCOME_NOT_REPLAYABLE',
          undefined,
        );
      }
    }
    const intent = repositories.rpcIntents.prepare(preparedInput);
    if (intent.state !== 'PREPARED') {
      throw new DurableRpcError(true, false, 'RPC_INTENT_ALREADY_SENT', undefined);
    }

    let sent = false;
    try {
      const response = await this.appServer.requestTracked<TResult>(
        method,
        params,
        (identity) => {
          if (identity.epoch !== epoch) {
            throw new Error('App Server connection changed before request send');
          }
          const marked = new BridgeRepositories(this.database).rpcIntents.markSent(
            intent.id,
            String(identity.id),
            this.now(),
          );
          if (!marked) {
            throw new Error('RPC intent could not enter SENT state');
          }
          sent = true;
        },
      );
      if (!new BridgeRepositories(this.database).rpcIntents.resolve(
        intent.id,
        'RESOLVED',
        this.now(),
      )) {
        throw new DurableRpcError(true, false, 'RPC_RESOLUTION_PERSIST_FAILED', undefined);
      }
      return response;
    } catch (error) {
      const outcomeUnknown = sent && !isDefinitiveRpcFailure(error);
      const currentRepositories = new BridgeRepositories(this.database);
      if (sent) {
        currentRepositories.rpcIntents.resolve(
          intent.id,
          outcomeUnknown ? 'UNKNOWN' : 'FAILED',
          this.now(),
          stableRpcErrorCode(error),
        );
      } else {
        currentRepositories.rpcIntents.failPrepared(
          intent.id,
          this.now(),
          stableRpcErrorCode(error),
        );
      }
      throw new DurableRpcError(outcomeUnknown, !sent, stableRpcErrorCode(error), error);
    }
  }

  private failBeforeDispatch(
    task: TaskRecord,
    inbox: InboxEventRecord,
    errorCode: string,
  ): void {
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const nowMs = this.now();
      if (!repositories.tasks.transition(
        task.id,
        'CARD_CREATING',
        'FAILED',
        nowMs,
        { errorCode },
      )) {
        throw new Error('Pre-dispatch task could not enter FAILED state');
      }
      convergeInboxProcessed(repositories, inbox.id, nowMs, errorCode);
    });
  }
}

function convergeInboxProcessed(
  repositories: BridgeRepositories,
  inboxId: string,
  nowMs: number,
  errorCode: string | null,
): void {
  if (repositories.inbox.transition(
    inboxId,
    'ACCEPTED',
    'PROCESSED',
    nowMs,
    errorCode,
  )) {
    return;
  }
  if (repositories.inbox.getById(inboxId)?.status !== 'PROCESSED') {
    throw new Error('Task source inbox could not enter PROCESSED state');
  }
}

function isDispatchCompletionState(status: TaskRecord['status']): boolean {
  return status === 'RUNNING'
    || status === 'AWAITING_APPROVAL'
    || status === 'COMPLETING'
    || status === 'SUCCEEDED'
    || status === 'FAILED'
    || status === 'INTERRUPTED';
}

function isAcceptedDispatchState(status: TaskRecord['status']): boolean {
  return status === 'RUNNING'
    || status === 'AWAITING_APPROVAL'
    || status === 'COMPLETING'
    || status === 'SUCCEEDED';
}

function requireDispatchTarget(
  binding: ThreadBindingRecord,
  config: BridgeConfig,
): DispatchTarget {
  if (!binding.threadId) {
    throw new Error('Bound task has no ChatGPT thread identity');
  }
  if (!config.allowedWorkspaceRoots.some((root) => (
    isPathWithinRoot(binding.workspacePath, root)
  ))) {
    throw new Error('Bound task workspace is outside the configured allowlist');
  }
  return {
    threadId: binding.threadId,
    workspacePath: binding.workspacePath,
  };
}

function projectId(workspacePath: string): string {
  return PROJECT_ID_PREFIX + sha256(workspacePath).slice(0, 16);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function steerOperationKey(inboxId: string): string {
  return `inbox:${inboxId}:turn-steer`;
}

function buildSteerParams(
  threadId: string,
  turnId: string,
  inbox: InboxEventRecord,
  text: string,
): TurnSteerParams {
  return {
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: inbox.messageId,
    input: [{ type: 'text', text, text_elements: [] }],
  };
}

function requireThreadId(thread: Thread): string {
  if (!thread || typeof thread.id !== 'string' || !thread.id) {
    throw new Error('App Server response has no thread identity');
  }
  return thread.id;
}

function isDefinitiveRpcFailure(error: unknown): boolean {
  return error instanceof AppServerRpcError;
}

function isActiveSlotConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const sqliteCode = (error as Error & { readonly code?: unknown }).code;
  return sqliteCode === 'ERR_SQLITE_ERROR'
    && error.message.includes('UNIQUE constraint failed')
    && error.message.includes('uq_task_single_active_turn');
}

function isTerminalTask(status: TaskRecord['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'INTERRUPTED';
}

function isSteerableTask(task: TaskRecord): boolean {
  return task.status === 'RUNNING'
    || task.status === 'AWAITING_APPROVAL'
    || task.status === 'RECOVERING';
}

function stableRpcErrorCode(error: unknown): string {
  if (error instanceof DurableRpcError) {
    return error.errorCode;
  }
  if (error instanceof AppServerRpcError) {
    return `APP_SERVER_RPC_${error.code}`;
  }
  if (error instanceof AppServerNotReadyError) {
    return 'APP_SERVER_NOT_READY';
  }
  if (error instanceof AppServerConnectionError) {
    return 'APP_SERVER_CONNECTION_LOST';
  }
  if (error instanceof Error && error.message.includes('timeout')) {
    return 'APP_SERVER_TIMEOUT';
  }
  return 'APP_SERVER_REQUEST_FAILED';
}
