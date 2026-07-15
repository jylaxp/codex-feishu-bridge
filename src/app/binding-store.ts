import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const BINDINGS_SCHEMA_VERSION = 1;
const MAX_BINDINGS_FILE_BYTES = 1024 * 1024;
const MAX_BINDING_COUNT = 10_000;
const MAX_IDENTIFIER_LENGTH = 512;

export interface BindingSettings {
  readonly model?: string;
  readonly personality?: string;
  readonly style?: string;
  readonly plan?: string;
}

export interface ChatThreadBinding extends BindingSettings {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly updatedAtMs: number;
}

interface BindingDocument {
  readonly schemaVersion: number;
  readonly bindings: readonly ChatThreadBinding[];
}

export class BindingStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BindingStoreError';
  }
}

export interface BindingStoreOptions {
  readonly now?: () => number;
  readonly bindingsFileName?: string;
}

/**
 * Minimal persistent Bridge state. This file never stores task execution or
 * CardKit state, so a process restart cannot replay an in-flight request.
 */
export class BindingStore {
  private readonly now: () => number;
  private readonly bindingsPath: string;
  private readonly bindings = new Map<string, ChatThreadBinding>();

  public constructor(configHome: string, options: BindingStoreOptions = {}) {
    if (!configHome.trim()) {
      throw new BindingStoreError('Binding config home must not be blank');
    }
    this.now = options.now ?? Date.now;
    this.bindingsPath = join(configHome, options.bindingsFileName ?? 'bindings.json');
  }

  public get filePath(): string {
    return this.bindingsPath;
  }

  /** Loads and validates the whole document once at Bridge startup. */
  public load(): void {
    this.bindings.clear();
    if (!existsSync(this.bindingsPath)) {
      return;
    }
    let content: string;
    try {
      content = readFileSync(this.bindingsPath, { encoding: 'utf8' });
    } catch (error) {
      throw new BindingStoreError('bindings.json could not be read', { cause: error });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BINDINGS_FILE_BYTES) {
      throw new BindingStoreError('bindings.json exceeds the maximum allowed size');
    }
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch (error) {
      throw new BindingStoreError('bindings.json is not valid JSON', { cause: error });
    }
    const parsed = parseDocument(document);
    for (const binding of parsed.bindings) {
      const key = bindingKey(binding.tenantKey, binding.chatId);
      if (this.bindings.has(key)) {
        throw new BindingStoreError('bindings.json contains a duplicate tenant/chat binding');
      }
      this.bindings.set(key, binding);
    }
  }

  public get(tenantKey: string, chatId: string): ChatThreadBinding | undefined {
    return this.bindings.get(bindingKey(tenantKey, chatId));
  }

  public list(): readonly ChatThreadBinding[] {
    return Object.freeze([...this.bindings.values()]);
  }

  /**
   * Resolves a Desktop thread back to one Feishu chat only when the mapping is
   * unambiguous. A Desktop-originated message has no chat scope of its own,
   * so fan-out would risk projecting it into an unintended conversation.
   */
  public getUniqueByThreadId(threadId: string): ChatThreadBinding | undefined {
    let match: ChatThreadBinding | undefined;
    for (const binding of this.bindings.values()) {
      if (binding.threadId !== threadId) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = binding;
    }
    return match;
  }

  /** Persists one replacement binding using same-directory atomic replacement. */
  public bind(
    input: Omit<ChatThreadBinding, 'revision' | 'updatedAtMs'>,
  ): ChatThreadBinding {
    const normalized = normalizeBindingInput(input);
    const key = bindingKey(normalized.tenantKey, normalized.chatId);
    const previous = this.bindings.get(key);
    const binding = Object.freeze({
      ...normalized,
      revision: (previous?.revision ?? 0) + 1,
      updatedAtMs: safeNow(this.now),
    });
    this.bindings.set(key, binding);
    try {
      this.persist();
      return binding;
    } catch (error) {
      if (previous) {
        this.bindings.set(key, previous);
      } else {
        this.bindings.delete(key);
      }
      throw error;
    }
  }

  /** Removes only the static chat binding and never touches any runtime task. */
  public unbind(tenantKey: string, chatId: string): boolean {
    const key = bindingKey(tenantKey, chatId);
    const previous = this.bindings.get(key);
    if (!previous) {
      return false;
    }
    this.bindings.delete(key);
    try {
      this.persist();
      return true;
    } catch (error) {
      this.bindings.set(key, previous);
      throw error;
    }
  }

  private persist(): void {
    const directory = dirname(this.bindingsPath);
    mkdirSync(directory, { recursive: true });
    const document: BindingDocument = Object.freeze({
      schemaVersion: BINDINGS_SCHEMA_VERSION,
      bindings: Object.freeze([...this.bindings.values()]),
    });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BINDINGS_FILE_BYTES) {
      throw new BindingStoreError('bindings.json would exceed the maximum allowed size');
    }
    const temporaryPath = `${this.bindingsPath}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, serialized, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.bindingsPath);
      syncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      safelyUnlink(temporaryPath);
      throw new BindingStoreError('bindings.json could not be atomically updated', { cause: error });
    }
  }
}

function parseDocument(value: unknown): BindingDocument {
  if (!isRecord(value) || hasUnknownKeys(value, ['schemaVersion', 'bindings'])) {
    throw new BindingStoreError('bindings.json has an invalid document shape');
  }
  if (value.schemaVersion !== BINDINGS_SCHEMA_VERSION || !Array.isArray(value.bindings)) {
    throw new BindingStoreError('bindings.json schema version is unsupported');
  }
  if (value.bindings.length > MAX_BINDING_COUNT) {
    throw new BindingStoreError('bindings.json contains too many bindings');
  }
  return Object.freeze({
    schemaVersion: BINDINGS_SCHEMA_VERSION,
    bindings: Object.freeze(value.bindings.map(parseBinding)),
  });
}

function parseBinding(value: unknown): ChatThreadBinding {
  if (!isRecord(value) || hasUnknownKeys(value, [
    'tenantKey',
    'chatId',
    'threadId',
    'workspaceId',
    'model',
    'personality',
    'style',
    'plan',
    'revision',
    'updatedAtMs',
  ])) {
    throw new BindingStoreError('bindings.json contains an invalid binding');
  }
  const normalized = normalizeBindingInput({
    tenantKey: requiredText(value.tenantKey, 'tenantKey'),
    chatId: requiredText(value.chatId, 'chatId'),
    threadId: requiredText(value.threadId, 'threadId'),
    workspaceId: requiredText(value.workspaceId, 'workspaceId'),
    ...(optionalText(value.model, 'model') ? { model: optionalText(value.model, 'model') } : {}),
    ...(optionalText(value.personality, 'personality')
      ? { personality: optionalText(value.personality, 'personality') }
      : {}),
    ...(optionalText(value.style, 'style') ? { style: optionalText(value.style, 'style') } : {}),
    ...(optionalText(value.plan, 'plan') ? { plan: optionalText(value.plan, 'plan') } : {}),
  });
  const revision = value.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new BindingStoreError('binding revision must be a positive safe integer');
  }
  const updatedAtMs = value.updatedAtMs;
  if (
    typeof updatedAtMs !== 'number'
    || !Number.isSafeInteger(updatedAtMs)
    || updatedAtMs < 0
  ) {
    throw new BindingStoreError('binding updatedAtMs must be a non-negative safe integer');
  }
  return Object.freeze({ ...normalized, revision, updatedAtMs });
}

function normalizeBindingInput(
  input: Omit<ChatThreadBinding, 'revision' | 'updatedAtMs'>,
): Omit<ChatThreadBinding, 'revision' | 'updatedAtMs'> {
  return Object.freeze({
    tenantKey: requiredText(input.tenantKey, 'tenantKey'),
    chatId: requiredText(input.chatId, 'chatId'),
    threadId: requiredText(input.threadId, 'threadId'),
    workspaceId: requiredText(input.workspaceId, 'workspaceId'),
    ...(optionalText(input.model, 'model') ? { model: optionalText(input.model, 'model') } : {}),
    ...(optionalText(input.personality, 'personality')
      ? { personality: optionalText(input.personality, 'personality') }
      : {}),
    ...(optionalText(input.style, 'style') ? { style: optionalText(input.style, 'style') } : {}),
    ...(optionalText(input.plan, 'plan') ? { plan: optionalText(input.plan, 'plan') } : {}),
  });
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label);
  if (!text) {
    throw new BindingStoreError(`${label} must be a non-blank string`);
  }
  return text;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BindingStoreError(`${label} must be a string when present`);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > MAX_IDENTIFIER_LENGTH || text.includes('\0')) {
    throw new BindingStoreError(`${label} is invalid`);
  }
  return text;
}

function bindingKey(tenantKey: string, chatId: string): string {
  return JSON.stringify([requiredText(tenantKey, 'tenantKey'), requiredText(chatId, 'chatId')]);
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BindingStoreError('Binding clock must return a non-negative safe integer');
  }
  return value;
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function safelyUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // The original write/replace failure is more useful to callers.
  }
}
