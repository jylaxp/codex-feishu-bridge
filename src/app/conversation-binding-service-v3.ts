import { createHmac, timingSafeEqual } from 'node:crypto';

import { type BindingStore, type ChatThreadBinding } from './binding-store';
import type { CardKitJson } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import type { BridgeConfig } from './domain';
import type { InboundTextMessage } from './lark/intake';
import { toast } from './lark/event-server';

const PICKER_LIMIT = 8;
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
  ) {}

  public getBinding(tenantKey: string, chatId: string): ChatThreadBinding | undefined {
    return this.store.get(tenantKey, chatId);
  }

  public async handleCommand(message: InboundTextMessage): Promise<boolean> {
    if (message.text === '/bind') {
      await this.sendPicker(message);
      return true;
    }
    if (message.text === '/binding') {
      await this.sendStatus(message);
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
    return toast('绑定成功', 'success');
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
    await this.reply(message, statusCard(this.getBinding(message.tenantKey, message.chatId)), 'status');
  }

  private async reply(message: InboundTextMessage, card: CardKitJson, operation: string): Promise<void> {
    const cardId = await this.cards.createCard(card);
    await this.cards.replyCard(message.rootMessageId, cardId, `binding:${message.eventId}:${operation}`);
  }
}

function pickerCard(entries: readonly { readonly choice: ThreadChoice; readonly token: string }[]): CardKitJson {
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: '请选择要绑定的 ChatGPT 会话。选择卡 10 分钟内有效。',
  }, { tag: 'hr' }];
  for (const [index, entry] of entries.entries()) {
    elements.push({
      tag: 'markdown',
      content: `**${index + 1}. ${sanitizeCardText(entry.choice.title, { maxLength: 80 })}**\n`
        + `更新时间：${formatUpdatedAt(entry.choice.updatedAt)}\n`
        + `会话标识：${shortId(entry.choice.id)}`,
    }, {
      tag: 'button',
      type: 'primary',
      width: 'fill',
      text: { tag: 'plain_text', content: '绑定此会话' },
      value: { action: 'binding', token: entry.token },
    }, { tag: 'hr' });
  }
  if (entries.length === 0) {
    elements.push({ tag: 'markdown', content: '没有可绑定的最近会话。请先在 ChatGPT 中创建会话后重试。' });
  }
  return baseCard('选择 ChatGPT 会话', 'blue', elements);
}

function statusCard(binding: ChatThreadBinding | undefined): CardKitJson {
  if (!binding) {
    return baseCard('ChatGPT 会话绑定', 'orange', [{
      tag: 'markdown',
      content: '当前飞书会话尚未绑定 ChatGPT 会话。发送 `/bind` 进行选择。',
    }]);
  }
  return baseCard('ChatGPT 会话绑定', 'green', [{
    tag: 'markdown',
    content: `当前已绑定会话：${shortId(binding.threadId)}\n工作区：${binding.workspaceId}`,
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
      updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : null,
    }];
  });
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

function formatUpdatedAt(value: number | null): string {
  return value === null ? '未知' : new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}
