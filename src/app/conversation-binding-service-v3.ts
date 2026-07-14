import { createHmac, timingSafeEqual } from 'node:crypto';

import { type BindingStore, type ChatThreadBinding } from './binding-store';
import type { CardKitJson } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import { type ThreadNavigation } from './codex/app-navigation-adapter';
import type { BridgeConfig } from './domain';
import type { InboundTextMessage } from './lark/intake';
import { toast } from './lark/event-server';

const PICKER_LIMIT = 99;
const TOKEN_TTL_MS = 10 * 60_000;

export interface BindingCatalogV3 {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

export interface BindingCardsV3 {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
}

export interface BindingActionV3 {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly token: string;
}

interface ThreadChoice {
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly updatedAt: number | null;
}

/** Stateless command surface backed only by BindingStore. */
export class ConversationBindingServiceV3 {
  public constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStore,
    private readonly catalog: BindingCatalogV3,
    private readonly cards: BindingCardsV3,
    private readonly now: () => number = Date.now,
    private readonly navigation: ThreadNavigation | undefined = undefined,
  ) {}

  public getBinding(tenantKey: string, chatId: string): ChatThreadBinding | undefined {
    return this.store.get(tenantKey, chatId);
  }

  public async handleCommand(message: InboundTextMessage): Promise<boolean> {
    const command = message.text.trim();
    if (command === '/bind' || command === '/l' || command === '/list') {
      await this.sendPicker(message);
      return true;
    }
    if (message.text === '/binding') {
      await this.sendStatus(message);
      return true;
    }
    if (command === '/open') {
      await this.openBoundThread(message);
      return true;
    }
    if (message.text === '/unbind') {
      const removed = this.store.unbind(message.tenantKey, message.chatId);
      await this.reply(message, unboundCard(removed), 'unbind');
      return true;
    }
    return false;
  }

  public async ensureBoundOrPrompt(message: InboundTextMessage): Promise<boolean> {
    if (this.getBinding(message.tenantKey, message.chatId)) {
      return true;
    }
    await this.sendPicker(message);
    return false;
  }

  public async handleCardAction(action: BindingActionV3): Promise<object> {
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return toast('你没有绑定权限', 'warning');
    }
    const payload = verifyToken(action.token, action, this.config.larkAppSecret, this.now);
    if (!payload) {
      return toast('会话选择已过期、作用域不匹配或无效，请重新 /bind', 'warning');
    }
    const revision = this.getBinding(action.tenantKey, action.chatId)?.revision ?? 0;
    if (payload.revision !== revision) {
      return toast('选择卡已过期，请重新 /bind', 'warning');
    }
    try {
      await this.catalog.request('thread/read', { threadId: payload.threadId, includeTurns: false });
    } catch {
      return toast('所选会话不存在或暂时不可用，请重新 /bind', 'warning');
    }
    this.store.bind({
      tenantKey: action.tenantKey,
      chatId: action.chatId,
      threadId: payload.threadId,
      workspaceId: this.config.codexCwd,
    });
    return this.openAfterBinding(payload.threadId);
  }

  public async handleOpenAction(action: BindingActionV3): Promise<object> {
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return toast('你没有打开会话的权限', 'warning');
    }
    const payload = verifyToken(action.token, action, this.config.larkAppSecret, this.now);
    const binding = this.getBinding(action.tenantKey, action.chatId);
    if (!payload || !binding || payload.threadId !== binding.threadId || payload.revision !== binding.revision) {
      return toast('会话打开操作已过期，请重新发送 /binding', 'warning');
    }
    return this.openThread(binding.threadId);
  }

  private async sendPicker(message: InboundTextMessage): Promise<void> {
    const response = await this.catalog.request<unknown>('thread/list', {
      limit: PICKER_LIMIT,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    const choices = parseChoices(response);
    const revision = this.getBinding(message.tenantKey, message.chatId)?.revision ?? 0;
    const entries = choices.map((choice) => ({
      choice,
      token: createToken(choice.id, revision, message, this.config.larkAppSecret, this.now),
    }));
    await this.reply(message, pickerCard(entries), 'picker');
  }

  private async sendStatus(message: InboundTextMessage): Promise<void> {
    const binding = this.getBinding(message.tenantKey, message.chatId);
    const token = binding
      ? createToken(binding.threadId, binding.revision, message, this.config.larkAppSecret, this.now)
      : undefined;
    await this.reply(message, statusCard(binding, token), 'status');
  }

  private async openBoundThread(message: InboundTextMessage): Promise<void> {
    const binding = this.getBinding(message.tenantKey, message.chatId);
    if (!binding) {
      await this.sendStatus(message);
      return;
    }
    const result = await this.openThread(binding.threadId);
    await this.reply(message, openResultCard(result), 'open');
  }

  private async openAfterBinding(threadId: string): Promise<object> {
    const result = await this.openThread(threadId);
    return result.type === 'success'
      ? toast('绑定成功，已打开对应 ChatGPT 会话', 'success')
      : toast('绑定成功；未能自动打开 ChatGPT 会话，可发送 /open 重试', 'warning');
  }

  private async openThread(threadId: string): Promise<{ readonly type: 'success' | 'warning' }> {
    if (!this.navigation) {
      return { type: 'warning' };
    }
    try {
      await this.navigation.openThread(threadId);
      return { type: 'success' };
    } catch {
      return { type: 'warning' };
    }
  }

  private async reply(message: InboundTextMessage, card: CardKitJson, operation: string): Promise<void> {
    const cardId = await this.cards.createCard(card);
    await this.cards.replyCard(message.rootMessageId, cardId, `binding:${message.eventId}:${operation}`);
  }
}

function pickerCard(entries: readonly { readonly choice: ThreadChoice; readonly token: string }[]): CardKitJson {
  const options = entries.map((entry) => ({
    text: {
      tag: 'plain_text',
      content: pickerOptionLabel(entry.choice),
    },
    value: entry.token,
  }));
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: '📂 Codex 绑定会话' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '请从下方下拉菜单中选择一个 Codex 活跃会话绑定至当前聊天。选项已按本地项目分组：',
          },
        },
        {
          tag: 'select_static',
          element_id: 'bind_select_dropdown',
          placeholder: { tag: 'plain_text', content: '选择 Codex 会话...' },
          value: { action: 'binding' },
          options,
        },
      ],
    },
  };
}

function statusCard(binding: ChatThreadBinding | undefined, token: string | undefined): CardKitJson {
  if (!binding) {
    return baseCard('ChatGPT 会话绑定', 'orange', [{
      tag: 'markdown',
      content: '当前飞书会话尚未绑定 ChatGPT 会话。发送 `/bind` 进行选择。',
    }]);
  }
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: `当前已绑定会话：${shortId(binding.threadId)}\n工作区：${binding.workspaceId}`,
  }];
  if (token) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '在 ChatGPT 中打开此会话' },
      type: 'primary',
      value: { action: 'open', token },
    });
  }
  return baseCard('ChatGPT 会话绑定', 'green', elements);
}

function openResultCard(result: { readonly type: 'success' | 'warning' }): CardKitJson {
  return baseCard('ChatGPT 会话', result.type === 'success' ? 'green' : 'orange', [{
    tag: 'markdown',
    content: result.type === 'success'
      ? '已请求在 ChatGPT Desktop 中打开当前绑定会话。'
      : '当前未能打开 ChatGPT Desktop 会话；绑定未受影响，可稍后再次发送 `/open`。',
  }]);
}

function unboundCard(removed: boolean): CardKitJson {
  return baseCard('ChatGPT 会话绑定', 'orange', [{
    tag: 'markdown',
    content: removed ? '已解除当前飞书会话的 ChatGPT 绑定。' : '当前飞书会话没有可解除的绑定。',
  }]);
}

function baseCard(
  title: string,
  template: string,
  elements: readonly Record<string, unknown>[],
): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { elements },
  };
}

function parseChoices(value: unknown): readonly ThreadChoice[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.data)) {
    return [];
  }
  return record.data.slice(0, PICKER_LIMIT).flatMap((candidate) => {
    const item = asRecord(candidate);
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || id.length > 512) {
      return [];
    }
    return [{
      id,
      title: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '未命名会话',
      cwd: typeof item?.cwd === 'string' && item.cwd.trim() ? item.cwd : null,
      updatedAt: normalizeUpdatedAt(item?.updatedAt),
    }];
  });
}

function pickerOptionLabel(choice: ThreadChoice): string {
  const name = sanitizeCardText(choice.title, { maxLength: 80 });
  const workspace = choice.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const label = workspace ? `💬 ${name} (📁 ${workspace})` : `💬 ${name}`;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

function normalizeUpdatedAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function createToken(
  threadId: string,
  revision: number,
  message: InboundTextMessage,
  secret: string,
  now: () => number,
): string {
  const payload = Buffer.from(JSON.stringify({
    threadId,
    revision,
    tenantKey: message.tenantKey,
    chatId: message.chatId,
    messageId: message.messageId,
    expiresAtMs: now() + TOKEN_TTL_MS,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(
  token: string,
  action: BindingActionV3,
  secret: string,
  now: () => number,
): { readonly threadId: string; readonly revision: number } | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!secureEquals(expected, signature)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.threadId !== 'string'
      || typeof parsed.revision !== 'number'
      || typeof parsed.tenantKey !== 'string'
      || typeof parsed.chatId !== 'string'
      || typeof parsed.messageId !== 'string'
      || typeof parsed.expiresAtMs !== 'number'
      || parsed.tenantKey !== action.tenantKey
      || parsed.chatId !== action.chatId
      || parsed.expiresAtMs < now()
    ) {
      return null;
    }
    return { threadId: parsed.threadId, revision: parsed.revision };
  } catch {
    return null;
  }
}

function secureEquals(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}
