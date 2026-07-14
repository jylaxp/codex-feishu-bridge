import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { CardKitJson } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import { BridgeDatabase } from './db/database';
import {
  BridgeRepositories,
  ChatThreadBindingRecord,
  ThreadBindingRecord,
} from './db/repositories';
import { BridgeConfig } from './domain';
import { InboundTextMessage } from './lark/intake';
import { toast } from './lark/event-server';
import { isPathWithinRoot } from './preflight';

const BINDING_TOKEN_VERSION = 'b1';
const BINDING_TOKEN_TTL_MS = 10 * 60_000;
const MAX_BINDING_TOKEN_LENGTH = 256;
const MAX_THREAD_ID_BYTES = 128;
const MAX_CANDIDATES = 8;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Minimal request interface used to query the official App Server thread catalog. */
export interface ConversationBindingCatalog {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

/** CardKit operations required to send binding and status cards. */
export interface ConversationBindingCardClient {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
}

/** Normalized CardKit callback for one explicit conversation-selection button. */
export interface BindingCardAction {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly action: 'binding';
  readonly token: string;
}

/** Optional deterministic clock used by token-expiry and repository tests. */
export interface ConversationBindingServiceOptions {
  readonly now?: () => number;
}

/** Safe, bounded metadata rendered for one App Server thread. */
interface ThreadCandidate {
  readonly id: string;
  readonly title: string;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly updatedAt: number | null;
}

/** Authenticated callback payload reconstructed from a binding token. */
interface VerifiedBindingToken {
  readonly threadId: string;
  readonly expectedRevision: number;
  readonly expiresAtMs: number;
}

type TokenVerification =
  | { readonly disposition: 'valid'; readonly payload: VerifiedBindingToken }
  | { readonly disposition: 'expired' }
  | { readonly disposition: 'invalid' };

/** Implements explicit, authenticated Lark-chat to ChatGPT-thread selection. */
export class ConversationBindingService {
  private readonly now: () => number;

  /** Creates a binding service without performing database, network, or CardKit IO. */
  public constructor(
    private readonly database: BridgeDatabase,
    private readonly config: BridgeConfig,
    private readonly catalog: ConversationBindingCatalog,
    private readonly cards: ConversationBindingCardClient,
    options: ConversationBindingServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Handles only the exact binding commands and leaves every other message untouched. */
  public async handleCommand(message: InboundTextMessage): Promise<boolean> {
    switch (message.text) {
      case '/bind':
        await this.replyWithPicker(message);
        return true;
      case '/binding':
        await this.replyWithCurrentBinding(message);
        return true;
      case '/unbind':
        await this.unbindAndReply(message);
        return true;
      default:
        return false;
    }
  }

  /** Returns whether one tenant-scoped Lark chat has an explicit thread selection. */
  public hasBinding(tenantKey: string, chatId: string): boolean {
    return new BridgeRepositories(this.database).chatThreadBindings.get(
      tenantKey,
      chatId,
    ) !== undefined;
  }

  /** Stops unbound normal messages after sending a thread picker to their source message. */
  public async ensureBoundOrPrompt(message: InboundTextMessage): Promise<boolean> {
    if (this.hasBinding(message.tenantKey, message.chatId)) {
      return true;
    }
    await this.replyWithPicker(message);
    return false;
  }

  /** Validates one picker action and atomically replaces the chat's selected thread. */
  public async handleCardAction(action: BindingCardAction): Promise<unknown> {
    if (
      action.action !== 'binding'
      || !this.config.authorizedUsers.includes(action.operatorOpenId)
    ) {
      return toast('你没有绑定权限', 'warning');
    }

    const verification = verifyBindingToken(
      action.token,
      action,
      this.config.larkAppSecret,
      this.now(),
    );
    if (verification.disposition === 'expired') {
      return toast('会话选择已过期，请重新 /bind', 'warning');
    }
    if (verification.disposition === 'invalid') {
      return toast('会话选择作用域不匹配或无效', 'warning');
    }
    const payload = verification.payload;

    if (!this.bindingRevisionMatches(action, payload.expectedRevision)) {
      return toast('选择卡已过期，请重新 /bind', 'warning');
    }

    let thread: ThreadCandidate;
    try {
      const response = await this.catalog.request<unknown>('thread/read', {
        threadId: payload.threadId,
        includeTurns: false,
      });
      thread = requireReadThread(
        response,
        payload.threadId,
        this.config.allowedWorkspaceRoots,
      );
    } catch {
      return toast('所选会话不存在或暂时不可用，请重新 /bind', 'warning');
    }

    const updated = this.replaceBindingIfUnchanged(
      action,
      thread,
      payload.expectedRevision,
    );
    if (!updated) {
      return toast('选择卡已过期，请重新 /bind', 'warning');
    }
    return toast(`绑定成功：${safeToastTitle(thread.title)}`, 'success');
  }

  private async replyWithPicker(message: InboundTextMessage): Promise<void> {
    const response = await this.catalog.request<unknown>('thread/list', {
      limit: MAX_CANDIDATES,
      cwd: this.config.codexCwd,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    const candidates = parseThreadCandidates(response, this.config.allowedWorkspaceRoots);
    const expectedRevision = new BridgeRepositories(this.database).chatThreadBindings.getRevision(
      message.tenantKey,
      message.chatId,
    );
    const selectable = candidates.flatMap((candidate) => {
      const token = createBindingToken(
        candidate.id,
        expectedRevision,
        message,
        this.config.larkAppSecret,
        this.now(),
      );
      return token ? [{ candidate, token }] : [];
    });
    await this.replyCard(
      message,
      createPickerCard(selectable),
      'picker',
    );
  }

  private async replyWithCurrentBinding(message: InboundTextMessage): Promise<void> {
    const repositories = new BridgeRepositories(this.database);
    const binding = repositories.chatThreadBindings.get(
      message.tenantKey,
      message.chatId,
    );
    const rootBinding = repositories.threadBindings.findByLarkRoot(
      message.tenantKey,
      message.chatId,
      message.rootMessageId,
    );
    await this.replyCard(
      message,
      createBindingStatusCard(binding, rootBinding),
      'status',
    );
  }

  private async unbindAndReply(message: InboundTextMessage): Promise<void> {
    const removed = this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const inbox = repositories.inbox.record({
        tenantKey: message.tenantKey,
        eventId: message.eventId,
        messageId: message.messageId,
        chatId: message.chatId,
        rootMessageId: message.rootMessageId,
        senderOpenId: message.senderOpenId,
        payloadDigest: message.payloadDigest,
        payloadText: message.text,
        receivedAtMs: this.now(),
      });
      if (!inbox.created) {
        return inbox.record.errorCode === 'CHAT_BINDING_REMOVED';
      }
      const didRemove = repositories.chatThreadBindings.delete(
        message.tenantKey,
        message.chatId,
        this.now(),
      );
      if (!repositories.inbox.transition(
        inbox.record.id,
        'RECEIVED',
        'PROCESSED',
        this.now(),
        didRemove ? 'CHAT_BINDING_REMOVED' : 'CHAT_BINDING_ABSENT',
      )) {
        throw new Error('Unbind command could not enter PROCESSED state');
      }
      return didRemove;
    });
    await this.replyCard(
      message,
      createUnboundCard(removed),
      'unbind',
    );
  }

  private async replyCard(
    message: InboundTextMessage,
    card: CardKitJson,
    operation: string,
  ): Promise<void> {
    const cardId = await this.cards.createCard(card);
    await this.cards.replyCard(
      message.rootMessageId,
      cardId,
      `binding:${message.eventId}:${operation}`,
    );
  }

  private bindingRevisionMatches(
    action: BindingCardAction,
    expectedRevision: number,
  ): boolean {
    const revision = new BridgeRepositories(this.database).chatThreadBindings.getRevision(
      action.tenantKey,
      action.chatId,
    );
    return revision === expectedRevision;
  }

  private replaceBindingIfUnchanged(
    action: BindingCardAction,
    thread: ThreadCandidate,
    expectedRevision: number,
  ): boolean {
    return this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const revision = repositories.chatThreadBindings.getRevision(
        action.tenantKey,
        action.chatId,
      );
      if (revision !== expectedRevision) {
        return false;
      }
      repositories.chatThreadBindings.upsert({
        tenantKey: action.tenantKey,
        chatId: action.chatId,
        threadId: thread.id,
        workspacePath: thread.workspacePath,
        boundByOpenId: action.operatorOpenId,
        threadTitle: thread.title,
        nowMs: this.now(),
      });
      return true;
    });
  }
}

function parseThreadCandidates(
  response: unknown,
  allowedWorkspaceRoots: readonly string[],
): readonly ThreadCandidate[] {
  const record = asRecord(response);
  if (!Array.isArray(record?.data)) {
    throw new TypeError('App Server thread/list returned invalid data');
  }
  return record.data.slice(0, MAX_CANDIDATES).flatMap((value) => {
    const thread = parseThread(value, allowedWorkspaceRoots);
    return thread ? [thread] : [];
  });
}

function requireReadThread(
  response: unknown,
  expectedThreadId: string,
  allowedWorkspaceRoots: readonly string[],
): ThreadCandidate {
  const record = asRecord(response);
  const thread = parseThread(record?.thread, allowedWorkspaceRoots);
  if (!thread || thread.id !== expectedThreadId) {
    throw new TypeError('App Server thread/read returned a different thread');
  }
  return thread;
}

function parseThread(
  value: unknown,
  allowedWorkspaceRoots: readonly string[],
): ThreadCandidate | null {
  const record = asRecord(value);
  const id = nonBlankString(record?.id);
  if (
    !id
    || !THREAD_ID_PATTERN.test(id)
    || Buffer.byteLength(id, 'utf8') > MAX_THREAD_ID_BYTES
  ) {
    return null;
  }
  const title = nonBlankString(record?.name)
    ?? nonBlankString(record?.title)
    ?? '未命名会话';
  const workspacePath = canonicalAllowedWorkspace(
    nonBlankString(record?.cwd),
    allowedWorkspaceRoots,
  );
  if (!workspacePath) {
    return null;
  }
  const workspaceName = workspaceBasename(workspacePath);
  const updatedAtValue = record?.updatedAt;
  const updatedAt = typeof updatedAtValue === 'number' && Number.isFinite(updatedAtValue)
    && updatedAtValue >= 0
    ? updatedAtValue
    : null;
  return { id, title, workspacePath, workspaceName, updatedAt };
}

function canonicalAllowedWorkspace(
  cwd: string | null,
  allowedWorkspaceRoots: readonly string[],
): string | null {
  if (!cwd || !isAbsolute(cwd)) {
    return null;
  }
  try {
    const canonicalPath = realpathSync.native(cwd);
    if (!statSync(canonicalPath).isDirectory()) {
      return null;
    }
    return allowedWorkspaceRoots.some((root) => isPathWithinRoot(canonicalPath, root))
      ? canonicalPath
      : null;
  } catch {
    return null;
  }
}

function workspaceBasename(cwd: string): string {
  const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? '未知工作区';
}

function createPickerCard(
  choices: readonly { readonly candidate: ThreadCandidate; readonly token: string }[],
): CardKitJson {
  const elements: Array<Record<string, unknown>> = [
    markdown('请选择要绑定的 ChatGPT 会话。选择卡 10 分钟内有效。'),
    { tag: 'hr' },
  ];
  if (choices.length === 0) {
    elements.push(markdown('没有可绑定的最近会话。请先在 ChatGPT 中创建会话后重试。'));
  } else {
    choices.forEach(({ candidate, token }, index) => {
      const title = sanitizeCardText(candidate.title, { maxLength: 80 });
      const workspaceName = sanitizeCardText(candidate.workspaceName, { maxLength: 80 });
      const threadFingerprint = sanitizeCardText(shortThreadFingerprint(candidate.id), {
        maxLength: 24,
      });
      const updatedAt = sanitizeCardText(formatThreadUpdatedAt(candidate.updatedAt), {
        maxLength: 40,
      });
      elements.push(
        markdown(
          `**${index + 1}. ${title}**\n` +
            `更新时间：${updatedAt}\n工作区：${workspaceName}\n` +
            `会话标识：${threadFingerprint}`,
        ),
        {
          tag: 'button',
          type: 'primary',
          width: 'fill',
          text: { tag: 'plain_text', content: '绑定此会话' },
          value: { action: 'binding', token },
        },
      );
      if (index < choices.length - 1) {
        elements.push({ tag: 'hr' });
      }
    });
  }
  return baseCard('选择 ChatGPT 会话', 'blue', elements);
}

function createBindingStatusCard(
  binding: ChatThreadBindingRecord | undefined,
  rootBinding: ThreadBindingRecord | undefined,
): CardKitJson {
  if (!binding) {
    return baseCard('ChatGPT 会话绑定', 'orange', [
      markdown('当前飞书会话尚未绑定 ChatGPT 会话。发送 `/bind` 进行选择。'),
    ]);
  }
  const title = sanitizeCardText(binding.threadTitle ?? '未命名会话', { maxLength: 100 });
  const threadFingerprint = sanitizeCardText(shortThreadFingerprint(binding.threadId), {
    maxLength: 24,
  });
  const workspaceName = sanitizeCardText(workspaceBasename(binding.workspacePath), {
    maxLength: 80,
  });
  const elements: Array<Record<string, unknown>> = [
    markdown(
      `**当前绑定**\n${title}\n\n工作区：${workspaceName}\n会话标识：${threadFingerprint}`,
    ),
  ];
  if (rootBinding?.threadId && rootBinding.threadId !== binding.threadId) {
    const rootWorkspace = sanitizeCardText(workspaceBasename(rootBinding.workspacePath), {
      maxLength: 80,
    });
    const rootFingerprint = sanitizeCardText(shortThreadFingerprint(rootBinding.threadId), {
      maxLength: 24,
    });
    elements.push(
      { tag: 'hr' },
      markdown(
        `**当前话题的固定目标**\n工作区：${rootWorkspace}\n` +
          `会话标识：${rootFingerprint}\n\n该话题会继续原会话；请发送新的顶层消息以使用当前绑定。`,
      ),
    );
  }
  return baseCard('ChatGPT 会话绑定', 'green', elements);
}

function createUnboundCard(removed: boolean): CardKitJson {
  return baseCard('ChatGPT 会话绑定', removed ? 'green' : 'orange', [
    markdown(removed
      ? '已解除当前飞书会话与 ChatGPT 会话的绑定。'
      : '当前飞书会话原本没有绑定 ChatGPT 会话。'),
  ]);
}

function baseCard(
  title: string,
  template: string,
  elements: readonly Record<string, unknown>[],
): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: { elements },
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function createBindingToken(
  threadId: string,
  expectedRevision: number,
  scope: Pick<InboundTextMessage, 'tenantKey' | 'chatId' | 'senderOpenId'>,
  appSecret: string,
  nowMs: number,
): string | null {
  const expiresAtMs = nowMs + BINDING_TOKEN_TTL_MS;
  const encodedThreadId = Buffer.from(threadId, 'utf8').toString('base64url');
  const unsigned = [
    BINDING_TOKEN_VERSION,
    expiresAtMs.toString(36),
    expectedRevision.toString(36),
    encodedThreadId,
  ].join('.');
  const signature = bindingSignature(
    unsigned,
    scope.tenantKey,
    scope.chatId,
    scope.senderOpenId,
    appSecret,
  ).toString('base64url');
  const token = `${unsigned}.${signature}`;
  return token.length <= MAX_BINDING_TOKEN_LENGTH ? token : null;
}

function verifyBindingToken(
  token: string,
  scope: Pick<BindingCardAction, 'tenantKey' | 'chatId' | 'operatorOpenId'>,
  appSecret: string,
  nowMs: number,
): TokenVerification {
  if (!token || token.length > MAX_BINDING_TOKEN_LENGTH) {
    return { disposition: 'invalid' };
  }
  const segments = token.split('.');
  if (segments.length !== 5 || segments[0] !== BINDING_TOKEN_VERSION) {
    return { disposition: 'invalid' };
  }
  const expiresAtMs = parseBase36Integer(segments[1]);
  const expectedRevision = parseBase36Integer(segments[2]);
  const encodedThreadId = segments[3] ?? '';
  const encodedSignature = segments[4] ?? '';
  const threadId = decodeCanonicalBase64Url(encodedThreadId);
  if (
    expiresAtMs === null
    || expectedRevision === null
    || threadId === null
    || !threadId
    || Buffer.byteLength(threadId, 'utf8') > MAX_THREAD_ID_BYTES
  ) {
    return { disposition: 'invalid' };
  }

  const unsigned = segments.slice(0, 4).join('.');
  const expectedSignature = bindingSignature(
    unsigned,
    scope.tenantKey,
    scope.chatId,
    scope.operatorOpenId,
    appSecret,
  );
  const suppliedSignature = decodeSignature(encodedSignature);
  const signatureMatches = timingSafeEqual(expectedSignature, suppliedSignature.value)
    && suppliedSignature.canonical;
  if (!signatureMatches) {
    return { disposition: 'invalid' };
  }
  if (expiresAtMs <= nowMs) {
    return { disposition: 'expired' };
  }
  return {
    disposition: 'valid',
    payload: { threadId, expectedRevision, expiresAtMs },
  };
}

function bindingSignature(
  unsigned: string,
  tenantKey: string,
  chatId: string,
  operatorOpenId: string,
  appSecret: string,
): Buffer {
  return createHmac('sha256', appSecret)
    .update(JSON.stringify([
      'codex-feishu-bridge',
      'conversation-binding',
      unsigned,
      tenantKey,
      chatId,
      operatorOpenId,
    ]))
    .digest();
}

function decodeSignature(encoded: string): { readonly value: Buffer; readonly canonical: boolean } {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { value: Buffer.alloc(32), canonical: false };
  }
  const decoded = Buffer.from(encoded, 'base64url');
  const canonical = decoded.length === 32 && decoded.toString('base64url') === encoded;
  return { value: canonical ? decoded : Buffer.alloc(32), canonical };
}

function decodeCanonicalBase64Url(encoded: string): string | null {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return null;
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) {
    return null;
  }
  const value = decoded.toString('utf8');
  return Buffer.from(value, 'utf8').equals(decoded) ? value : null;
}

function parseBase36Integer(value: string | undefined): number | null {
  if (!value || !/^[0-9a-z]+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString(36) === value
    ? parsed
    : null;
}

function safeToastTitle(title: string): string {
  return String(sanitizeCardText(title, { maxLength: 80 })).replaceAll('\\', '');
}

function shortThreadFingerprint(threadId: string): string {
  return threadId.length <= 12
    ? threadId
    : `${threadId.slice(0, 6)}…${threadId.slice(-6)}`;
}

function formatThreadUpdatedAt(updatedAt: number | null): string {
  if (updatedAt === null) {
    return '未知';
  }
  const milliseconds = updatedAt < 10_000_000_000 ? updatedAt * 1_000 : updatedAt;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? '未知'
    : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
