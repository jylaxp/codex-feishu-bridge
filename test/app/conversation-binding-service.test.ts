import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BindingCardAction,
  ConversationBindingCardClient,
  ConversationBindingCatalog,
  ConversationBindingService,
} from '../../src/app/conversation-binding-service';
import { CardKitJson } from '../../src/app/cards/layouts';
import { BridgeDatabase } from '../../src/app/db/database';
import { BridgeRepositories } from '../../src/app/db/repositories';
import { BridgeConfig } from '../../src/app/domain';
import { InboundTextMessage } from '../../src/app/lark/intake';

const NOW_MS = 1_800_000_000_000;

const config: BridgeConfig = Object.freeze({
  larkAppId: 'app-test',
  larkAppSecret: 'binding-secret',
  larkTenantKey: 'tenant-test',
  allowedChats: Object.freeze(['chat-test']),
  authorizedUsers: Object.freeze(['user-test', 'other-user']),
  allowedApprovers: Object.freeze([]),
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/opt/codex',
  codexCwd: '/workspace/default',
  allowedWorkspaceRoots: Object.freeze(['/workspace']),
  dataDir: '/data',
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1_000,
  maxQueuedTasks: 20,
});

class FakeCatalog implements ConversationBindingCatalog {
  public readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  public threads: unknown[] = [];
  public readableThreadIds = new Set<string>();

  public constructor(private readonly workspaceRoot: string) {}

  public async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === 'thread/list') {
      return {
        data: this.threads.map((thread) => this.materializeWorkspace(thread)),
        nextCursor: null,
      } as TResult;
    }
    if (method === 'thread/read') {
      const threadId = (params as { readonly threadId?: string }).threadId;
      if (!threadId || !this.readableThreadIds.has(threadId)) {
        throw new Error('thread not found');
      }
      const thread = this.threads.find((candidate) => (
        (candidate as { readonly id?: string }).id === threadId
      )) ?? { id: threadId, name: null, preview: '', cwd: this.workspaceRoot };
      return { thread: this.materializeWorkspace(thread) } as TResult;
    }
    throw new Error(`unexpected method: ${method}`);
  }

  private materializeWorkspace(value: unknown): unknown {
    const record = value as Readonly<Record<string, unknown>>;
    if (record.preserveCwd === true) {
      const { preserveCwd: _preserveCwd, ...materialized } = record;
      return materialized;
    }
    const rawCwd = typeof record.cwd === 'string' ? record.cwd : 'default';
    const workspaceName = rawCwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
      ?? 'default';
    const workspacePath = join(this.workspaceRoot, workspaceName);
    mkdirSync(workspacePath, { recursive: true });
    return { ...record, cwd: workspacePath };
  }
}

class FakeCards implements ConversationBindingCardClient {
  public readonly cards: CardKitJson[] = [];
  public readonly replies: Array<{
    readonly rootMessageId: string;
    readonly cardId: string;
    readonly idempotencyKey: string;
  }> = [];

  public async createCard(card: CardKitJson): Promise<string> {
    this.cards.push(card);
    return `card-${this.cards.length}`;
  }

  public async replyCard(
    rootMessageId: string,
    cardId: string,
    idempotencyKey: string,
  ): Promise<string> {
    this.replies.push({ rootMessageId, cardId, idempotencyKey });
    return `message-${this.replies.length}`;
  }
}

interface Fixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly database: BridgeDatabase;
  readonly catalog: FakeCatalog;
  readonly cards: FakeCards;
  readonly service: ConversationBindingService;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'conversation-binding-'));
  const requestedWorkspaceRoot = join(root, 'workspaces');
  mkdirSync(requestedWorkspaceRoot, { recursive: true });
  const workspaceRoot = realpathSync.native(requestedWorkspaceRoot);
  const database = new BridgeDatabase(join(root, 'bridge.db'));
  database.open();
  const catalog = new FakeCatalog(workspaceRoot);
  const cards = new FakeCards();
  const fixtureConfig: BridgeConfig = {
    ...config,
    codexCwd: workspaceRoot,
    allowedWorkspaceRoots: Object.freeze([workspaceRoot]),
  };
  return {
    root,
    workspaceRoot,
    database,
    catalog,
    cards,
    service: new ConversationBindingService(database, fixtureConfig, catalog, cards, {
      now: () => NOW_MS,
    }),
  };
}

function dispose(fixture: Fixture): void {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function message(text: string, overrides: Partial<InboundTextMessage> = {}): InboundTextMessage {
  return {
    tenantKey: 'tenant-test',
    eventId: 'event-test',
    messageId: 'message-test',
    chatId: 'chat-test',
    rootMessageId: 'root-test',
    senderOpenId: 'user-test',
    text,
    payloadDigest: 'digest-test',
    createdAtMs: NOW_MS,
    ...overrides,
  };
}

function buttonTokens(card: CardKitJson): readonly string[] {
  const tokens: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.action === 'binding' && typeof record.token === 'string') {
      tokens.push(record.token);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return tokens;
}

function bindingAction(token: string, overrides: Partial<BindingCardAction> = {}): BindingCardAction {
  return {
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    messageId: 'binding-card-message',
    operatorOpenId: 'user-test',
    action: 'binding',
    token,
    ...overrides,
  };
}

function toastContent(result: unknown): string {
  return String((result as { readonly toast?: { readonly content?: string } }).toast?.content ?? '');
}

test('/bind lists eight recent global threads without absolute-path disclosure', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = Array.from({ length: 9 }, (_, index) => ({
      id: `thread${index}`,
      name: index === 0 ? `Title ${'A'.repeat(300)}` : `Task ${index}`,
      preview: index === 0 ? `Preview /Users/private/secret ${'B'.repeat(500)}` : `Preview ${index}`,
      cwd: index === 0 ? '/Users/private/customer-workspace' : `/workspace/project${index}`,
      updatedAt: NOW_MS - index,
    }));

    assert.equal(await fixture.service.handleCommand(message('/bind')), true);

    assert.deepEqual(fixture.catalog.calls, [{
      method: 'thread/list',
      params: {
        limit: 8,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode'],
        archived: false,
      },
    }]);
    assert.equal(fixture.cards.cards.length, 1);
    assert.deepEqual(fixture.cards.replies, [{
      rootMessageId: 'root-test',
      cardId: 'card-1',
      idempotencyKey: 'binding:event-test:picker',
    }]);
    const serialized = JSON.stringify(fixture.cards.cards[0]);
    assert.equal(serialized.includes('/Users/private'), false);
    assert.equal(serialized.includes('/workspace/project'), false);
    assert.match(serialized, /customer.*workspace/);
    assert.match(serialized, /thread0/);
    assert.equal(serialized.includes('A'.repeat(300)), false);
    assert.equal(serialized.includes('B'.repeat(500)), false);
    const tokens = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.equal(tokens.length, 8);
    assert.ok(tokens.every((token) => token.length <= 256));
  } finally {
    dispose(fixture);
  }
});

test('a thread outside the execution roots remains selectable without expanding execution access', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'global-thread',
      name: 'Named ChatGPT task',
      preview: 'Private prompt content',
      cwd: fixture.root,
      preserveCwd: true,
      updatedAt: NOW_MS,
    }];
    fixture.catalog.readableThreadIds.add('global-thread');

    await fixture.service.handleCommand(message('/bind'));

    const serialized = JSON.stringify(fixture.cards.cards[0]);
    assert.match(serialized, /Named ChatGPT task/);
    assert.equal(serialized.includes('Private prompt content'), false);
    assert.equal(serialized.includes(fixture.root), false);
    assert.match(serialized, /会话来源/);
    assert.match(serialized, /执行工作区/);
    const [token] = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.ok(token);

    const result = await fixture.service.handleCardAction(bindingAction(token));

    assert.match(toastContent(result), /绑定成功/);
    const binding = new BridgeRepositories(fixture.database).chatThreadBindings.get(
      'tenant-test',
      'chat-test',
    );
    assert.equal(binding?.threadId, 'global-thread');
    assert.equal(binding?.workspacePath, fixture.workspaceRoot);
  } finally {
    dispose(fixture);
  }
});

test('only exact binding commands are consumed', async () => {
  const fixture = createFixture();
  try {
    assert.equal(await fixture.service.handleCommand(message('/bind now')), false);
    assert.equal(await fixture.service.handleCommand(message(' /bind')), false);
    assert.equal(await fixture.service.handleCommand(message('/unknown')), false);
    assert.equal(fixture.catalog.calls.length, 0);
    assert.equal(fixture.cards.cards.length, 0);
  } finally {
    dispose(fixture);
  }
});

test('unbound normal messages are stopped after replying with a picker', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'thread1',
      name: 'Task one',
      preview: 'Ready',
      cwd: '/workspace/project-one',
    }];

    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), false);
    assert.equal(await fixture.service.ensureBoundOrPrompt(message('run tests')), false);
    assert.equal(fixture.cards.cards.length, 1);

    new BridgeRepositories(fixture.database).chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread1',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      nowMs: NOW_MS,
    });
    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), true);
    assert.equal(await fixture.service.ensureBoundOrPrompt(message('run tests')), true);
    assert.equal(fixture.cards.cards.length, 1);
  } finally {
    dispose(fixture);
  }
});

test('/binding reports the durable selection and /unbind removes it', async () => {
  const fixture = createFixture();
  try {
    new BridgeRepositories(fixture.database).chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread1',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      threadTitle: 'Chosen task',
      nowMs: NOW_MS,
    });

    assert.equal(await fixture.service.handleCommand(message('/binding')), true);
    assert.match(JSON.stringify(fixture.cards.cards[0]), /Chosen task/);
    assert.match(JSON.stringify(fixture.cards.cards[0]), /thread1/);

    assert.equal(await fixture.service.handleCommand(message('/unbind', {
      eventId: 'event-unbind',
    })), true);
    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), false);
    assert.match(JSON.stringify(fixture.cards.cards[1]), /已解除/);
  } finally {
    dispose(fixture);
  }
});

test('/binding in an existing root exposes its pinned target override', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-current',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      threadTitle: 'Current task',
      nowMs: NOW_MS,
    });
    repositories.threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-old',
      projectId: 'project-old',
      workspacePath: fixture.workspaceRoot,
      threadId: 'thread-old',
      nowMs: NOW_MS,
    });

    await fixture.service.handleCommand(message('/binding', {
      eventId: 'event-binding-old-root',
      messageId: 'message-binding-old-root',
      rootMessageId: 'root-old',
    }));

    const serialized = JSON.stringify(fixture.cards.cards[0]);
    assert.match(serialized, /Current task/);
    assert.match(serialized, /thread.*urrent/);
    assert.match(serialized, /thread.*old/);
    assert.match(serialized, /当前话题的固定目标/);
  } finally {
    dispose(fixture);
  }
});

test('authorized selection validates thread/read and persists the chat binding', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'thread1',
      name: 'Selected task',
      preview: 'Preview',
      cwd: '/workspace/project-one',
    }];
    fixture.catalog.readableThreadIds.add('thread1');
    await fixture.service.handleCommand(message('/bind'));
    const [token] = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.ok(token);

    const result = await fixture.service.handleCardAction(bindingAction(token));

    assert.match(toastContent(result), /绑定成功/);
    assert.deepEqual(fixture.catalog.calls[1], {
      method: 'thread/read',
      params: { threadId: 'thread1', includeTurns: false },
    });
    const binding = new BridgeRepositories(fixture.database).chatThreadBindings.get(
      'tenant-test',
      'chat-test',
    );
    assert.equal(binding?.threadId, 'thread1');
    assert.equal(binding?.boundByOpenId, 'user-test');
    assert.equal(binding?.threadTitle, 'Selected task');
    assert.equal(binding?.workspacePath, fixture.workspaceRoot);
  } finally {
    dispose(fixture);
  }
});

test('selection tokens reject unauthorized users, scope changes, expiry, and missing threads', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'thread1',
      name: 'Selected task',
      preview: 'Preview',
      cwd: '/workspace/project-one',
    }];
    await fixture.service.handleCommand(message('/bind'));
    const [token] = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.ok(token);

    const unauthorized = await fixture.service.handleCardAction(bindingAction(token, {
      operatorOpenId: 'unauthorized-user',
    }));
    assert.match(toastContent(unauthorized), /没有绑定权限/);

    const wrongAuthorizedUser = await fixture.service.handleCardAction(bindingAction(token, {
      operatorOpenId: 'other-user',
    }));
    assert.match(toastContent(wrongAuthorizedUser), /作用域不匹配/);

    const wrongChat = await fixture.service.handleCardAction(bindingAction(token, {
      chatId: 'another-chat',
    }));
    assert.match(toastContent(wrongChat), /作用域不匹配/);

    const missing = await fixture.service.handleCardAction(bindingAction(token));
    assert.match(toastContent(missing), /会话不存在/);
    assert.equal(fixture.catalog.calls.filter((call) => call.method === 'thread/read').length, 1);
    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), false);

    const expiredService = new ConversationBindingService(
      fixture.database,
      config,
      fixture.catalog,
      fixture.cards,
      { now: () => NOW_MS + 10 * 60_000 + 1 },
    );
    const expired = await expiredService.handleCardAction(bindingAction(token));
    assert.match(toastContent(expired), /已过期/);
  } finally {
    dispose(fixture);
  }
});

test('a picker cannot overwrite a binding changed after the card was created', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'thread1',
      name: 'Old choice',
      preview: 'Preview',
      cwd: '/workspace/old',
    }];
    fixture.catalog.readableThreadIds.add('thread1');
    await fixture.service.handleCommand(message('/bind'));
    const [staleToken] = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.ok(staleToken);

    new BridgeRepositories(fixture.database).chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-new',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      threadTitle: 'New choice',
      nowMs: NOW_MS + 1,
    });

    const result = await fixture.service.handleCardAction(bindingAction(staleToken));

    assert.equal(toastContent(result), '选择卡已过期，请重新 /bind');
    assert.equal(
      new BridgeRepositories(fixture.database).chatThreadBindings.get(
        'tenant-test',
        'chat-test',
      )?.threadId,
      'thread-new',
    );
    assert.equal(fixture.catalog.calls.some((call) => call.method === 'thread/read'), false);
  } finally {
    dispose(fixture);
  }
});

test('an old unbound picker cannot rebind after bind and explicit unbind', async () => {
  const fixture = createFixture();
  try {
    fixture.catalog.threads = [{
      id: 'thread1',
      name: 'Original choice',
      preview: 'Preview',
      cwd: '/workspace/original',
    }];
    fixture.catalog.readableThreadIds.add('thread1');
    await fixture.service.handleCommand(message('/bind'));
    const [oldToken] = buttonTokens(fixture.cards.cards[0] as CardKitJson);
    assert.ok(oldToken);

    assert.match(
      toastContent(await fixture.service.handleCardAction(bindingAction(oldToken))),
      /绑定成功/,
    );
    await fixture.service.handleCommand(message('/unbind', { eventId: 'event-unbind' }));
    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), false);

    const replay = await fixture.service.handleCardAction(bindingAction(oldToken));

    assert.equal(toastContent(replay), '选择卡已过期，请重新 /bind');
    assert.equal(fixture.service.hasBinding('tenant-test', 'chat-test'), false);
    assert.equal(
      new BridgeRepositories(fixture.database).chatThreadBindings.getRevision(
        'tenant-test',
        'chat-test',
      ),
      2,
    );
  } finally {
    dispose(fixture);
  }
});

test('a delayed duplicate unbind cannot remove a newer binding', async () => {
  const fixture = createFixture();
  try {
    const repositories = new BridgeRepositories(fixture.database);
    repositories.chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-old',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      nowMs: NOW_MS,
    });
    const unbindMessage = message('/unbind', {
      eventId: 'event-unbind-once',
      messageId: 'message-unbind-once',
      payloadDigest: 'digest-unbind-once',
    });
    await fixture.service.handleCommand(unbindMessage);
    repositories.chatThreadBindings.upsert({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      threadId: 'thread-new',
      workspacePath: fixture.workspaceRoot,
      boundByOpenId: 'user-test',
      nowMs: NOW_MS + 1,
    });

    await fixture.service.handleCommand(unbindMessage);

    assert.equal(
      repositories.chatThreadBindings.get('tenant-test', 'chat-test')?.threadId,
      'thread-new',
    );
    assert.equal(repositories.chatThreadBindings.getRevision('tenant-test', 'chat-test'), 3);
    assert.equal(repositories.inbox.count(), 1);
  } finally {
    dispose(fixture);
  }
});
