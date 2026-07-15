import { createOpaqueActionToken } from './action-tokens';
import type { CardKitJson } from './cards/layouts';
import { createApprovalCard, createApprovalDecisionCard } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import type {
  DesktopApprovalRequest,
} from './codex/desktop-approval-adapter';
import type { DesktopIpcClient } from './codex/desktop-ipc-client';
import type { ApprovalDecision, BridgeConfig } from './domain';
import { toast } from './lark/event-server';

const APPROVAL_TTL_MS = 10 * 60_000;

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
  } | undefined;
  setAwaitingApproval(threadId: string, turnId: string | null, waiting: boolean): boolean;
  failForApprovalDelivery(threadId: string, turnId: string | null): void;
}

interface PendingApproval {
  readonly approval: DesktopApprovalRequest;
  readonly epoch: number;
  readonly chatId: string;
  readonly cardId: string;
  readonly cardMessageId: string;
  cardSequence: number;
  readonly tokens: ReadonlyMap<string, ApprovalDecision>;
  readonly expiresAtMs: number;
  readonly timer: NodeJS.Timeout;
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
  private readonly now: () => number;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly desktop: DesktopIpcClient,
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
    try {
      const cardId = await this.cards.createCard(createApprovalCard({
        title: sanitizeCardText('Codex 审批请求', { maxLength: 120 }),
        kind: approval.kind,
        operationSummary: sanitizeCardText(approval.operationSummary, { maxLength: 4_000 }),
        reason: sanitizeCardText(approval.reason, { maxLength: 4_000 }),
        actionTokens,
      }));
      const cardMessageId = await this.cards.replyCard(
        context.rootMessageId,
        cardId,
        `approval:${context.taskId}:${String(approval.requestId)}`,
      );
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
        cardId,
        cardMessageId,
        cardSequence: 0,
        tokens: new Map(tokenEntries),
        expiresAtMs,
        timer,
      };
      for (const [token] of tokenEntries) {
        this.approvalsByToken.set(token, pending);
      }
    } catch {
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
        pending.cardSequence = await this.cards.replaceCard(
          pending.cardId,
          createApprovalDecisionCard({
            kind: pending.approval.kind,
            operationSummary: sanitizeCardText(pending.approval.operationSummary, { maxLength: 4_000 }),
            reason: sanitizeCardText(pending.approval.reason, { maxLength: 4_000 }),
            decision,
            availableDecisions: pending.approval.availableDecisions,
          }),
          pending.cardSequence,
          `approval:${String(pending.approval.requestId)}:${decision}`,
        );
        return toast('审批结果已提交', 'success');
      } catch {
        return toast('审批结果已提交，但飞书审批卡未能刷新', 'warning');
      }
    } catch {
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
