import { createHash, randomUUID } from 'node:crypto';

import { createOpaqueActionToken, hashActionToken } from './action-tokens';
import { CardKitJson, createApprovalCard } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import { RequestId, ServerRequest } from './codex/protocol';
import { BridgeDatabase } from './db/database';
import {
  APPROVAL_RESPONSE_RPC_METHOD,
  ApprovalDecision,
  ApprovalRecord,
  BridgeRepositories,
  DecisionTokenHashes,
  RpcIntentRecord,
  TaskRecord,
  ThreadBindingRecord,
} from './db/repositories';
import { BridgeConfig } from './domain';
import { InboundCardAction, toast } from './lark/event-server';
import { ProjectionRequester } from './task-orchestrator';

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const SUPPORTED_DECISIONS: readonly ApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
];

export interface ApprovalAppServer {
  readonly connectionEpoch: number;
  respond(id: RequestId, result: unknown, expectedEpoch?: number): Promise<void>;
  respondError(
    id: RequestId,
    error: { readonly code: number; readonly message: string },
    expectedEpoch?: number,
  ): Promise<void>;
}

export interface ApprovalCardClient {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
}

export interface TaskInterrupter {
  interruptTask(taskId: string): Promise<void>;
}

interface ApprovalContext {
  readonly task: TaskRecord;
  readonly binding: ThreadBindingRecord;
  readonly operationSummary: string;
  readonly reason: string;
  readonly itemId: string;
  readonly decisions: readonly ApprovalDecision[];
}

interface ActionTokens {
  readonly raw: Readonly<Partial<Record<ApprovalDecision, string>>>;
  readonly hashes: DecisionTokenHashes;
}

interface DeferredApprovalRequest {
  readonly request: ServerRequest;
  readonly epoch: number;
}

type ApprovalContextResolution =
  | { readonly disposition: 'ready'; readonly context: ApprovalContext }
  | { readonly disposition: 'defer' }
  | { readonly disposition: 'invalid' };

export interface ApprovalServiceOptions {
  readonly now?: () => number;
  readonly runtimeInstanceId?: string;
}

/** Handles App Server approval requests and authenticated CardKit actions. */
export class ApprovalService {
  private readonly now: () => number;
  private readonly runtimeInstanceId: string;
  private readonly deferredRequests = new Map<string, DeferredApprovalRequest>();

  public constructor(
    private readonly database: BridgeDatabase,
    private readonly config: BridgeConfig,
    private readonly appServer: ApprovalAppServer,
    private readonly cardClient: ApprovalCardClient,
    private readonly orchestrator: TaskInterrupter,
    private readonly projections: ProjectionRequester,
    options: ApprovalServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  }

  public async handleServerRequest(request: ServerRequest, epoch: number): Promise<void> {
    if (!isSupportedApprovalMethod(request.method)) {
      await this.appServer.respondError(
        request.id,
        { code: -32601, message: 'Unsupported server request' },
        epoch,
      );
      return;
    }
    if (epoch !== this.appServer.connectionEpoch) {
      return;
    }

    const requestId = encodeRequestIdentity(this.runtimeInstanceId, request.id);
    const repositories = new BridgeRepositories(this.database);
    if (repositories.approvals.findByRequest(epoch, requestId, request.method)) {
      return;
    }

    const resolution = this.resolveContext(request);
    if (resolution.disposition === 'defer') {
      this.deferredRequests.set(
        deferredRequestKey(epoch, request),
        { request, epoch },
      );
      return;
    }
    if (resolution.disposition === 'invalid') {
      await this.respondFailClosed(request.id, epoch);
      return;
    }
    const { context } = resolution;

    const tokens = createActionTokens(context.decisions);
    let cardId: string;
    let cardMessageId: string;
    try {
      const approvalCard = createApprovalCard({
        title: sanitizeCardText('Codex 操作审批', { maxLength: 200 }),
        operationSummary: sanitizeCardText(context.operationSummary, {
          maxLength: Math.min(this.config.maxTextLength, 4_000),
        }),
        reason: sanitizeCardText(context.reason, { maxLength: 2_000 }),
        actionTokens: tokens.raw,
      });
      cardId = await this.cardClient.createCard(approvalCard);
      cardMessageId = await this.cardClient.replyCard(
        context.binding.rootMessageId,
        cardId,
        approvalIdempotencyKey(epoch, requestId, request.method),
      );
    } catch {
      await this.respondFailClosed(request.id, epoch);
      return;
    }

    try {
      const nowMs = this.now();
      this.database.transaction((executor) => {
        const transactionalRepositories = new BridgeRepositories(executor);
        const created = transactionalRepositories.approvals.createPending({
          taskId: context.task.id,
          tenantKey: context.binding.tenantKey,
          chatId: context.binding.chatId,
          // Card callbacks expose open_message_id. The repository's historical
          // `cardId` field therefore stores the approval card message identity.
          cardId: cardMessageId,
          connectionEpoch: epoch,
          requestId,
          method: request.method,
          itemId: context.itemId,
          decisionTokenHashes: tokens.hashes,
          expiresAtMs: nowMs + APPROVAL_TTL_MS,
          nowMs,
        });
        if (!transactionalRepositories.tasks.transition(
          context.task.id,
          'RUNNING',
          'AWAITING_APPROVAL',
          nowMs,
        )) {
          throw new Error('Task can no longer accept this approval request');
        }
        return created;
      });
    } catch {
      await this.respondFailClosed(request.id, epoch);
      return;
    }
    this.projections.request(context.task.id, true);
  }

  /** Re-evaluates approval requests deferred while their task was recovering. */
  public async drainDeferredRequests(): Promise<void> {
    const deferredRequests = [...this.deferredRequests.entries()];
    for (const [key, deferred] of deferredRequests) {
      this.deferredRequests.delete(key);
      if (deferred.epoch !== this.appServer.connectionEpoch) {
        continue;
      }
      await this.handleServerRequest(deferred.request, deferred.epoch);
    }
  }

  public async handleCardAction(action: InboundCardAction): Promise<unknown> {
    const tokenHash = hashActionToken(action.token);
    if (action.action === 'cancel') {
      return this.handleCancellation(action, tokenHash);
    }
    if (!this.config.allowedApprovers.includes(action.operatorOpenId)) {
      return toast('你没有审批权限', 'warning');
    }

    const pending = this.findApprovalByToken(tokenHash);
    if (!pending) {
      return toast('审批已处理、过期或无效', 'warning');
    }
    const { approval, decision } = pending;
    const storedRequest = parseRequestIdentity(approval.requestId);
    if (
      approval.tenantKey !== action.tenantKey
      || approval.chatId !== action.chatId
      || approval.cardId !== action.messageId
      || approval.connectionEpoch !== this.appServer.connectionEpoch
      || storedRequest.runtimeInstanceId !== this.runtimeInstanceId
    ) {
      return toast('审批作用域不匹配', 'warning');
    }

    let responseIntent: RpcIntentRecord | undefined;
    try {
      const nowMs = this.now();
      responseIntent = this.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        const consumed = repositories.approvals.decide({
          approvalId: approval.id,
          tenantKey: action.tenantKey,
          chatId: action.chatId,
          cardId: action.messageId,
          connectionEpoch: approval.connectionEpoch,
          actionTokenHash: tokenHash,
          decision,
          decidedByOpenId: action.operatorOpenId,
          nowMs,
        });
        if (!consumed) {
          return undefined;
        }
        return repositories.rpcIntents.prepare({
          operationKey: approvalResponseOperationKey(approval.id),
          taskId: approval.taskId,
          method: APPROVAL_RESPONSE_RPC_METHOD,
          requestDigest: approvalResponseDigest(approval, storedRequest, decision),
          connectionEpoch: approval.connectionEpoch,
          nowMs,
        });
      });
    } catch {
      return toast('审批处理失败，请重试', 'error');
    }
    if (!responseIntent) {
      return toast('审批已被处理', 'warning');
    }

    try {
      const markedSent = new BridgeRepositories(this.database).rpcIntents.markSent(
        responseIntent.id,
        JSON.stringify(storedRequest.requestId),
        this.now(),
      );
      if (!markedSent) {
        throw new Error('Approval response intent could not enter SENT state');
      }
      await this.appServer.respond(
        storedRequest.requestId,
        { decision },
        approval.connectionEpoch,
      );
      this.database.transaction((executor) => {
        const repositories = new BridgeRepositories(executor);
        if (!repositories.rpcIntents.resolve(
          responseIntent.id,
          'RESOLVED',
          this.now(),
        )) {
          throw new Error('Approval response intent could not enter RESOLVED state');
        }
        repositories.tasks.transition(
          approval.taskId,
          'AWAITING_APPROVAL',
          'RUNNING',
          this.now(),
        );
      });
      this.projections.request(approval.taskId, true);
      return toast('审批决定已提交', 'success');
    } catch {
      this.recordApprovalResponseUnknown(responseIntent.id, approval.taskId);
      this.projections.request(approval.taskId, true);
      return toast('审批响应结果待核对，请勿重复操作', 'error');
    }
  }

  private resolveContext(request: ServerRequest): ApprovalContextResolution {
    const params = asRecord(request.params);
    const threadId = stringValue(params?.threadId);
    const turnId = stringValue(params?.turnId);
    const itemId = stringValue(params?.itemId);
    if (!threadId || !turnId || !itemId) {
      return { disposition: 'invalid' };
    }

    const repositories = new BridgeRepositories(this.database);
    const task = repositories.tasks.findByTurnId(turnId);
    const binding = task ? repositories.threadBindings.getById(task.bindingId) : undefined;
    if (
      !task
      || !binding
      || binding.threadId !== threadId
      || !task.cardId
    ) {
      return { disposition: 'invalid' };
    }

    let context: ApprovalContext;
    if (request.method === 'item/commandExecution/requestApproval') {
      const decisions = commandDecisions(params?.availableDecisions);
      if (decisions.length === 0) {
        return { disposition: 'invalid' };
      }
      context = {
        task,
        binding,
        operationSummary: stringValue(params?.command) ?? '执行命令',
        reason: stringValue(params?.reason) ?? '未提供原因',
        itemId,
        decisions,
      };
    } else {
      context = {
        task,
        binding,
        operationSummary: '应用文件变更',
        reason: stringValue(params?.reason) ?? '未提供原因',
        itemId,
        decisions: SUPPORTED_DECISIONS,
      };
    }

    if (task.status === 'RECOVERING') {
      return { disposition: 'defer' };
    }
    return task.status === 'RUNNING'
      ? { disposition: 'ready', context }
      : { disposition: 'invalid' };
  }

  private async handleCancellation(
    action: InboundCardAction,
    tokenHash: string,
  ): Promise<unknown> {
    const privileged = this.config.allowedApprovers.includes(action.operatorOpenId);
    if (
      !this.config.authorizedUsers.includes(action.operatorOpenId)
      && !privileged
    ) {
      return toast('你没有取消任务的权限', 'warning');
    }
    const task = new BridgeRepositories(this.database).tasks.consumeCancellation(
      {
        tokenHash,
        tenantKey: action.tenantKey,
        chatId: action.chatId,
        cardMessageId: action.messageId,
        operatorOpenId: action.operatorOpenId,
        allowPrivilegedCancellation: privileged,
        updatedAtMs: this.now(),
      },
    );
    if (!task) {
      return toast('任务已结束或取消操作已失效', 'warning');
    }
    try {
      await this.orchestrator.interruptTask(task.id);
      this.projections.request(task.id, true);
      return toast('取消请求已提交', 'success');
    } catch {
      this.projections.request(task.id, true);
      return toast('取消请求结果待核对', 'error');
    }
  }

  private findApprovalByToken(
    tokenHash: string,
  ): { readonly approval: ApprovalRecord; readonly decision: ApprovalDecision } | undefined {
    const approvals = new BridgeRepositories(this.database).approvals;
    for (const decision of SUPPORTED_DECISIONS) {
      const pending = approvals.findPendingByDecisionTokenHash(decision, tokenHash, this.now());
      if (pending) {
        return pending;
      }
    }
    return undefined;
  }

  private async respondFailClosed(id: RequestId, epoch: number): Promise<void> {
    try {
      await this.appServer.respond(id, { decision: 'cancel' }, epoch);
    } catch {
      // A stale connection cannot be answered. The request dies with its epoch.
    }
  }

  private recordApprovalResponseUnknown(intentId: string, taskId: string): void {
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const markedUnknown = repositories.rpcIntents.markUnknown(
        intentId,
        this.now(),
        'APPROVAL_RESPONSE_UNKNOWN',
      );
      if (!markedUnknown) {
        return;
      }
      const task = repositories.tasks.getById(taskId);
      if (task && !isTerminalTask(task)) {
        repositories.tasks.transition(
          task.id,
          task.status,
          'DISPATCH_UNKNOWN',
          this.now(),
          { errorCode: 'APPROVAL_RESPONSE_UNKNOWN' },
        );
      }
    });
  }
}

function isSupportedApprovalMethod(method: string): boolean {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function commandDecisions(value: unknown): readonly ApprovalDecision[] {
  if (value === null || value === undefined) {
    return SUPPORTED_DECISIONS;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return SUPPORTED_DECISIONS.filter((decision) => value.includes(decision));
}

function createActionTokens(decisions: readonly ApprovalDecision[]): ActionTokens {
  const raw: Partial<Record<ApprovalDecision, string>> = {};
  const hashes: Partial<Record<ApprovalDecision, string>> = {};
  for (const decision of decisions) {
    const token = createOpaqueActionToken();
    raw[decision] = token;
    hashes[decision] = hashActionToken(token);
  }
  return { raw: Object.freeze(raw), hashes: Object.freeze(hashes) };
}

function approvalIdempotencyKey(epoch: number, requestId: string, method: string): string {
  return `approval-${sha256(`${epoch}\0${requestId}\0${method}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function approvalResponseOperationKey(approvalId: string): string {
  return `approval-response:${approvalId}`;
}

function approvalResponseDigest(
  approval: ApprovalRecord,
  request: StoredRequestIdentity,
  decision: ApprovalDecision,
): string {
  return sha256(JSON.stringify({
    approvalId: approval.id,
    requestId: request.requestId,
    method: approval.method,
    decision,
  }));
}

function isTerminalTask(task: TaskRecord): boolean {
  return task.status === 'SUCCEEDED'
    || task.status === 'FAILED'
    || task.status === 'INTERRUPTED';
}

interface StoredRequestIdentity {
  readonly runtimeInstanceId: string;
  readonly requestId: RequestId;
}

function parseRequestIdentity(value: string): StoredRequestIdentity {
  const parsed: unknown = JSON.parse(value);
  const record = asRecord(parsed);
  const runtimeInstanceId = stringValue(record?.runtimeInstanceId);
  const requestId = record?.requestId;
  if (
    runtimeInstanceId
    && (
      typeof requestId === 'string'
      || (typeof requestId === 'number' && Number.isFinite(requestId))
    )
  ) {
    return { runtimeInstanceId, requestId };
  }
  throw new TypeError('Stored approval request identity is invalid');
}

function encodeRequestIdentity(runtimeInstanceId: string, requestId: RequestId): string {
  if (!runtimeInstanceId.trim()) {
    throw new TypeError('Runtime instance id is required');
  }
  return JSON.stringify({ runtimeInstanceId, requestId });
}

function deferredRequestKey(epoch: number, request: ServerRequest): string {
  return `${epoch}\0${request.method}\0${JSON.stringify(request.id)}`;
}
