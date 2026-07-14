import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { BindingStore, ChatThreadBinding } from './binding-store';
import { type CardKitJson } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import type { ThreadNavigation } from './codex/app-navigation-adapter';
import { isPathWithinRoot } from './preflight';
import type { InMemoryOrchestrator } from './in-memory-orchestrator';
import type { BridgeConfig } from './domain';
import type { InboundTextMessage } from './lark/intake';

export interface CommandCatalog {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

export interface CommandCards {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
}

/** Restores the non-task chat commands without delegating slash commands to the model. */
export class BridgeCommandService {
  public constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStore,
    private readonly catalog: CommandCatalog,
    private readonly cards: CommandCards,
    private readonly tasks: InMemoryOrchestrator,
    private readonly navigation: ThreadNavigation,
  ) {}

  public async handle(message: InboundTextMessage): Promise<boolean> {
    const [command, argument] = splitCommand(message.text);
    if (!command) return false;
    if (command === '/help' || command === '/h' || command === 'help' || command === 'h') {
      await this.reply(message, '💡 Codex 飞书助手指令指南', helpText(), 'help');
      return true;
    }
    if (command === '/status') return this.status(message);
    if (command === '/usage' || command === '/quota') return this.usage(message);
    if (command === '/cancel' || command === '/stop') return this.cancel(message);
    if (command === '/model') return this.setting(message, 'model', argument, '🤖 模型');
    if (command === '/personality' || command === '/style') return this.setting(message, 'personality', argument, '🎭 回复风格');
    if (command === '/plan') return this.setting(message, 'plan', argument, '📝 计划模式');
    if (command === '/cwd' || command === '/workspace') return this.workspace(message, argument);
    if (command === '/new' || command === '/create') return this.create(message, argument);
    if (command === '/fork' || command === '/branch') return this.fork(message, argument);
    if (command === '/delete' || command === '/archive') return this.archive(message);
    if (command === '/goal') return this.goal(message, argument);
    if (command === '/mcp') return this.inspect(message, 'mcpServerStatus/list', '🔌 MCP 状态');
    if (command === '/skills') return this.inspect(message, 'skills/list', '✨ 可用技能');
    if (command === '/compact' || command === '/compress') return this.compact(message);
    return false;
  }

  private async status(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    await this.reply(message, '📊 当前会话状态', [
      `会话标识：${binding.threadId}`, `工作区：${binding.workspaceId}`,
      `模型：${binding.model ?? '默认'}`, `回复风格：${binding.personality ?? '默认'}`,
      `计划模式：${binding.plan ?? '关闭'}`,
    ].join('\n'), 'status');
    return true;
  }

  private async usage(message: InboundTextMessage): Promise<boolean> {
    try {
      const response = await this.catalog.request<Record<string, unknown>>('account/rateLimits/read', {});
      await this.reply(message, '📊 账户用量统计', JSON.stringify(response), 'usage');
    } catch {
      await this.reply(message, '📊 获取用量失败', '当前无法读取账户窗口用量，请稍后重试。', 'usage-failed', 'red');
    }
    return true;
  }

  private async cancel(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const cancelled = await this.tasks.cancelCurrent(message.chatId, binding.threadId);
    await this.reply(message, cancelled ? '🛑 已请求取消任务' : '⚠️ 没有运行中的任务', cancelled
      ? '当前绑定会话的运行中任务已请求停止。'
      : '当前绑定会话没有可取消的运行中任务。', 'cancel', cancelled ? 'grey' : 'orange');
    return true;
  }

  private async setting(
    message: InboundTextMessage,
    key: 'model' | 'personality' | 'plan',
    argument: string,
    title: string,
  ): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    if (!argument) {
      await this.reply(message, title, `当前设置：${binding[key] ?? '默认'}`, `get-${key}`);
      return true;
    }
    const updated = this.store.bind({ ...binding, [key]: argument });
    await this.reply(message, title, `已保存为：${updated[key] ?? '默认'}\n设置将用于之后的新 turn。`, `set-${key}`, 'green');
    return true;
  }

  private async workspace(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    if (!argument) {
      await this.reply(message, '📁 工作目录', binding.workspaceId, 'workspace');
      return true;
    }
    try {
      if (!isAbsolute(argument)) throw new Error('工作目录必须是绝对路径');
      const workspace = realpathSync.native(argument);
      if (!statSync(workspace).isDirectory() || !this.config.allowedWorkspaceRoots.some((root) => isPathWithinRoot(workspace, root))) {
        throw new Error('工作目录必须位于已授权工作区内');
      }
      this.store.bind({ ...binding, workspaceId: workspace });
      await this.reply(message, '📁 工作目录已更新', workspace, 'workspace-set', 'green');
    } catch (error) {
      await this.reply(message, '📁 工作目录未更新', error instanceof Error ? error.message : '路径不可用', 'workspace-failed', 'red');
    }
    return true;
  }

  private async create(message: InboundTextMessage, name: string): Promise<boolean> {
    try {
      const response = await this.catalog.request<Record<string, unknown>>('thread/start', {});
      const threadId = threadIdFrom(response);
      if (!threadId) throw new Error('App Server 未返回新会话标识');
      if (name) await this.catalog.request('thread/name/set', { threadId, name });
      const previous = this.store.get(message.tenantKey, message.chatId);
      this.store.bind({ tenantKey: message.tenantKey, chatId: message.chatId, threadId,
        workspaceId: previous?.workspaceId ?? this.config.codexCwd,
        ...(previous?.model ? { model: previous.model } : {}),
        ...(previous?.personality ? { personality: previous.personality } : {}),
        ...(previous?.plan ? { plan: previous.plan } : {}) });
      await this.navigation.openThread(threadId);
      await this.reply(message, '🆕 已创建并绑定会话', name || '未命名会话', 'new', 'green');
    } catch {
      await this.reply(message, '🆕 创建会话失败', '无法创建或打开新会话。', 'new-failed', 'red');
    }
    return true;
  }

  private async fork(message: InboundTextMessage, name: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      const response = await this.catalog.request<Record<string, unknown>>('thread/fork', { threadId: binding.threadId });
      const threadId = threadIdFrom(response);
      if (!threadId) throw new Error('App Server 未返回派生会话标识');
      if (name) await this.catalog.request('thread/name/set', { threadId, name });
      this.store.bind({ ...binding, threadId });
      await this.navigation.openThread(threadId);
      await this.reply(message, '🌱 已派生并绑定会话', name || '派生会话', 'fork', 'green');
    } catch {
      await this.reply(message, '🌱 派生会话失败', '无法派生或打开当前会话。', 'fork-failed', 'red');
    }
    return true;
  }

  private async archive(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try { await this.catalog.request('thread/archive', { threadId: binding.threadId }); } catch { /* unbind still succeeds */ }
    this.store.unbind(message.tenantKey, message.chatId);
    await this.reply(message, '🗑️ 会话已归档解绑', '当前飞书聊天已解除绑定。', 'archive', 'green');
    return true;
  }

  private async goal(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const method = !argument ? 'thread/goal/get' : argument === 'clear' ? 'thread/goal/clear' : 'thread/goal/set';
    const params = !argument ? { threadId: binding.threadId } : argument === 'clear'
      ? { threadId: binding.threadId } : { threadId: binding.threadId, objective: argument, status: 'active' };
    return this.rpcCard(message, method, params, '🎯 目标模式', 'goal');
  }

  private async compact(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    return binding ? this.rpcCard(message, 'thread/compact/start', { threadId: binding.threadId }, '🗜️ 上下文压缩', 'compact') : true;
  }

  private async inspect(message: InboundTextMessage, method: string, title: string): Promise<boolean> {
    const binding = this.binding(message);
    return binding ? this.rpcCard(message, method, { threadId: binding.threadId, cwds: [binding.workspaceId] }, title, method) : true;
  }

  private async rpcCard(message: InboundTextMessage, method: string, params: unknown, title: string, operation: string): Promise<boolean> {
    try { await this.reply(message, title, JSON.stringify(await this.catalog.request(method, params)), operation, 'green'); }
    catch { await this.reply(message, title, '当前 Codex 运行时不支持或未完成该操作。', `${operation}-failed`, 'orange'); }
    return true;
  }

  private binding(message: InboundTextMessage): ChatThreadBinding | undefined {
    const binding = this.store.get(message.tenantKey, message.chatId);
    if (!binding) void this.reply(message, '⚠️ 未绑定会话', '请先发送 `/bind` 或 `/l` 选择会话。', 'unbound', 'orange');
    return binding;
  }

  private async reply(message: InboundTextMessage, title: string, content: string, operation: string, template = 'indigo'): Promise<void> {
    const cardId = await this.cards.createCard(statusCard(title, content, template));
    await this.cards.replyCard(message.rootMessageId, cardId, `command:${message.eventId}:${operation}`);
  }
}

function splitCommand(text: string): readonly [string | null, string] {
  const trimmed = text.trim();
  if (!trimmed) return [null, ''];
  const index = trimmed.search(/\s/);
  return index === -1 ? [trimmed.toLowerCase(), ''] : [trimmed.slice(0, index).toLowerCase(), trimmed.slice(index).trim()];
}

function threadIdFrom(value: Record<string, unknown>): string | null {
  const thread = value.thread;
  const id = thread && typeof thread === 'object' ? (thread as Record<string, unknown>).id : value.threadId;
  return typeof id === 'string' && id.trim() ? id : null;
}

function statusCard(title: string, content: string, template: string): CardKitJson {
  return { schema: '2.0', config: { wide_screen_mode: true }, header: { template,
    title: { tag: 'plain_text', content: sanitizeCardText(title, { maxLength: 120 }) } },
  body: { elements: [{ tag: 'markdown', content: sanitizeCardText(content, { maxLength: 10_000 }) }] } };
}

function helpText(): string {
  return '/bind、/l、/list 或 /ll：选择会话\n/open：打开绑定会话\n/status：查看绑定状态\n/usage 或 /quota：账户用量\n/model、/personality、/plan：查看或设置\n/cwd：查看或切换工作目录\n/new、/fork、/archive：会话管理\n/goal、/compact、/mcp、/skills：Codex 控制\n/cancel 或 /stop：停止当前任务';
}
