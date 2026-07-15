import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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

const COMMAND_DEDUPE_TTL_MS = 10 * 60_000;
const MAX_SHELL_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_SHELL_COMMANDS = Object.freeze(['ls', 'pwd', 'git', 'find', 'cd']);

/** Restores the non-task chat commands without delegating slash commands to the model. */
export class BridgeCommandService {
  private readonly processedEventKeys = new Map<string, number>();
  private readonly inFlightEventKeys = new Map<string, Promise<boolean>>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStore,
    private readonly catalog: CommandCatalog,
    private readonly cards: CommandCards,
    private readonly tasks: InMemoryOrchestrator,
    private readonly navigation: ThreadNavigation,
    private readonly shell: ShellCommandRunner = { run: runAllowedShellCommand },
    private readonly rateLimits: RateLimitReader | undefined = undefined,
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

  private async handleOnce(message: InboundTextMessage): Promise<boolean> {
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
    if (command === '/plan') return this.plan(message, argument);
    if (command === '/cwd' || command === '/workspace') return this.workspace(message, argument);
    if (command === '/new' || command === '/create') return this.create(message, argument);
    if (command === '/fork' || command === '/branch') return this.fork(message, argument);
    if (command === '/delete' || command === '/archive') return this.archive(message);
    if (command === '/goal') return this.goal(message, argument);
    if (command === '/mcp') return this.inspect(message, 'mcpServerStatus/list', '🔌 MCP 状态');
    if (command === '/skills') return this.inspect(message, 'skills/list', '✨ 可用技能');
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
    await this.reply(message, '📊 当前会话状态', [
      `会话标识：${binding.threadId}`, `工作区：${binding.workspaceId}`,
      `模型：${binding.model ?? '默认'}`, `回复风格：${binding.personality ?? '默认'}`,
      `计划模式：${binding.plan ?? '关闭'}`,
    ].join('\n'), 'status');
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
    const value = settingValue(key, argument);
    if (value === null) {
      await this.reply(message, title, settingHint(key), `set-${key}-invalid`, 'orange');
      return true;
    }
    const updated = this.store.bind({ ...binding, [key]: value });
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
      const workspace = realpathSync.native(
        isAbsolute(argument) ? argument : resolve(binding.workspaceId, argument),
      );
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
      const opened = await this.tryOpenThread(threadId);
      await this.reply(
        message,
        opened ? '🆕 已创建并绑定会话' : '🆕 已创建并绑定会话（未打开）',
        opened ? (name || '未命名会话') : `${name || '未命名会话'}\n已完成绑定，可发送 \`/open\` 重试打开。`,
        'new',
        opened ? 'green' : 'orange',
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
      const response = await this.catalog.request<Record<string, unknown>>('thread/fork', { threadId: binding.threadId });
      const threadId = threadIdFrom(response);
      if (!threadId) throw new Error('App Server 未返回派生会话标识');
      if (name) await this.catalog.request('thread/name/set', { threadId, name });
      this.store.bind({ ...binding, threadId });
      const opened = await this.tryOpenThread(threadId);
      await this.reply(
        message,
        opened ? '🌱 已派生并绑定会话' : '🌱 已派生并绑定会话（未打开）',
        opened ? (name || '派生会话') : `${name || '派生会话'}\n已完成绑定，可发送 \`/open\` 重试打开。`,
        'fork',
        opened ? 'green' : 'orange',
      );
    } catch {
      await this.reply(message, '🌱 派生会话失败', '无法派生或打开当前会话。', 'fork-failed', 'red');
    }
    return true;
  }

  private async archive(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    try {
      await this.catalog.request('thread/archive', { threadId: binding.threadId });
      this.store.unbind(message.tenantKey, message.chatId);
      await this.reply(message, '🗑️ 会话已归档解绑', '当前飞书聊天已解除绑定。', 'archive', 'green');
    } catch {
      await this.reply(message, '🗑️ 会话归档失败', '绑定未变更，请稍后重试。', 'archive-failed', 'red');
    }
    return true;
  }

  private async goal(message: InboundTextMessage, argument: string): Promise<boolean> {
    const binding = this.binding(message);
    if (!binding) return true;
    const clear = argument === 'clear' || argument === '-c' || argument === '--clear';
    const method = !argument ? 'thread/goal/get' : clear ? 'thread/goal/clear' : 'thread/goal/set';
    const params = !argument ? { threadId: binding.threadId } : clear
      ? { threadId: binding.threadId } : { threadId: binding.threadId, objective: argument, status: 'active' };
    return this.rpcCard(message, method, params, '🎯 目标模式', 'goal');
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
      enabled ? '之后的任务会优先生成实施计划。' : '之后的任务会按常规模式执行。',
      'set-plan',
      enabled ? 'green' : 'grey',
    );
    return true;
  }

  private async compact(message: InboundTextMessage): Promise<boolean> {
    const binding = this.binding(message);
    return binding ? this.rpcCard(message, 'thread/compact/start', { threadId: binding.threadId }, '🗜️ 上下文压缩', 'compact') : true;
  }

  private async shellCommand(message: InboundTextMessage, source: string): Promise<boolean> {
    const arguments_ = parseShellArguments(source);
    const command = arguments_[0]?.toLowerCase();
    if (!command) {
      await this.reply(message, '⚠️ 缺少指令内容', '请提供要执行的命令，例如：`/cmd git status`。', 'shell-missing', 'orange');
      return true;
    }
    if (!this.allowedShellCommands().includes(command)) {
      await this.reply(
        message,
        '⚠️ 本地命令未获授权',
        `\`${command}\` 不在命令白名单中。可在私有 \`.env\` 中设置 \`ALLOWED_SHELL_COMMANDS\` 后重启 Bridge。`,
        'shell-denied',
        'orange',
      );
      return true;
    }
    const binding = this.binding(message);
    if (!binding) return true;
    if (command === 'cd') {
      const requested = arguments_[1] ?? binding.workspaceId;
      const workspace = isAbsolute(requested) ? requested : resolve(binding.workspaceId, requested);
      return this.workspace(message, workspace);
    }
    const validationError = validateShellArguments(command, arguments_.slice(1), binding.workspaceId);
    if (validationError) {
      await this.reply(message, '⚠️ 本地命令参数被拒绝', validationError, 'shell-invalid', 'orange');
      return true;
    }
    try {
      const result = await this.shell.run(command, arguments_.slice(1), binding.workspaceId, 15_000);
      const output = shellOutput(result);
      await this.reply(
        message,
        result.exitCode === 0 && !result.timedOut ? '💻 终端命令执行结果' : '⚠️ 终端命令未成功完成',
        `工作目录：\`${binding.workspaceId}\`\n\n\`\`\`text\n${output}\n\`\`\``,
        'shell-result',
        result.exitCode === 0 && !result.timedOut ? 'blue' : 'orange',
      );
    } catch {
      await this.reply(message, '💻 执行命令失败', 'Bridge 无法启动该命令。', 'shell-failed', 'red');
    }
    return true;
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

  private pruneProcessedEvents(): void {
    const cutoff = Date.now() - COMMAND_DEDUPE_TTL_MS;
    for (const [key, receivedAtMs] of this.processedEventKeys) {
      if (receivedAtMs < cutoff) {
        this.processedEventKeys.delete(key);
      }
    }
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
  const combined = `${output || '(命令执行成功，但没有输出)'}${status}`;
  return combined.length > 3_000 ? `${combined.slice(0, 3_000)}\n…（输出已截断）` : combined;
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

function statusCard(title: string, content: string, template: string): CardKitJson {
  return { schema: '2.0', config: { wide_screen_mode: true }, header: { template,
    title: { tag: 'plain_text', content: sanitizeCardText(title, { maxLength: 120 }) } },
  body: { elements: [{ tag: 'markdown', content: sanitizeCardText(content, { maxLength: 10_000 }) }] } };
}

function helpText(): string {
  return '/bind、/l、/list 或 /ll：选择会话\n/open：打开绑定会话\n/status：查看绑定状态\n/usage 或 /quota：账户用量\n/model、/personality、/plan：查看或设置\n/cwd：查看或切换工作目录\n/new、/fork、/archive：会话管理\n/goal、/compact、/mcp、/skills：Codex 控制\n/cmd：执行受限本地只读命令\n/cancel 或 /stop：停止当前任务';
}
