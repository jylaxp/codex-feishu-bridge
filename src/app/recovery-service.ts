import {
  AppServerClientEvent,
  AppServerConnectionState,
} from './codex/app-server-client';
import {
  ThreadItem,
  ThreadResumeParams,
  ThreadResumeResponse,
  Turn,
} from './codex/protocol';
import { BridgeDatabase } from './db/database';
import {
  APPROVAL_RESPONSE_RPC_METHOD,
  BridgeRepositories,
  RpcIntentRecord,
  TaskItemStatus,
  TaskRecord,
  UpsertTaskItemInput,
} from './db/repositories';
import { BridgeConfig, TaskStatus } from './domain';
import {
  ProjectionRequester,
  RecoverableDispatchMethod,
} from './task-orchestrator';
import { isPathWithinRoot } from './preflight';

const RECOVERABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'COMPLETING',
  'RECOVERING',
]);
const RECOVERY_COMMAND_OUTPUT_TAIL_LIMIT = 4_096;

interface RecoveredTerminalTransition {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  readonly finalText?: string;
  readonly errorCode?: string;
}

export interface RecoveryAppServer {
  readonly connectionEpoch: number;
  request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
}

export interface AppServerLifecycleClient extends RecoveryAppServer {
  readonly state: AppServerConnectionState;
  start(): Promise<unknown>;
  stop(): Promise<void>;
  subscribe(listener: (event: AppServerClientEvent) => void): () => void;
}

export interface RecoveryServiceOptions {
  readonly onSlotAvailable?: () => Promise<unknown>;
  readonly onPendingCancellation?: (taskId: string) => Promise<unknown>;
  readonly onRecoveryComplete?: () => Promise<unknown>;
  readonly onRecoverUnsentDispatch?: (
    taskId: string,
    method: RecoverableDispatchMethod,
  ) => Promise<unknown>;
  readonly onRecoverUnsentSteer?: (inboxId: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly runtimeInstanceId?: string;
}

/** Reconciles durable active tasks after an App Server connection epoch changes. */
export class RecoveryService {
  private readonly now: () => number;
  private readonly onSlotAvailable: () => Promise<unknown>;
  private readonly onPendingCancellation:
    | ((taskId: string) => Promise<unknown>)
    | undefined;
  private readonly onRecoveryComplete: () => Promise<unknown>;
  private readonly onRecoverUnsentDispatch:
    | ((taskId: string, method: RecoverableDispatchMethod) => Promise<unknown>)
    | undefined;
  private readonly onRecoverUnsentSteer:
    | ((inboxId: string) => Promise<unknown>)
    | undefined;
  private readonly runtimeInstanceId: string;

  public constructor(
    private readonly database: BridgeDatabase,
    private readonly config: BridgeConfig,
    private readonly appServer: RecoveryAppServer,
    private readonly projections: ProjectionRequester,
    options: RecoveryServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onSlotAvailable = options.onSlotAvailable ?? (() => Promise.resolve());
    this.onPendingCancellation = options.onPendingCancellation;
    this.onRecoveryComplete = options.onRecoveryComplete ?? (() => Promise.resolve());
    this.onRecoverUnsentDispatch = options.onRecoverUnsentDispatch;
    this.onRecoverUnsentSteer = options.onRecoverUnsentSteer;
    this.runtimeInstanceId = options.runtimeInstanceId ?? 'unbound-recovery-runtime';
  }

  /** Marks old approvals stale and active tasks as recovering without resending work. */
  public markConnectionLost(nextEpoch: number): void {
    const repositories = new BridgeRepositories(this.database);
    repositories.approvals.markStaleBeforeEpoch(nextEpoch, this.now());
    for (const task of repositories.tasks.findActive()) {
      if (RECOVERABLE_STATUSES.has(task.status) && task.status !== 'RECOVERING') {
        repositories.tasks.transition(task.id, task.status, 'RECOVERING', this.now());
        this.projections.request(task.id, true);
      }
    }
  }

  /** Resumes known threads and converges task state from the authoritative snapshot. */
  public async recoverReady(): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    repositories.approvals.markPendingStaleExceptRuntime(
      this.runtimeInstanceId,
      this.now(),
    );
    this.reconcileInterruptedCardCreation();
    this.reprojectMissingTerminalOutbox();
    await this.recoverUnsentStartingDispatches();
    const activeTasks = repositories.tasks.findActive();
    for (const task of activeTasks) {
      await this.reconcileTask(task);
    }
    await this.reconcileSteerIntents();
    this.reconcileUncertainApprovalResponses();
    await this.recoverPendingCancellations();
    await this.onRecoveryComplete();
    await this.onSlotAvailable();
  }

  private reprojectMissingTerminalOutbox(): void {
    const repositories = new BridgeRepositories(this.database);
    for (const task of repositories.tasks.findTerminalWithoutOutbox()) {
      this.projections.request(task.id, true);
    }
  }

  private async recoverUnsentStartingDispatches(): Promise<void> {
    if (!this.onRecoverUnsentDispatch) {
      return;
    }
    const repositories = new BridgeRepositories(this.database);
    for (const task of repositories.tasks.findActive()) {
      if (task.status !== 'STARTING' || task.turnId) {
        continue;
      }
      const binding = repositories.threadBindings.getById(task.bindingId);
      const method = binding
        ? this.findRecoverableDispatchMethod(repositories, task, binding.threadId)
        : undefined;
      if (method) {
        await this.onRecoverUnsentDispatch(task.id, method);
      }
    }
  }

  private findRecoverableDispatchMethod(
    repositories: BridgeRepositories,
    task: TaskRecord,
    threadId: string | null,
  ): RecoverableDispatchMethod | undefined {
    if (!threadId) {
      return undefined;
    }
    if (!isProvablyUnsent(repositories.rpcIntents.findByOperationKey(
      `${task.id}:turn-start`,
    ))) {
      return undefined;
    }
    // Every fresh connection must resume the durable thread before retrying a
    // provably-unsent turn/start, regardless of the earlier resume outcome.
    return 'thread/resume';
  }

  private reconcileUncertainApprovalResponses(): void {
    const affectedTaskIds = this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const taskIds = new Set<string>();
      for (const intent of repositories.rpcIntents.findUncertainByMethod(
        APPROVAL_RESPONSE_RPC_METHOD,
      )) {
        repositories.rpcIntents.markUnknown(
          intent.id,
          this.now(),
          'APPROVAL_RESPONSE_RECOVERY_UNKNOWN',
        );
        if (!intent.taskId) {
          continue;
        }
        const task = repositories.tasks.getById(intent.taskId);
        if (!task || isTerminal(task.status)) {
          continue;
        }
        repositories.tasks.transition(
          task.id,
          task.status,
          'DISPATCH_UNKNOWN',
          this.now(),
          { errorCode: 'APPROVAL_RESPONSE_RECOVERY_UNKNOWN' },
        );
        taskIds.add(task.id);
      }
      return [...taskIds];
    });
    for (const taskId of affectedTaskIds) {
      this.projections.request(taskId, true);
    }
  }

  private async reconcileSteerIntents(): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    for (const intent of repositories.rpcIntents.findByMethod('turn/steer')) {
      const inboxId = steerInboxId(intent.operationKey);
      const inbox = inboxId ? repositories.inbox.getById(inboxId) : undefined;
      if (!inbox || inbox.status !== 'ACCEPTED' || !intent.taskId) {
        continue;
      }
      if (intent.state === 'RESOLVED') {
        const taskId = this.convergeSteerIntent(intent, inbox.id, 'PROCESSED', null, false);
        if (taskId) {
          this.projections.request(taskId, true);
        }
        continue;
      }
      if (intent.state === 'SENT' || intent.state === 'UNKNOWN') {
        const taskId = this.convergeSteerIntent(
          intent,
          inbox.id,
          'PROCESSED',
          'STEER_OUTCOME_UNKNOWN',
          intent.state === 'SENT',
        );
        if (taskId) {
          this.projections.request(taskId, true);
        }
        continue;
      }
      if (intent.state === 'FAILED' && intent.rpcId !== null) {
        const taskId = this.convergeSteerIntent(
          intent,
          inbox.id,
          'REJECTED',
          intent.errorCode ?? 'STEER_REJECTED',
          false,
        );
        if (taskId) {
          this.projections.request(taskId, true);
        }
        continue;
      }
      if (intent.rpcId === null && this.onRecoverUnsentSteer) {
        await this.onRecoverUnsentSteer(inbox.id);
      }
    }
  }

  private convergeSteerIntent(
    intent: RpcIntentRecord,
    inboxId: string,
    nextInboxStatus: 'PROCESSED' | 'REJECTED',
    errorCode: string | null,
    markUnknown: boolean,
  ): string | null {
    return this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const nowMs = this.now();
      if (markUnknown && !repositories.rpcIntents.markUnknown(
        intent.id,
        nowMs,
        errorCode ?? 'STEER_OUTCOME_UNKNOWN',
      )) {
        throw new Error('Steer RPC intent could not converge to UNKNOWN');
      }
      if (!repositories.inbox.transition(
        inboxId,
        'ACCEPTED',
        nextInboxStatus,
        nowMs,
        errorCode,
      )) {
        throw new Error('Steer source inbox could not converge');
      }
      if (!intent.taskId) {
        return null;
      }
      const task = repositories.tasks.getById(intent.taskId);
      if (!task || isTerminal(task.status)) {
        return null;
      }
      repositories.tasks.setOperationalError(task.id, errorCode, nowMs);
      return task.id;
    });
  }

  private async recoverPendingCancellations(): Promise<void> {
    if (!this.onPendingCancellation) {
      return;
    }
    const tasks = new BridgeRepositories(this.database)
      .tasks
      .findPendingCancellationsWithTurnIdentity();
    for (const task of tasks) {
      await this.onPendingCancellation(task.id);
    }
  }

  private reconcileInterruptedCardCreation(): void {
    const repositories = new BridgeRepositories(this.database);
    for (const task of repositories.tasks.findCardCreating()) {
      if (task.cardId && task.cardMessageId) {
        if (repositories.tasks.transition(task.id, 'CARD_CREATING', 'QUEUED', this.now())) {
          this.projections.request(task.id, true);
        }
        continue;
      }
      repositories.tasks.transition(task.id, 'CARD_CREATING', 'NEEDS_REVIEW', this.now(), {
        errorCode: 'INITIAL_CARD_IDENTITY_UNKNOWN',
      });
    }
  }

  private async reconcileTask(task: TaskRecord): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const binding = repositories.threadBindings.getById(task.bindingId);
    if (
      !binding?.threadId
      || !task.turnId
      || !this.config.allowedWorkspaceRoots.some((root) => (
        isPathWithinRoot(binding.workspacePath, root)
      ))
    ) {
      this.markOutcomeUnknown(task, 'RECOVERY_IDENTITY_INCOMPLETE');
      return;
    }

    const params: ThreadResumeParams = {
      threadId: binding.threadId,
      cwd: binding.workspacePath,
      runtimeWorkspaceRoots: [binding.workspacePath],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      excludeTurns: false,
    };
    let response: ThreadResumeResponse;
    try {
      response = await this.appServer.request<ThreadResumeResponse>('thread/resume', params);
    } catch {
      this.markOutcomeUnknown(task, 'RECOVERY_RESUME_FAILED');
      return;
    }
    if (response.thread.id !== binding.threadId) {
      this.markOutcomeUnknown(task, 'RECOVERY_THREAD_MISMATCH');
      return;
    }
    const turn = response.thread.turns.find((candidate) => candidate.id === task.turnId);
    if (!turn) {
      this.markOutcomeUnknown(task, 'RECOVERY_TURN_NOT_FOUND');
      return;
    }
    this.convergeFromTurn(task, turn);
  }

  private convergeFromTurn(task: TaskRecord, turn: Turn): void {
    const repositories = new BridgeRepositories(this.database);
    const current = repositories.tasks.getById(task.id);
    if (!current) {
      return;
    }
    this.persistTurnItems(current.id, turn);
    if (turn.status === 'inProgress') {
      this.database.transaction((executor) => {
        const transactionalRepositories = new BridgeRepositories(executor);
        const nowMs = this.now();
        const durableTask = transactionalRepositories.tasks.getById(current.id);
        if (!durableTask || isTerminal(durableTask.status)) {
          return;
        }
        if (
          durableTask.status !== 'RUNNING'
          && !transactionalRepositories.tasks.transition(
            durableTask.id,
            durableTask.status,
            'RUNNING',
            nowMs,
          )
        ) {
          throw new Error('Recovered active task could not converge to RUNNING');
        }
        convergeProcessedInbox(
          transactionalRepositories,
          durableTask.sourceInboxId,
          nowMs,
          null,
        );
      });
      this.projections.request(current.id, true);
      return;
    }

    const finalText = finalAnswer(turn);
    let terminal: RecoveredTerminalTransition;
    if (turn.status === 'completed') {
      terminal = { status: 'SUCCEEDED', finalText };
    } else if (turn.status === 'interrupted') {
      terminal = {
        status: 'INTERRUPTED',
        finalText,
        errorCode: 'APP_SERVER_TURN_INTERRUPTED',
      };
    } else {
      terminal = {
        status: 'FAILED',
        finalText,
        errorCode: 'APP_SERVER_TURN_FAILED',
      };
    }
    this.convergeRecoveredTerminal(current, terminal);
    this.projections.request(current.id, true);
  }

  private convergeRecoveredTerminal(
    task: TaskRecord,
    terminal: RecoveredTerminalTransition,
  ): void {
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const nowMs = this.now();
      const transitioned = repositories.tasks.transition(
        task.id,
        task.status,
        terminal.status,
        nowMs,
        {
          finalText: terminal.finalText,
          errorCode: terminal.errorCode,
        },
      );
      const durableTask = transitioned ? undefined : repositories.tasks.getById(task.id);
      if (!transitioned && (!durableTask || !isTerminal(durableTask.status))) {
        throw new Error('Recovered terminal task could not converge');
      }
      const inboxProcessed = repositories.inbox.transition(
        task.sourceInboxId,
        'ACCEPTED',
        'PROCESSED',
        nowMs,
        terminal.errorCode ?? durableTask?.errorCode ?? null,
      );
      const durableInbox = inboxProcessed
        ? undefined
        : repositories.inbox.getById(task.sourceInboxId);
      if (!inboxProcessed && durableInbox?.status !== 'PROCESSED') {
        throw new Error('Recovered terminal task source inbox could not converge');
      }
    });
  }

  private persistTurnItems(taskId: string, turn: Turn): void {
    const repositories = new BridgeRepositories(this.database);
    const nowMs = this.now();
    for (const item of turn.items) {
      const recovered = recoveredTaskItem(taskId, turn, item, nowMs);
      if (recovered) {
        repositories.taskItems.upsert(recovered);
      }
    }
  }

  private markOutcomeUnknown(task: TaskRecord, errorCode: string): void {
    const changed = this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const current = repositories.tasks.getById(task.id);
      if (!current || isTerminal(current.status)) {
        return false;
      }
      const nowMs = this.now();
      if (!repositories.tasks.transition(
        current.id,
        current.status,
        'DISPATCH_UNKNOWN',
        nowMs,
        { errorCode },
      )) {
        throw new Error('Recovered task could not enter DISPATCH_UNKNOWN');
      }
      convergeProcessedInbox(
        repositories,
        current.sourceInboxId,
        nowMs,
        errorCode,
      );
      return true;
    });
    if (changed) {
      this.projections.request(task.id, true);
    }
  }
}

function convergeProcessedInbox(
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
    throw new Error('Recovered task source inbox could not converge');
  }
}

export interface AppServerSupervisorOptions {
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly onError?: (error: Error) => void;
}

export interface RecoveryCoordinator {
  markConnectionLost(nextEpoch: number): void;
  recoverReady(): Promise<void>;
}

/** Owns App Server reconnect attempts while delegating state reconciliation. */
export class AppServerSupervisor {
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly onError: (error: Error) => void;
  private unsubscribe: (() => void) | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private activeReconnect: Promise<void> | undefined;
  private reconnecting = false;
  private stopped = true;
  private retryCount = 0;

  public constructor(
    private readonly client: AppServerLifecycleClient,
    private readonly recovery: RecoveryCoordinator,
    options: AppServerSupervisorOptions = {},
  ) {
    this.baseRetryDelayMs = positiveInteger(options.baseRetryDelayMs ?? 1_000);
    this.maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs ?? 30_000);
    this.onError = options.onError ?? (() => undefined);
  }

  public async start(): Promise<void> {
    if (!this.stopped) {
      throw new Error('App Server supervisor is already started');
    }
    this.stopped = false;
    this.unsubscribe = this.client.subscribe((event) => {
      if (event.type === 'state' && event.state === 'FAILED') {
        try {
          this.recovery.markConnectionLost(event.epoch + 1);
        } catch (error) {
          this.reportError(error);
        }
        this.scheduleReconnect();
      }
    });
    try {
      await this.client.start();
      this.retryCount = 0;
      await this.recovery.recoverReady();
    } catch (error) {
      try {
        await this.stop();
      } catch (stopError) {
        throw new AggregateError(
          [toError(error), toError(stopError)],
          'App Server startup and shutdown both failed',
        );
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const activeReconnect = this.activeReconnect;
    let stopError: unknown;
    try {
      await this.client.stop();
    } catch (error) {
      stopError = error;
    }
    await activeReconnect;
    if (this.client.state !== 'CLOSED') {
      try {
        await this.client.stop();
      } catch (error) {
        stopError = stopError
          ? new AggregateError(
              [toError(stopError), toError(error)],
              'App Server client shutdown failed more than once',
            )
          : error;
      }
    }
    if (stopError) {
      throw stopError;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.reconnecting) {
      return;
    }
    const delay = Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * (2 ** this.retryCount),
    );
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.launchReconnect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private launchReconnect(): void {
    const reconnect = this.reconnect().catch((error) => {
      this.reportError(error);
    });
    this.activeReconnect = reconnect;
    void reconnect.then(() => {
      if (this.activeReconnect === reconnect) {
        this.activeReconnect = undefined;
      }
    });
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    let retryRequired = false;
    try {
      await this.client.start();
      if (this.stopped) {
        await this.client.stop();
        return;
      }
      await this.recovery.recoverReady();
      if (this.stopped) {
        await this.client.stop();
        return;
      }
      this.retryCount = 0;
    } catch (error) {
      this.reportError(error);
      retryRequired = true;
      if (!this.stopped) {
        try {
          await this.client.stop();
        } catch (stopError) {
          this.reportError(stopError);
        }
      }
    } finally {
      this.reconnecting = false;
      if (retryRequired || this.client.state === 'FAILED') {
        this.scheduleReconnect();
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError(toError(error));
    } catch {
      // Error reporting must not turn a detached reconnect into an unhandled rejection.
    }
  }
}

function finalAnswer(turn: Turn): string | undefined {
  const text = turn.items
    .filter((item) => item.type === 'agentMessage' && item.phase === 'final_answer')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

function recoveredTaskItem(
  taskId: string,
  turn: Turn,
  item: ThreadItem,
  nowMs: number,
): UpsertTaskItemInput | null {
  const turnItemStatus: TaskItemStatus = turn.status === 'inProgress'
    ? 'STARTED'
    : 'COMPLETED';
  if (
    item.type === 'agentMessage'
    && (item.phase === 'commentary' || item.phase === 'final_answer')
  ) {
    return {
      taskId,
      itemId: item.id,
      itemType: 'agent_message',
      phase: item.phase,
      status: turnItemStatus,
      contentText: typeof item.text === 'string' ? item.text : '',
      nowMs,
    };
  }
  if (item.type === 'reasoning' && Array.isArray(item.summary)) {
    return {
      taskId,
      itemId: item.id,
      itemType: 'reasoning_summary',
      status: turnItemStatus,
      contentText: item.summary.filter((part) => typeof part === 'string').join(''),
      nowMs,
    };
  }
  if (item.type !== 'commandExecution') {
    return null;
  }
  const command = typeof item.command === 'string' ? item.command : '';
  const output = typeof item.aggregatedOutput === 'string'
    ? tail(item.aggregatedOutput, RECOVERY_COMMAND_OUTPUT_TAIL_LIMIT)
    : '';
  const status: TaskItemStatus = item.status === 'inProgress'
    ? 'STARTED'
    : 'COMPLETED';
  return {
    taskId,
    itemId: item.id,
    itemType: 'command_execution',
    status,
    contentText: [command, output].filter(Boolean).join('\n'),
    terminalPayloadJson: JSON.stringify({ command, outputTail: output }),
    nowMs,
  };
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'INTERRUPTED';
}

function isProvablyUnsent(intent: RpcIntentRecord | undefined): boolean {
  return intent === undefined
    || (
      intent.rpcId === null
      && (intent.state === 'PREPARED' || intent.state === 'FAILED')
    );
}

function steerInboxId(operationKey: string): string | null {
  const match = /^inbox:([0-9a-f-]+):turn-steer$/i.exec(operationKey);
  return match?.[1] ?? null;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Retry delay must be a positive safe integer');
  }
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown App Server reconnect error');
}
