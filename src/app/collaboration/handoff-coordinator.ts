import type { ChatThreadBinding } from '../binding-store';
import type { LarkBotConfig } from '../bot-config-store';
import type {
  ExternalBotDirectoryEntry,
  ExternalBotDirectoryResolution,
} from '../external-bot-directory';
import type { HandoffMessageEmitter } from '../lark/handoff-message-emitter';
import {
  createRootHandoffEnvelope,
  parseHandoffDirective,
  type HandoffDirective,
  type HandoffEnvelope,
} from './handoff-directive';
import { HandoffChainStore, type HandoffChainBlockReason } from './handoff-chain-store';

export interface TerminalHandoffContext {
  readonly sourceBotKey: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly finalAnswer: string;
  readonly binding: ChatThreadBinding;
}

export interface TerminalHandoffProjection {
  readonly finalAnswer: string;
  readonly emitted: boolean;
}

export interface RunnerReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface HandoffCoordinatorOptions {
  readonly now?: () => number;
  readonly bots: () => readonly LarkBotConfig[];
  readonly bindingFor: (tenantKey: string, chatId: string, botKey: string) => ChatThreadBinding | undefined;
  readonly emitterForSourceBot: (botKey: string) => HandoffMessageEmitter | undefined;
  readonly externalBotDirectoryForGroup?: (
    sourceBotKey: string,
    tenantKey: string,
    chatId: string,
    selector: string,
  ) => ExternalBotDirectoryResolution;
  readonly runnerReadinessForBinding?: (binding: ChatThreadBinding) => RunnerReadiness;
  readonly chainStore?: HandoffChainStore;
}

export class HandoffCoordinator {
  private readonly now: () => number;
  private readonly chainStore: HandoffChainStore;

  public constructor(private readonly options: HandoffCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.chainStore = options.chainStore ?? new HandoffChainStore({ now: this.now });
  }

  public async handleTerminalHandoff(
    context: TerminalHandoffContext,
  ): Promise<TerminalHandoffProjection | null> {
    const parsed = parseHandoffDirective(context.finalAnswer);
    if (!parsed) {
      return null;
    }
    const sourceBot = this.options.bots().find((bot) => bot.botKey === context.sourceBotKey);
    const target = resolveTargetBot(parsed.directive.target, this.options.bots());
    if (!target) {
      return this.handleExternalTargetHandoff(context, parsed.visibleText, parsed.directive);
    }
    if (!sourceBot?.enabled) {
      return failure(parsed.visibleText, '当前源机器人不可用，已阻止自动交接');
    }
    if (!target.enabled) {
      return failure(parsed.visibleText, `目标机器人 ${target.displayName ?? target.botKey} 已禁用`);
    }
    if (!target.botOpenId) {
      return failure(parsed.visibleText, `目标机器人 ${target.displayName ?? target.botKey} 缺少 open_id`);
    }
    const targetBinding = this.options.bindingFor(context.tenantKey, context.chatId, target.botKey);
    if (!targetBinding) {
      return failure(parsed.visibleText, `目标机器人 ${target.displayName ?? target.botKey} 尚未绑定当前群`);
    }
    if (!target.allowGroupBotMentions) {
      return failure(parsed.visibleText, `目标机器人 ${target.displayName ?? target.botKey} 已关闭群机器人 @ 响应`);
    }
    const runner = this.options.runnerReadinessForBinding?.(targetBinding) ?? { ready: true };
    if (!runner.ready) {
      return failure(
        parsed.visibleText,
        `目标机器人 ${target.displayName ?? target.botKey} 的执行路由未就绪：${runner.reason ?? 'unknown'}`,
      );
    }
    const envelope = this.createEnvelope(context, target.botKey);
    const chainDecision = this.chainStore.reserveOutbound(envelope, target.botKey);
    if (!chainDecision.accepted) {
      return failure(parsed.visibleText, chainFailureText(chainDecision.reason, target.displayName ?? target.botKey));
    }
    const emitter = this.options.emitterForSourceBot(context.sourceBotKey);
    if (!emitter) {
      return failure(parsed.visibleText, '源机器人缺少飞书发送通道');
    }
    try {
      await emitter.send({
        chatId: context.chatId,
        targetBotKey: target.botKey,
        targetBotOpenId: target.botOpenId,
        targetBotName: target.displayName ?? target.botKey,
        envelope,
        directive: parsed.directive,
      });
    } catch {
      return failure(parsed.visibleText, `交接消息发送失败：${target.displayName ?? target.botKey}`);
    }
    return {
      emitted: true,
      finalAnswer: appendNote(parsed.visibleText, `已交接给 ${target.displayName ?? target.botKey}`),
    };
  }

  private async handleExternalTargetHandoff(
    context: TerminalHandoffContext,
    visibleText: string,
    directive: HandoffDirective,
  ): Promise<TerminalHandoffProjection> {
    const sourceBot = this.options.bots().find((bot) => bot.botKey === context.sourceBotKey);
    if (!sourceBot?.enabled) {
      return failure(visibleText, '当前源机器人不可用，已阻止自动交接');
    }
    const externalResolution = this.options.externalBotDirectoryForGroup?.(
      context.sourceBotKey,
      context.tenantKey,
      context.chatId,
      directive.target,
    ) ?? { status: 'not_found' as const };
    if (externalResolution.status === 'not_found') {
      return failure(visibleText, `未找到目标机器人：${directive.target}`);
    }
    if (externalResolution.status === 'ambiguous') {
      return failure(visibleText, ambiguousExternalBotText(directive.target, externalResolution.matches));
    }
    const externalTarget = externalResolution.entry;
    const emitter = this.options.emitterForSourceBot(context.sourceBotKey);
    if (!emitter) {
      return failure(visibleText, '源机器人缺少飞书发送通道');
    }
    const targetKey = externalTargetKey(externalTarget);
    const envelope = this.createEnvelope(context, targetKey);
    const chainDecision = this.chainStore.reserveOutbound(envelope, targetKey);
    if (!chainDecision.accepted) {
      return failure(visibleText, chainFailureText(chainDecision.reason, externalTarget.displayName));
    }
    try {
      await emitter.send({
        chatId: context.chatId,
        targetBotKey: targetKey,
        targetBotOpenId: externalTarget.botOpenId,
        targetBotName: externalTarget.displayName,
        envelope,
        directive,
      });
    } catch {
      return failure(visibleText, `交接消息发送失败：${externalTarget.displayName}`);
    }
    return {
      emitted: true,
      finalAnswer: appendNote(visibleText, `已交接给 ${externalTarget.displayName}`),
    };
  }

  public snapshot() {
    return this.chainStore.snapshot();
  }

  private createEnvelope(context: TerminalHandoffContext, targetBotKey: string): HandoffEnvelope {
    const seed = [
      context.sourceBotKey,
      targetBotKey,
      context.chatId,
      context.messageId,
      context.finalAnswer,
    ].join('\0');
    return createRootHandoffEnvelope(
      context.sourceBotKey,
      this.now(),
      this.chainStore.ttlMs(),
      seed,
    );
  }
}

function resolveTargetBot(selector: string, bots: readonly LarkBotConfig[]): LarkBotConfig | undefined {
  const normalized = selector.trim().toLowerCase();
  const matches = bots.filter((bot) => (
    bot.botKey.toLowerCase() === normalized
    || bot.displayName?.toLowerCase() === normalized
    || bot.botOpenId?.toLowerCase() === normalized
    || (!!bot.botOpenId && bot.botOpenId.toLowerCase().endsWith(normalized))
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function externalTargetKey(target: ExternalBotDirectoryEntry): string {
  return `external:${target.botOpenId}`;
}

function ambiguousExternalBotText(
  selector: string,
  matches: readonly ExternalBotDirectoryEntry[],
): string {
  const suffixes = matches
    .slice(0, 3)
    .map((entry) => `${entry.displayName}(${entry.botOpenId.slice(-6)})`)
    .join(', ');
  return `目标机器人不唯一：${selector}；请改用 open_id。候选：${suffixes}`;
}

function failure(visibleText: string, reason: string): TerminalHandoffProjection {
  return {
    emitted: false,
    finalAnswer: appendNote(visibleText, `自动交接未执行：${reason}`),
  };
}

function appendNote(text: string, note: string): string {
  const prefix = text.trim() || '任务已完成。';
  return `${prefix}\n\n${note}`;
}

function chainFailureText(reason: HandoffChainBlockReason, target: string): string {
  if (reason === 'expired') {
    return `交接链路已过期，未调用 ${target}`;
  }
  if (reason === 'duplicate') {
    return `重复交接已忽略，未再次调用 ${target}`;
  }
  if (reason === 'max_hops') {
    return `交接跳数已达上限，未调用 ${target}`;
  }
  return `交接限流中，未调用 ${target}`;
}
