import { createOpaqueActionToken } from './action-tokens';
import type { CardKitJson } from './cards/layouts';
import {
  createApprovalCard,
  createApprovalDecisionCard,
  createApprovalSummaryCard,
  createApprovalUnavailableCard,
} from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import { redactApprovalSecrets } from './cards/approval-redaction';
import type {
  DesktopApprovalRequest,
} from './codex/desktop-approval-adapter';
import type { DesktopIpcClient } from './codex/desktop-ipc-client';
import type { ApprovalDecision, BridgeConfig } from './domain';
import { toast } from './lark/event-server';

const APPROVAL_TTL_MS = 10 * 60_000;

/** Exact Desktop owner capability used to return an approval decision. */
export type DesktopApprovalClient = Pick<
  DesktopIpcClient,
  'connectionEpoch' | 'respondToApproval'
>;

interface ApprovalCardClient {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
  replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
}

interface ApprovalTaskLookup {
  approvalContext(threadId: string, turnId: string | null): {
    readonly taskId: string;
    readonly chatId: string;
    readonly rootMessageId: string;
    readonly workspaceId?: string;
  } | undefined;
  setAwaitingApproval(threadId: string, turnId: string | null, waiting: boolean): boolean;
  failForApprovalDelivery(threadId: string, turnId: string | null): void;
}

interface PendingApproval {
  readonly approval: DesktopApprovalRequest;
  readonly epoch: number;
  readonly chatId: string;
  cardId: string;
  cardMessageId: string;
  cardSequence: number;
  readonly tokens: ReadonlyMap<string, ApprovalDecision>;
  readonly expiresAtMs: number;
  readonly timer: NodeJS.Timeout;
  summary?: ApprovalSummary;
  summaryEntry?: ApprovalSummaryEntry;
}

interface ApprovalSummaryEntry {
  readonly pending: PendingApproval;
  readonly cwd: string;
  decision?: ApprovalDecision;
  decidedAtMs?: number;
  unavailable?: boolean;
}

interface ApprovalSummary {
  readonly taskId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly cardId: string;
  readonly cardMessageId: string;
  readonly entries: ApprovalSummaryEntry[];
  cardSequence: number;
  revision: number;
  updateQueue: Promise<void>;
}

export interface DesktopApprovalAction {
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly token: string;
}

/**
 * Holds Desktop approval state exclusively in process memory. A stale card
 * from a previous Bridge process or Desktop epoch cannot reach the new owner.
 */
export class DesktopApprovalService {
  private readonly approvalsByToken = new Map<string, PendingApproval>();
  private readonly summariesByTaskId = new Map<string, ApprovalSummary>();
  private readonly summaryCreationsByTaskId = new Map<string, Promise<ApprovalSummary>>();
  private readonly now: () => number;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly desktop: DesktopApprovalClient,
    private readonly cards: ApprovalCardClient,
    private readonly tasks: ApprovalTaskLookup,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  public async present(approval: DesktopApprovalRequest, epoch: number): Promise<void> {
    if (!approval.turnId || epoch !== this.desktop.connectionEpoch) {
      return;
    }
    const context = this.tasks.approvalContext(approval.threadId, approval.turnId);
    if (!context || !this.tasks.setAwaitingApproval(approval.threadId, approval.turnId, true)) {
      return;
    }
    const tokenEntries = approval.availableDecisions.map((decision) => [
      createOpaqueActionToken(),
      decision,
    ] as const);
    const actionTokens = Object.fromEntries(
      tokenEntries.map(([token, decision]) => [decision, token]),
    ) as Partial<Record<ApprovalDecision, string>>;
    const expiresAtMs = this.now() + APPROVAL_TTL_MS;
    const timer = setTimeout(
      () => this.expire(tokenEntries.map(([token]) => token)),
      APPROVAL_TTL_MS,
    );
    timer.unref();
    const pending: PendingApproval = {
      approval,
      epoch,
      chatId: context.chatId,
      cardId: '',
      cardMessageId: '',
      cardSequence: 0,
      tokens: new Map(tokenEntries),
      expiresAtMs,
      timer,
    };
    try {
      if (this.config.approvalCardMode === 'summary') {
        await this.presentInSummary(context, pending);
      } else {
        await this.presentIndividually(context, pending, actionTokens);
      }
      this.registerPending(pending);
    } catch {
      clearTimeout(timer);
      this.tasks.setAwaitingApproval(approval.threadId, approval.turnId, false);
    }
  }

  public async handleAction(action: DesktopApprovalAction): Promise<object> {
    if (!this.config.allowedApprovers.includes(action.operatorOpenId)) {
      return toast('你没有审批权限', 'warning');
    }
    const pending = this.approvalsByToken.get(action.token);
    const decision = pending?.tokens.get(action.token);
    if (
      !pending
      || !decision
      || pending.chatId !== action.chatId
      || pending.cardMessageId !== action.messageId
      || pending.expiresAtMs < this.now()
      || pending.epoch !== this.desktop.connectionEpoch
    ) {
      return toast('审批已失效，请在 ChatGPT 中继续处理或重新发送任务', 'warning');
    }
    this.expire([...pending.tokens.keys()]);
    try {
      await this.desktop.respondToApproval({
        threadId: pending.approval.threadId,
        requestId: pending.approval.requestId,
        kind: pending.approval.kind,
        decision,
      }, () => undefined);
      this.tasks.setAwaitingApproval(
        pending.approval.threadId,
        pending.approval.turnId,
        false,
      );
      try {
        if (pending.summary && pending.summaryEntry) {
          pending.summaryEntry.decision = decision;
          pending.summaryEntry.decidedAtMs = this.now();
          await this.replaceSummaryCard(pending.summary);
        } else {
          pending.cardSequence = await this.cards.replaceCard(
            pending.cardId,
            createApprovalDecisionCard({
              kind: pending.approval.kind,
              operationSummary: sanitizeCardText(
                redactApprovalSecrets(pending.approval.operationSummary),
                { maxLength: 4_000 },
              ),
              reason: sanitizeCardText(pending.approval.reason, { maxLength: 4_000 }),
              cwd: sanitizeCardText(
                this.tasks.approvalContext(
                  pending.approval.threadId,
                  pending.approval.turnId,
                )?.workspaceId ?? 'Unknown',
                { maxLength: 1_000 },
              ),
              decision,
              availableDecisions: pending.approval.availableDecisions,
            }),
            pending.cardSequence,
            `approval:${String(pending.approval.requestId)}:${decision}`,
          );
        }
        return toast('审批结果已提交', 'success');
      } catch {
        return toast('审批结果已提交，但飞书审批卡未能刷新', 'warning');
      }
    } catch {
      try {
        await this.markPendingUnavailable(pending);
      } catch {
        // The task state is still failed below even if its card cannot be patched.
      }
      this.tasks.failForApprovalDelivery(pending.approval.threadId, pending.approval.turnId);
      return toast('审批结果未能确认送达 Desktop，任务已停止跟踪', 'error');
    }
  }

  /** Drops all pending actions on Desktop disconnect or Bridge shutdown. */
  public abandonAll(): void {
    for (const pending of new Set(this.approvalsByToken.values())) {
      clearTimeout(pending.timer);
    }
    this.approvalsByToken.clear();
    this.summariesByTaskId.clear();
    this.summaryCreationsByTaskId.clear();
  }

  private async presentIndividually(
    context: ReturnType<ApprovalTaskLookup['approvalContext']> extends infer Value
      ? Exclude<Value, undefined>
      : never,
    pending: PendingApproval,
    actionTokens: Partial<Record<ApprovalDecision, string>>,
  ): Promise<void> {
    pending.cardId = await this.cards.createCard(createApprovalCard({
      title: sanitizeCardText('Codex 审批请求', { maxLength: 120 }),
      kind: pending.approval.kind,
      operationSummary: sanitizeCardText(redactApprovalSecrets(pending.approval.operationSummary), { maxLength: 4_000 }),
      reason: sanitizeCardText(pending.approval.reason, { maxLength: 4_000 }),
      cwd: sanitizeCardText(context.workspaceId ?? 'Unknown', { maxLength: 1_000 }),
      actionTokens,
      availableDecisions: pending.approval.availableDecisions,
    }));
    pending.cardMessageId = await this.cards.replyCard(
      context.rootMessageId,
      pending.cardId,
      `approval:${context.taskId}:${String(pending.approval.requestId)}`,
    );
  }

  private async presentInSummary(
    context: ReturnType<ApprovalTaskLookup['approvalContext']> extends infer Value
      ? Exclude<Value, undefined>
      : never,
    pending: PendingApproval,
  ): Promise<void> {
    const entry: ApprovalSummaryEntry = {
      pending,
      cwd: context.workspaceId ?? 'Unknown',
    };
    const existing = this.summariesByTaskId.get(context.taskId);
    if (existing) {
      existing.entries.push(entry);
      pending.summary = existing;
      pending.summaryEntry = entry;
      pending.cardId = existing.cardId;
      pending.cardMessageId = existing.cardMessageId;
      try {
        await this.replaceSummaryCard(existing);
      } catch (error) {
        existing.entries.pop();
        throw error;
      }
      return;
    }

    const creating = this.summaryCreationsByTaskId.get(context.taskId);
    if (creating) {
      const summary = await creating;
      summary.entries.push(entry);
      pending.summary = summary;
      pending.summaryEntry = entry;
      pending.cardId = summary.cardId;
      pending.cardMessageId = summary.cardMessageId;
      try {
        await this.replaceSummaryCard(summary);
      } catch (error) {
        summary.entries.pop();
        throw error;
      }
      return;
    }

    const creation = this.createSummary(context, entry);
    this.summaryCreationsByTaskId.set(context.taskId, creation);
    try {
      const summary = await creation;
      pending.summary = summary;
      pending.summaryEntry = entry;
      pending.cardId = summary.cardId;
      pending.cardMessageId = summary.cardMessageId;
    } finally {
      this.summaryCreationsByTaskId.delete(context.taskId);
    }
  }

  private async createSummary(
    context: ReturnType<ApprovalTaskLookup['approvalContext']> extends infer Value
      ? Exclude<Value, undefined>
      : never,
    entry: ApprovalSummaryEntry,
  ): Promise<ApprovalSummary> {
    const provisional = {
      taskId: context.taskId,
      chatId: context.chatId,
      rootMessageId: context.rootMessageId,
      entries: [entry],
      cardSequence: 0,
      revision: 0,
      updateQueue: Promise.resolve(),
    };
    const cardId = await this.cards.createCard(createApprovalSummaryCard({
      entries: this.summaryEntries(provisional.entries),
    }));
    const cardMessageId = await this.cards.replyCard(
      context.rootMessageId,
      cardId,
      `approval-summary:${context.taskId}`,
    );
    const summary: ApprovalSummary = { ...provisional, cardId, cardMessageId };
    this.summariesByTaskId.set(context.taskId, summary);
    return summary;
  }

  private async replaceSummaryCard(summary: ApprovalSummary): Promise<void> {
    const revision = ++summary.revision;
    const update = summary.updateQueue.then(async () => {
      summary.cardSequence = await this.cards.replaceCard(
        summary.cardId,
        createApprovalSummaryCard({ entries: this.summaryEntries(summary.entries) }),
        summary.cardSequence,
        `approval-summary:${summary.taskId}:${revision}`,
      );
    });
    summary.updateQueue = update.catch(() => undefined);
    await update;
  }

  private async markPendingUnavailable(pending: PendingApproval): Promise<void> {
    if (pending.summary && pending.summaryEntry) {
      pending.summaryEntry.unavailable = true;
      await this.replaceSummaryCard(pending.summary);
      return;
    }
    pending.cardSequence = await this.cards.replaceCard(
      pending.cardId,
      createApprovalUnavailableCard({
        title: sanitizeCardText('Codex 审批请求', { maxLength: 120 }),
        kind: pending.approval.kind,
        operationSummary: sanitizeCardText(
          redactApprovalSecrets(pending.approval.operationSummary),
          { maxLength: 4_000 },
        ),
        reason: sanitizeCardText(pending.approval.reason, { maxLength: 4_000 }),
        cwd: sanitizeCardText(
          this.tasks.approvalContext(
            pending.approval.threadId,
            pending.approval.turnId,
          )?.workspaceId ?? 'Unknown',
          { maxLength: 1_000 },
        ),
        actionTokens: {},
        availableDecisions: pending.approval.availableDecisions,
      }),
      pending.cardSequence,
      `approval:${String(pending.approval.requestId)}:unavailable`,
    );
  }

  private summaryEntries(entries: readonly ApprovalSummaryEntry[]) {
    return entries.map((entry) => ({
      kind: entry.pending.approval.kind,
      operationSummary: sanitizeCardText(
        redactApprovalSecrets(entry.pending.approval.operationSummary),
        { maxLength: 4_000 },
      ),
      reason: sanitizeCardText(entry.pending.approval.reason, { maxLength: 4_000 }),
      cwd: sanitizeCardText(entry.cwd, { maxLength: 1_000 }),
      actionTokens: Object.fromEntries(
        [...entry.pending.tokens.entries()].map(([token, decision]) => [decision, token]),
      ),
      availableDecisions: entry.pending.approval.availableDecisions,
      ...(entry.decision ? { decision: entry.decision } : {}),
      ...(entry.decidedAtMs ? { decidedAt: new Date(entry.decidedAtMs) } : {}),
      ...(entry.unavailable ? { unavailable: true } : {}),
    }));
  }

  private registerPending(pending: PendingApproval): void {
    for (const token of pending.tokens.keys()) {
      this.approvalsByToken.set(token, pending);
    }
  }

  private expire(tokens: readonly string[]): void {
    const pending = tokens.map((token) => this.approvalsByToken.get(token)).find(Boolean);
    if (pending) {
      clearTimeout(pending.timer);
    }
    for (const token of tokens) {
      this.approvalsByToken.delete(token);
    }
  }
}
