import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { BindingStore, ChatThreadBinding } from './binding-store';
import {
  createBoundSuccessCard,
  createGoalCard,
  createHelpCard,
  createMcpCard,
  createModelPickerCard,
  createSkillsCard,
  createStatusCard,
  flattenSkills,
  type CommandSelectOption,
} from './cards/command-cards';
import { type CardKitJson } from './cards/layouts';
import type { ThreadNavigation } from './codex/app-navigation-adapter';
import { isPathWithinRoot } from './preflight';
import type { InMemoryOrchestrator } from './in-memory-orchestrator';
import type { BridgeConfig } from './domain';
import type { InboundCardAction } from './lark/event-server';
import { toast } from './lark/event-server';
import type { InboundTextMessage } from './lark/intake';

export interface CommandCatalog {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

export interface CommandCards {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
  replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
}

export interface ShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface ShellCommandRunner {
  run(command: string, arguments_: readonly string[], cwd: string, timeoutMs: number): Promise<ShellCommandResult>;
}

export interface RateLimitReader {
  get(): Promise<unknown>;
}

export interface ModelCatalog {
  list(): Promise<readonly string[]>;
}

interface PendingSelection {
  readonly kind: 'model' | 'skill';
  readonly value: string | null;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly bindingRevision: number;
  readonly expiresAtMs: number;
  readonly cardId?: string;
  readonly messageId?: string;
  readonly skillsData?: unknown;
  readonly skillOptions?: readonly CommandSelectOption[];
  readonly cwd?: string;
  readonly skillPath?: string;
}

interface ActiveSkillCard {
  readonly cardId: string;
  readonly sequence: number;
  readonly skillsData: unknown;
  readonly skillOptions: readonly CommandSelectOption[];
  readonly cwd: string;
}

const COMMAND_DEDUPE_TTL_MS = 10 * 60_000;
const COMMAND_SELECTION_TTL_MS = 10 * 60_000;
const MAX_SHELL_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_SHELL_COMMANDS = Object.freeze(['ls', 'pwd', 'git', 'find', 'cd']);

/** Restores the non-task chat commands without delegating slash commands to the model. */
export class BridgeCommandService {
  private readonly processedEventKeys = new Map<string, number>();
  private readonly inFlightEventKeys = new Map<string, Promise<boolean>>();
  private readonly pendingSelections = new Map<string, PendingSelection>();
  private readonly activeSkillCards = new Map<string, ActiveSkillCard>();
  private readonly exploreCwds = new Map<string, string>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStore,
    private readonly catalog: CommandCatalog,
    private readonly cards: CommandCards,
    private readonly tasks: InMemoryOrchestrator,
    private readonly navigation: ThreadNavigation,
    private readonly shell: ShellCommandRunner = { run: runAllowedShellCommand },
    private readonly rateLimits: RateLimitReader | undefined = undefined,
    private readonly modelCatalog: ModelCatalog = { list: readCachedModels },
  ) {}

  public async handle(message: InboundTextMessage): Promise<boolean> {
    this.pruneProcessedEvents();
    const eventKey = JSON.stringify([message.tenantKey, message.chatId, message.eventId, message.messageId]);
    if (this.processedEventKeys.has(eventKey)) {
      return true;
    }
    const inFlight = this.inFlightEventKeys.get(eventKey);
    if (inFlight) {
      return inFlight;
    }
    const execution = this.handleOnce(message);
    this.inFlightEventKeys.set(eventKey, execution);
    try {
      const handled = await execution;
      if (handled) {
        this.processedEventKeys.set(eventKey, Date.now());
      }
      return handled;
    } finally {
      this.inFlightEventKeys.delete(eventKey);
    }
  }

  /** Applies one scoped, short-lived selection from /model or /skills. */
  public async handleCardAction(action: InboundCardAction): Promise<object> {
    this.prunePendingSelections();
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return toast('你没有修改当前会话设置的权限', 'warning');
    }
    const selection = this.pendingSelections.get(action.token);
    const binding = this.store.get(action.tenantKey, action.chatId);
    if (
      !selection
      || selection.kind !== action.action
      || selection.tenantKey !== action.tenantKey
      || selection.chatId !== action.chatId
      || !binding
      || selection.bindingRevision !== binding.revision
      || selection.expiresAtMs < Date.now()
      || !selection.cardId
      || selection.messageId !== action.messageId
    ) {
      return toast('选择操作无效或已失效，请重新发送指令', 'warning');
    }
    this.pendingSelections.delete(action.token);
    if (selection.kind === 'model') {
      const updated = this.store.bind({ ...binding, model: selection.value ?? undefined });
      await this.cards.replaceCard(
        selection.cardId,
        statusCard(
          '🤖 模型设定',
          `当前会话使用的模型已成功设定为：**${updated.model ?? '默认'}**。\n接下来发送给 Codex 的消息将应用该模型。`,
          'blue',
        ),
        0,
        `model-selected:${action.messageId}:${updated.revision}`,
      );
      return toast(`模型已设置为 ${selection.value ?? '默认'}`, 'success');
    }
    const updated = this.store.bind({
      ...binding,
      activeSkill: selection.value ?? undefined,
      activeSkillPath: selection.value ? selection.skillPath : undefined,
    });
    if (selection.skillsData && selection.skillOptions && selection.cwd) {
      const sequence = await this.cards.replaceCard(
        selection.cardId,
        createSkillsCard(
          selection.skillsData,
          selection.cwd,
          selection.skillOptions,
          updated.activeSkill,
        ),
        0,
        `skill-selected:${action.messageId}:${updated.revision}`,
      );
      const key = selectionKey(action.tenantKey, action.chatId);
      if (updated.activeSkill) {
        this.activeSkillCards.set(key, Object.freeze({
          cardId: selection.cardId,
          sequence,
          skillsData: selection.skillsData,
          skillOptions: selection.skillOptions,
          cwd: selection.cwd,
        }));
      } else {
        this.activeSkillCards.delete(key);
      }
    }
    return toast(selection.value ? `下一条消息将使用技能 ${selection.value}` : '已清除技能选择', 'success');
  }

  /** Consumes the original one-shot skill and resets its picker card to the cleared state. */
  public async consumeActiveSkill(binding: ChatThreadBinding): Promise<void> {
    if (!binding.activeSkill) {
      return;
    }
    this.store.bind({ ...binding, activeSkill: undefined, activeSkillPath: undefined });
    const key = selectionKey(binding.tenantKey, binding.chatId);
    const activeCard = this.activeSkillCards.get(key);
    this.activeSkillCards.delete(key);
    if (!activeCard) {
      return;
    }
    await this.cards.replaceCard(
      activeCard.cardId,
      createSkillsCard(activeCard.skillsData, activeCard.cwd, activeCard.skillOptions),
      activeCard.sequence,
      `skill-consumed:${binding.chatId}:${binding.revision}`,
    );
  }

  private async handleOnce(message: InboundTextMessage): Promise<boolean> {
    const [command, argument] = splitCommand(message.text);
    if (!command) return false;
    if (command === '/help' || command === '/h' || command === 'help' || command === 'h') {
      await this.replyCard(message, createHelpCard(this.allowedShellCommands()), 'help');
      return true;
    }
    if (command === '/status') return this.status(message);
    if (command === '/usage' || command === '/quota') return this.usage(message);
    if (command === '/cancel' || command === '/stop') return this.cancel(message);
    if (command === '/model') return this.model(message, argument);
    if (command === '/personality' || command === '/style') return this.setting(message, 'personality', argument, '🎭 回复风格');
    if (command === '/plan') return this.plan(message, argument);
    if (command === '/cwd' || command === '/workspace') return this.workspace(message, argument);
    if (command === '/new' || command === '/create') return this.create(message, argument);
    if (command === '/fork' || command === '/branch') return this.fork(message, argument);
    if (command === '/delete' || command === '/archive') return this.archive(message);
    if (command === '/goal') return this.goal(message, argument);
    if (command === '/mcp') return this.mcp(message);
    if (command === '/skills') return this.skills(message);
    if (command === '/compact' || command === '/compress') return this.compact(message);
    if (command === '/cmd' || command === '/run' || command === '/shell') return this.shellCommand(message, argument);
    if (
      command === '/bind'
      || command === '/l'
      || command === '/list'
      || command === '/ll'
      || command === '/binding'
      || command === '/unbind'
      || command === '/open'
    ) return false;
    if (command.startsWith('/')) return this.shellCommand(message, `${command.slice(1)} ${argument}`.trim());
    return false;
  }

  private async status(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    let name = '未命名会话';
    let goal: unknown = null;
    try {
      const thread = asRecord(await this.catalog.request<unknown>('thread/read', {
        threadId: binding.threadId,
        includeTurns: false,
      }));
      const nested = asRecord(thread?.thread);
      name = textField(nested?.name) ?? textField(nested?.title) ?? textField(thread?.name) ?? name;
    } catch {
      // The binding remains useful even when the control plane cannot read metadata.
    }
    try {
      goal = await this.catalog.request('thread/goal/get', { threadId: binding.threadId });
    } catch {
      // Goal support is experimental and may be unavailable in a specific runtime.
    }
    await this.replyCard(message, createStatusCard({
      name,
      threadId: binding.threadId,
      cwd: binding.workspaceId,
      personality: binding.personality,
      planMode: binding.plan === 'plan',
      model: binding.model,
      activeSkill: binding.activeSkill,
      goal,
    }), 'status');
    return true;
  }

  private async model(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    if (argument) {
      return this.setting(message, 'model', argument, '🤖 模型');
    }
    let models: readonly string[] = [];
    try {
      models = await this.modelCatalog.list();
    } catch {
      // The direct /model <name> form remains available when the cache cannot be read.
    }
    const options = models.map((model) => ({
      label: model,
      token: this.createSelection('model', model, message, binding),
    }));
    const reference = await this.replyCardWithReference(
      message,
      createModelPickerCard(options),
      'model-picker',
    );
    this.attachSelectionCard(options.map((option) => option.token), reference);
    return true;
  }

  private async usage(message: InboundTextMessage): Promise<boolean> {
    try {
      const response = this.rateLimits
        ? await this.rateLimits.get() as Record<string, unknown>
        : await this.catalog.request<Record<string, unknown>>('account/rateLimits/read', {});
      const content = usageCardText(response);
      await this.reply(message, '📊 账户用量统计', content ?? '当前无法读取账户窗口用量，请稍后重试。', 'usage', content ? 'blue' : 'orange');
    } catch {
      await this.reply(message, '📊 获取用量失败', '当前无法读取账户窗口用量，请稍后重试。', 'usage-failed', 'red');
    }
    return true;
  }

  private async cancel(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const cancelled = await this.tasks.cancelCurrent(message.chatId, binding.threadId);
    await this.reply(
      message,
      cancelled ? '🛑 任务取消指令已发送' : '🛑 无活跃任务',
      cancelled
        ? '已向 Codex 发送取消任务指令，任务正在中断中...'
        : '当前会话没有正在运行的任务，无需取消。',
      'cancel',
      'grey',
    );
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
      if (key === 'personality') {
        const current = binding.personality || 'none (默认)';
        await this.reply(
          message,
          '🎭 回复风格状态',
          `当前会话的回复风格（Personality）为：\n- **${current}**\n\n如需更改，请使用指令：\n- \`/personality friendly\` (或 \`亲和\`)\n- \`/personality pragmatic\` (或 \`务实\`)\n- \`/personality none\` (或 \`默认\`)`,
          'get-personality',
        );
      } else {
        await this.reply(message, title, `当前设置：${binding[key] ?? '默认'}`, `get-${key}`);
      }
      return true;
    }
    const value = settingValue(key, argument);
    if (value === null) {
      await this.reply(message, title, settingHint(key), `set-${key}-invalid`, 'orange');
      return true;
    }
    const updated = this.store.bind({ ...binding, [key]: value });
    if (key === 'model') {
      await this.reply(
        message,
        '🤖 模型设定',
        `当前会话使用的模型已成功设定为：**${updated.model ?? '默认'}**。\n接下来发送给 Codex 的消息将应用该模型。`,
        'set-model',
        'green',
      );
    } else if (key === 'personality') {
      await this.reply(
        message,
        '🎭 回复风格设定',
        `会话回复风格已成功设定为：**${updated.personality ?? 'none'}**。\n接下来 Codex 的回复风格将应用此选项。`,
        'set-personality',
        'green',
      );
    }
    return true;
  }

  private async workspace(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const exploredWorkspace = this.exploreCwds.get(message.chatId);
    const requestedWorkspace = argument || (
      exploredWorkspace && exploredWorkspace !== binding.workspaceId ? exploredWorkspace : ''
    );
    if (!requestedWorkspace) {
      await this.reply(
        message,
        '📁 当前工作目录',
        `当前会话 **${await this.threadName(binding.threadId)}** 的工作目录 (CWD) 为：\n\`${binding.workspaceId}\``,
        'workspace',
      );
      return true;
    }
    try {
      const workspace = realpathSync.native(
        isAbsolute(requestedWorkspace)
          ? requestedWorkspace
          : resolve(binding.workspaceId, requestedWorkspace),
      );
      if (!statSync(workspace).isDirectory()) {
        await this.reply(
          message,
          '🚫 路径绑定失败',
          `路径不是一个目录：\n\`${workspace}\``,
          'workspace-not-directory',
          'red',
        );
        return true;
      }
      if (!this.config.allowedWorkspaceRoots.some((root) => isPathWithinRoot(workspace, root))) {
        await this.reply(
          message,
          '🚫 路径绑定失败',
          `路径不在 Bridge 已授权的工作区范围内：\n\`${workspace}\``,
          'workspace-outside-roots',
          'red',
        );
        return true;
      }
      this.store.bind({ ...binding, workspaceId: workspace });
      this.exploreCwds.set(message.chatId, workspace);
      await this.reply(
        message,
        '📁 工作目录绑定成功',
        `已将当前会话 **${await this.threadName(binding.threadId)}** 的工作目录（CWD）绑定并保存为：\n\`${workspace}\``,
        'workspace-set',
        'green',
      );
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        await this.reply(
          message,
          '🚫 路径绑定失败',
          `路径不存在：\n\`${requestedWorkspace}\``,
          'workspace-missing',
          'red',
        );
      } else if (code === 'EACCES' || code === 'EPERM') {
        await this.reply(
          message,
          '⚠️ 系统权限不足 (Operation not permitted)',
          permissionHelp(requestedWorkspace),
          'workspace-permission',
          'orange',
        );
      } else {
        await this.reply(message, '📁 设置工作目录失败', '无法访问指定的工作目录。', 'workspace-failed', 'red');
      }
    }
    return true;
  }

  private async create(message: InboundTextMessage, name: string): Promise<boolean> {
    try {
      const sessionName = name || defaultSessionName();
      const previous = this.store.get(message.tenantKey, message.chatId);
      const workspaceId = previous?.workspaceId ?? this.config.codexCwd;
      const response = await this.catalog.request<Record<string, unknown>>('thread/start', {
        threadSource: 'user',
        cwd: workspaceId,
      });
      const threadId = threadIdFrom(response);
      if (!threadId) throw new Error('App Server 未返回新会话标识');
      await this.catalog.request('thread/name/set', { threadId, name: sessionName });
      this.store.bind({ tenantKey: message.tenantKey, chatId: message.chatId, threadId,
        workspaceId,
        ...(previous?.model ? { model: previous.model } : {}),
        ...(previous?.personality ? { personality: previous.personality } : {}),
        ...(previous?.plan ? { plan: previous.plan } : {}) });
      await this.tryOpenThread(threadId);
      await this.replyCard(
        message,
        createBoundSuccessCard(sessionName, threadId, workspaceId),
        'new',
      );
    } catch {
      await this.reply(message, '🆕 创建会话失败', '无法创建或打开新会话。', 'new-failed', 'red');
    }
    return true;
  }

  private async fork(message: InboundTextMessage, name: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      const forkName = name || `${await this.threadName(binding.threadId)}_派生`;
      const response = await this.catalog.request<Record<string, unknown>>('thread/fork', {
        threadId: binding.threadId,
        threadSource: 'user',
      });
      const threadId = threadIdFrom(response);
      if (!threadId) throw new Error('App Server 未返回派生会话标识');
      await this.catalog.request('thread/name/set', { threadId, name: forkName });
      this.store.bind({ ...binding, threadId });
      await this.tryOpenThread(threadId);
      await this.reply(
        message,
        '🌱 会话派生成功',
        `已成功以此前的历史派生出新会话！\n\n- 📂 新会话名称: **${forkName}**\n- 🆔 会话 ID: \`${threadId}\`\n\n当前飞书聊天已自动绑定到该新会话。`,
        'fork',
        'green',
      );
    } catch {
      await this.reply(message, '🌱 派生会话失败', '无法派生或打开当前会话。', 'fork-failed', 'red');
    }
    return true;
  }

  private async archive(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const threadName = await this.threadName(binding.threadId);
    try {
      await this.catalog.request('thread/archive', { threadId: binding.threadId });
    } catch {
      // The original product treats App Server archiving as best effort.
    }
    this.store.unbind(message.tenantKey, message.chatId);
    await this.reply(
      message,
      '🗑️ 会话归档解绑成功',
      `已成功将当前聊天与 Codex 会话 **${threadName}** 解绑，并在本地完成归档。`,
      'archive',
      'green',
    );
    return true;
  }

  private async goal(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const clear = argument === 'clear' || argument === '-c' || argument === '--clear';
    try {
      if (!argument) {
        const result = await this.catalog.request('thread/goal/get', { threadId: binding.threadId });
        await this.replyCard(message, createGoalCard(result), 'goal-get');
        return true;
      }
      if (clear) {
        await this.catalog.request('thread/goal/clear', { threadId: binding.threadId });
        await this.reply(
          message,
          '🎯 Codex 目标清除',
          `已成功清除会话 **${await this.threadName(binding.threadId)}** 的当前目标。`,
          'goal-clear',
          'grey',
        );
        return true;
      }
      await this.catalog.request('thread/goal/set', {
        threadId: binding.threadId,
        objective: argument,
        status: 'active',
      });
      await this.tasks.handleInbound({
        ...message,
        eventId: `${message.eventId}:goal`,
        messageId: `${message.messageId}:goal`,
        text: `开始执行目标：${argument}`,
      }, binding);
      if (binding.activeSkill) {
        await this.consumeActiveSkill(binding);
      }
    } catch {
      await this.reply(message, '❌ 处理目标指令失败', '当前 Codex 运行时未完成目标操作。', 'goal-failed', 'red');
    }
    return true;
  }

  private async plan(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const requested = argument ? settingValue('plan', argument) : binding.plan ? undefined : 'plan';
    if (requested === null) {
      await this.reply(message, '📝 计划模式', settingHint('plan'), 'set-plan-invalid', 'orange');
      return true;
    }
    const updated = this.store.bind({ ...binding, plan: requested });
    const enabled = updated.plan === 'plan';
    await this.reply(
      message,
      `📝 计划模式：已${enabled ? '开启 🟢' : '关闭 🔴'}`,
      enabled
        ? '接下来的开发指令将优先生成 implementation_plan 供您审批。'
        : '接下来将直接运行日常对话。',
      'set-plan',
      enabled ? 'green' : 'grey',
    );
    return true;
  }

  private async compact(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      await this.catalog.request('thread/compact/start', { threadId: binding.threadId });
      await this.reply(
        message,
        '⚡️ 上下文压缩',
        '已向 App Server 发起上下文压缩指令。Codex 正在压缩整理当前会话的上下文，这通常在几秒内完成。',
        'compact',
        'blue',
      );
    } catch {
      await this.reply(message, '⚡️ 压缩上下文失败', '当前 Codex 运行时未完成上下文压缩。', 'compact-failed', 'red');
    }
    return true;
  }

  private async shellCommand(message: InboundTextMessage, source: string): Promise<boolean> {
    const arguments_ = parseShellArguments(source);
    const command = arguments_[0]?.toLowerCase();
    if (!command) {
      await this.reply(
        message,
        '⚠️ 缺少指令内容',
        '请提供要执行的命令行指令。\n例如：`/cmd ls -la` 或 `/run git status`。',
        'shell-missing',
        'orange',
      );
      return true;
    }
    if (!this.allowedShellCommands().includes(command)) {
      await this.reply(
        message,
        '⚠️ 安全警示',
        `根据系统安全策略，本地命令 \`${command}\` 不在执行白名单中。\n\n`
          + '如需执行，请联系网桥管理员在 `.env` 配置文件中通过 '
          + '`ALLOWED_SHELL_COMMANDS` 加上该命令名。',
        'shell-denied',
        'orange',
      );
      return true;
    }
    const binding = this.store.get(message.tenantKey, message.chatId);
    const execCwd = this.exploreCwds.get(message.chatId)
      ?? binding?.workspaceId
      ?? this.config.codexCwd
      ?? homedir();
    if (command === 'cd') {
      const requested = arguments_[1] ?? homedir();
      const workspace = isAbsolute(requested) ? requested : resolve(execCwd, requested);
      try {
        const resolvedWorkspace = realpathSync.native(workspace);
        if (!statSync(resolvedWorkspace).isDirectory()) {
          await this.reply(
            message,
            '🚫 切换目录失败',
            `路径不是一个目录：\n\`${resolvedWorkspace}\``,
            'shell-cd-not-directory',
            'red',
          );
          return true;
        }
        this.exploreCwds.set(message.chatId, resolvedWorkspace);
        const note = binding
          ? '\n\n*(注意：当前绑定的会话工作目录未受影响。若要正式应用并保存此目录，请发送 `/cwd`)*'
          : '';
        await this.reply(
          message,
          '📂 探查目录已切换',
          `📂 探查目录已切换为：\n\`${resolvedWorkspace}\`${note}`,
          'shell-cd',
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') {
          await this.reply(message, '🚫 切换目录失败', `路径不存在：\n\`${workspace}\``, 'shell-cd-missing', 'red');
        } else if (code === 'EACCES' || code === 'EPERM') {
          await this.reply(
            message,
            '⚠️ 系统权限不足 (Operation not permitted)',
            permissionHelp(workspace),
            'shell-cd-permission',
            'orange',
          );
        } else {
          await this.reply(message, '🚫 无法访问该目录', '无法访问指定目录。', 'shell-cd-failed', 'red');
        }
      }
      return true;
    }
    const validationError = validateShellArguments(command, arguments_.slice(1), execCwd);
    if (validationError) {
      await this.reply(message, '⚠️ 本地命令参数被拒绝', validationError, 'shell-invalid', 'orange');
      return true;
    }
    try {
      const result = await this.shell.run(command, arguments_.slice(1), execCwd, 15_000);
      const output = shellOutput(result);
      await this.reply(
        message,
        result.exitCode === 0 && !result.timedOut ? '💻 终端命令执行结果' : '⚠️ 终端命令未成功完成',
        `**工作目录 (CWD)**: \`${execCwd}\`\n\n\`\`\`text\n${output}\n\`\`\``,
        'shell-result',
        result.exitCode === 0 && !result.timedOut ? 'blue' : 'orange',
      );
    } catch {
      await this.reply(message, '💻 执行命令失败', 'Bridge 无法启动该命令。', 'shell-failed', 'red');
    }
    return true;
  }

  private async mcp(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      const result = await this.catalog.request('mcpServerStatus/list', { threadId: binding.threadId });
      await this.replyCard(message, createMcpCard(result), 'mcp');
    } catch {
      await this.reply(message, '🔌 获取 MCP 状态失败', '当前 Codex 运行时未返回 MCP 状态。', 'mcp-failed', 'red');
    }
    return true;
  }

  private async skills(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      const result = await this.catalog.request('skills/list', { cwds: [binding.workspaceId] });
      const skills = flattenSkills(result);
      const options: CommandSelectOption[] = [{
        label: '❌ 清除选中技能',
        token: this.createSelection('skill', null, message, binding),
      }];
      for (const skill of skills) {
        const scope = skill.scope === 'local' ? '📁 本地' : '⚙️ 内置';
        options.push({
          label: `[${scope}] ${skill.name}`,
          token: this.createSelection('skill', skill.name, message, binding, skill.path),
        });
      }
      const reference = await this.replyCardWithReference(
        message,
        createSkillsCard(result, binding.workspaceId, options, binding.activeSkill),
        'skills',
      );
      this.attachSelectionCard(
        options.map((option) => option.token),
        reference,
        { skillsData: result, skillOptions: options, cwd: binding.workspaceId },
      );
    } catch {
      await this.reply(message, '✨ 获取可用技能失败', '当前 Codex 运行时未返回技能列表。', 'skills-failed', 'red');
    }
    return true;
  }

  private binding(message: InboundTextMessage): ChatThreadBinding | undefined {
    const binding = this.store.get(message.tenantKey, message.chatId);
    if (!binding) {
      void this.reply(
        message,
        '⚠️ 未绑定会话',
        '当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。',
        'unbound',
        'orange',
      );
    }
    return binding;
  }

  private allowedShellCommands(): readonly string[] {
    return this.config.allowedShellCommands ?? DEFAULT_SHELL_COMMANDS;
  }

  private async tryOpenThread(threadId: string): Promise<boolean> {
    try {
      await this.navigation.openThread(threadId);
      return true;
    } catch {
      return false;
    }
  }

  private async threadName(threadId: string): Promise<string> {
    try {
      const response = asRecord(await this.catalog.request<unknown>('thread/read', {
        threadId,
        includeTurns: false,
      }));
      const thread = asRecord(response?.thread) ?? response;
      return textField(thread?.name) ?? textField(thread?.title) ?? '派生会话';
    } catch {
      return '派生会话';
    }
  }

  private createSelection(
    kind: PendingSelection['kind'],
    value: string | null,
    message: InboundTextMessage,
    binding: ChatThreadBinding,
    skillPath?: string,
  ): string {
    const token = randomUUID().replaceAll('-', '');
    this.pendingSelections.set(token, Object.freeze({
      kind,
      value,
      tenantKey: message.tenantKey,
      chatId: message.chatId,
      bindingRevision: binding.revision,
      expiresAtMs: Date.now() + COMMAND_SELECTION_TTL_MS,
      ...(skillPath ? { skillPath } : {}),
    }));
    return token;
  }

  private attachSelectionCard(
    tokens: readonly string[],
    reference: { readonly cardId: string; readonly messageId: string },
    context: Pick<PendingSelection, 'skillsData' | 'skillOptions' | 'cwd'> = {},
  ): void {
    for (const token of tokens) {
      const selection = this.pendingSelections.get(token);
      if (selection) {
        this.pendingSelections.set(token, Object.freeze({ ...selection, ...reference, ...context }));
      }
    }
  }

  private prunePendingSelections(): void {
    const now = Date.now();
    for (const [token, selection] of this.pendingSelections) {
      if (selection.expiresAtMs < now) {
        this.pendingSelections.delete(token);
      }
    }
  }

  private pruneProcessedEvents(): void {
    const cutoff = Date.now() - COMMAND_DEDUPE_TTL_MS;
    for (const [key, receivedAtMs] of this.processedEventKeys) {
      if (receivedAtMs < cutoff) {
        this.processedEventKeys.delete(key);
      }
    }
  }

  private async reply(message: InboundTextMessage, title: string, content: string, operation: string, template = 'indigo'): Promise<void> {
    await this.replyCard(message, statusCard(title, content, template), operation);
  }

  private async replyCard(message: InboundTextMessage, card: CardKitJson, operation: string): Promise<void> {
    await this.replyCardWithReference(message, card, operation);
  }

  private async replyCardWithReference(
    message: InboundTextMessage,
    card: CardKitJson,
    operation: string,
  ): Promise<{ readonly cardId: string; readonly messageId: string }> {
    const cardId = await this.cards.createCard(card);
    const messageId = await this.cards.replyCard(
      message.rootMessageId,
      cardId,
      `command:${message.eventId}:${operation}`,
    );
    return { cardId, messageId };
  }
}

function splitCommand(text: string): readonly [string | null, string] {
  const trimmed = text.trim();
  if (!trimmed) return [null, ''];
  const index = trimmed.search(/\s/);
  return index === -1 ? [trimmed.toLowerCase(), ''] : [trimmed.slice(0, index).toLowerCase(), trimmed.slice(index).trim()];
}

function parseShellArguments(source: string): readonly string[] {
  return Object.freeze(source.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => {
    const quoted = (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1) : part;
  }) ?? []);
}

function settingValue(key: 'model' | 'personality' | 'plan', input: string): string | undefined | null {
  const normalized = input.trim();
  if (key === 'model') {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized) ? normalized : null;
  }
  const value = normalized.toLowerCase();
  if (key === 'personality') {
    if (value === 'friendly' || normalized === '亲和') return 'friendly';
    if (value === 'pragmatic' || normalized === '务实') return 'pragmatic';
    if (value === 'none' || normalized === '默认') return undefined;
    return null;
  }
  if (value === 'on' || value === 'true' || normalized === '开启' || value === 'plan') return 'plan';
  if (value === 'off' || value === 'false' || normalized === '关闭' || value === 'none') return undefined;
  return null;
}

function settingHint(key: 'model' | 'personality' | 'plan'): string {
  if (key === 'model') return '模型名称只能包含字母、数字、点、下划线或连字符。';
  if (key === 'personality') return '可用值：friendly（亲和）、pragmatic（务实）、none（默认）。';
  return '可用值：on（开启）或 off（关闭）。';
}

function usageCardText(value: Record<string, unknown>): string | null {
  const nested = asRecord(value.rateLimitsByLimitId);
  const limits = asRecord(nested?.codex) ?? asRecord(value.rateLimits);
  if (!limits) return null;
  const lines: string[] = [];
  const planType = textField(limits.planType);
  if (planType) lines.push(`账户类型：${planType.toUpperCase()}`);
  const weekly = usageLimitText('7d 窗口', weeklyRateLimit(limits));
  if (weekly) lines.push(weekly);
  const credits = asRecord(limits.credits);
  if (credits?.hasCredits === true && (typeof credits.balance === 'string' || typeof credits.balance === 'number')) {
    lines.push(`点数余额：${String(credits.balance)}`);
  }
  return lines.length > 0 ? lines.join('\n\n') : null;
}

/** Resolves the weekly quota across the pre- and post-5h Desktop payloads. */
function weeklyRateLimit(limits: Record<string, unknown>): Record<string, unknown> | null {
  const primary = asRecord(limits.primary);
  const secondary = asRecord(limits.secondary);
  const candidates = [primary, secondary].filter((limit): limit is Record<string, unknown> => limit !== null);
  const weekly = candidates.find((limit) => (
    typeof limit.windowDurationMins === 'number'
      && Number.isFinite(limit.windowDurationMins)
      && limit.windowDurationMins >= 6 * 24 * 60
  ));
  return weekly ?? secondary ?? primary;
}

function usageLimitText(label: string, limit: Record<string, unknown> | null): string | null {
  if (!limit || typeof limit.usedPercent !== 'number') return null;
  const minutes = typeof limit.windowDurationMins === 'number' ? limit.windowDurationMins : null;
  const window = minutes && minutes > 0 ? `（${Math.round(minutes / 60)}h）` : '';
  const reset = typeof limit.resetsAt === 'number' ? `\n重置时间：${formatResetAt(limit.resetsAt)}` : '';
  return `${label}${window}：已用 ${limit.usedPercent}%${reset}`;
}

function formatResetAt(timestamp: number): string {
  const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Date(milliseconds).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validateShellArguments(command: string, arguments_: readonly string[], cwd: string): string | null {
  if (command === 'pwd') return arguments_.length === 0 ? null : 'pwd 不接受参数。';
  if (command === 'ls') return validateLsArguments(arguments_, cwd);
  if (command === 'git') return validateGitArguments(arguments_, cwd);
  if (command === 'find') return validateFindArguments(arguments_, cwd);
  return null;
}

function validateLsArguments(arguments_: readonly string[], cwd: string): string | null {
  const allowedFlags = new Set(['-1', '-a', '-A', '-l', '-la', '-al', '-h', '-lah', '-lha', '--all', '--almost-all', '--long']);
  for (const argument of arguments_) {
    if (argument.startsWith('-')) {
      if (!allowedFlags.has(argument)) return `ls 参数 ${argument} 未获授权。`;
      continue;
    }
    const error = validateWorkspacePath(argument, cwd);
    if (error) return error;
  }
  return null;
}

function validateGitArguments(arguments_: readonly string[], cwd: string): string | null {
  const subcommand = arguments_[0];
  const allowedSubcommands = new Set(['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'remote', 'ls-files']);
  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    return 'git 仅支持 status、diff、log、branch、show、rev-parse、remote 和 ls-files。';
  }
  if (subcommand === 'branch') {
    return arguments_.slice(1).every((argument) => new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--show-current']).has(argument))
      ? null
      : 'git branch 仅支持列出分支；不支持创建、删除或重命名。';
  }
  if (subcommand === 'remote') {
    return arguments_.length === 1 || (arguments_.length === 2 && arguments_[1] === '-v')
      ? null
      : 'git remote 仅支持查看远程仓库；不支持修改远程地址。';
  }
  const forbidden = new Set(['-c', '-C', '--config-env', '--exec-path', '--output', '--textconv', '--ext-diff', '--no-index']);
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      forbidden.has(argument)
      || argument.startsWith('--output=')
      || argument.startsWith('--config-env=')
      || argument.startsWith('--exec-path=')
      || /^-[cC].+/.test(argument)
    ) {
      return `git 参数 ${argument} 未获授权。`;
    }
    if (argument === '--') {
      for (const path of arguments_.slice(index + 1)) {
        const error = validateWorkspacePath(path, cwd);
        if (error) return error;
      }
      return null;
    }
  }
  return null;
}

function validateFindArguments(arguments_: readonly string[], cwd: string): string | null {
  let index = 0;
  if (arguments_[0] && !arguments_[0]!.startsWith('-')) {
    const error = validateWorkspacePath(arguments_[0]!, cwd);
    if (error) return error;
    index = 1;
  }
  while (index < arguments_.length) {
    const option = arguments_[index++];
    const value = arguments_[index++];
    if (!option || value === undefined) return 'find 参数必须使用受支持的“选项 值”形式。';
    if ((option === '-maxdepth' || option === '-mindepth') && /^\d+$/.test(value)) continue;
    if (option === '-type' && /^[fdl]$/.test(value)) continue;
    if ((option === '-name' || option === '-iname') && !value.includes('/') && !value.includes('\0')) continue;
    return 'find 仅支持 -maxdepth、-mindepth、-type、-name 和 -iname；不支持执行、删除或写文件动作。';
  }
  return null;
}

function validateWorkspacePath(value: string, cwd: string): string | null {
  if (!value || value.includes('\0')) return '路径无效。';
  const resolved = resolve(cwd, value);
  if (!isPathWithinRoot(resolved, cwd)) return '路径必须位于当前绑定工作目录内。';
  try {
    if (!isPathWithinRoot(realpathSync.native(resolved), cwd)) {
      return '路径不能通过符号链接离开当前绑定工作目录。';
    }
  } catch {
    // A nonexistent path cannot escape after lexical containment; the command will report it normally.
  }
  return null;
}

async function runAllowedShellCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ShellCommandResult> {
  return new Promise<ShellCommandResult>((resolveResult, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const finish = (result: ShellCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const terminate = (): void => {
      terminateProcessTree(child.pid, 'SIGTERM');
      const forceKill = setTimeout(() => terminateProcessTree(child.pid, 'SIGKILL'), 1_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (outputExceeded) return;
      const next = target === 'stdout' ? stdout + chunk : stderr + chunk;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_SHELL_OUTPUT_BYTES) {
        outputExceeded = true;
        timedOut = true;
        terminate();
        return;
      }
      if (target === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once('close', (exitCode) => finish({
      stdout: outputExceeded ? `${stdout}\n[输出超过限制，命令已终止]` : stdout,
      stderr,
      exitCode,
      timedOut,
    }));
  });
}

function shellOutput(result: ShellCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n[stderr]\n' : '');
  const status = result.timedOut ? '\n[命令执行超时，已终止]' : result.exitCode === 0 ? '' : `\n[退出码：${result.exitCode ?? '未知'}]`;
  const combined = `${output || '(命令执行成功，但无任何控制台输出)'}${status}`;
  return combined.length > 3_000
    ? `${combined.slice(0, 3_000)}\n\n... (由于长度超限已截断) ...`
    : combined;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function permissionHelp(path: string): string {
  return `网桥程序无权访问该目录：\n\`${path}\`\n\n**建议解决办法**：\n`
    + '1. 将项目移出 `Documents` / `Desktop` 等系统受限文件夹，移至例如 `~/work/` 下。\n'
    + '2. 或者前往 macOS `系统设置 -> 隐私与安全性 -> 完全磁盘访问权限`，'
    + '为您的终端应用或 node 启用读取权限。';
}

function terminateProcessTree(processId: number | undefined, signal: NodeJS.Signals): void {
  if (!processId) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-processId, signal);
      return;
    }
    process.kill(processId, signal);
  } catch {
    // The child may have exited between the timeout and cancellation attempt.
  }
}

function threadIdFrom(value: Record<string, unknown>): string | null {
  const thread = value.thread;
  const id = thread && typeof thread === 'object' ? (thread as Record<string, unknown>).id : value.threadId;
  return typeof id === 'string' && id.trim() ? id : null;
}

function defaultSessionName(now = new Date()): string {
  const part = (value: number): string => String(value).padStart(2, '0');
  return `飞书会话_${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())} ${part(now.getHours())}:${part(now.getMinutes())}`;
}

function selectionKey(tenantKey: string, chatId: string): string {
  return `${tenantKey.length}:${tenantKey}${chatId.length}:${chatId}`;
}

async function readCachedModels(): Promise<readonly string[]> {
  const source = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
  const parsed = JSON.parse(source) as unknown;
  const models = asRecord(parsed)?.models;
  if (!Array.isArray(models)) return Object.freeze([]);
  const slugs = models.flatMap((candidate) => {
    const slug = textField(asRecord(candidate)?.slug);
    return slug ? [slug] : [];
  });
  return Object.freeze([...new Set(slugs)]);
}

function statusCard(title: string, content: string, template: string): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content },
      }],
    },
  };
}
