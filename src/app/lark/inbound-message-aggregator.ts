import { createHash } from 'node:crypto';

import { createOpaqueActionToken } from '../action-tokens';
import {
  MAX_INBOUND_IMAGES,
  type InboundImageReference,
  type InboundMessage,
} from './intake';

const MAX_SEEN_MESSAGES = 4_096;
const MAX_PENDING_ACCEPTS_PER_CONVERSATION = 32;

export { MAX_INBOUND_IMAGES } from './intake';

export interface InboundMessageAggregatorOptions {
  readonly onPending?: (
    message: InboundMessage,
    imageCount: number,
    actionToken: string,
  ) => Promise<string | void> | string | void;
  readonly onPendingUpdated?: (
    message: InboundMessage,
    imageCount: number,
    actionToken: string,
    cardMessageId: string,
  ) => Promise<void> | void;
  readonly onCancelled?: (message: InboundMessage) => Promise<void> | void;
  readonly onTooManyImages?: (message: InboundMessage, maximumImages: number) => Promise<void> | void;
  readonly onEmptyBatch?: (message: InboundMessage) => Promise<void> | void;
  readonly onOverloaded?: (message: InboundMessage) => Promise<void> | void;
  readonly onSubmitted?: (
    message: InboundMessage,
    cardMessageId?: string,
  ) => Promise<void> | void;
  readonly onActionDispatchFailed?: (
    message: InboundMessage,
    imageCount: number,
    retryToken: string | null,
    error: Error,
    taskDescription?: string,
    originalCardMessageId?: string,
  ) => Promise<string | void> | string | void;
  readonly onBackgroundError?: (message: InboundMessage, error: Error) => void;
}

interface PendingImageBatch {
  readonly baseMessage: InboundMessage;
  readonly imageReferences: InboundImageReference[];
  readonly actionToken: string;
  taskDescription?: string;
  cardMessageId?: string;
}

export interface InboundImageBatchAction {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly senderOpenId: string;
  readonly action: 'image-run' | 'image-cancel';
  readonly token: string;
  readonly taskDescription?: string;
}

export type InboundImageBatchActionResult = 'submitted' | 'cancelled' | 'invalid';

/** Holds image-only messages until the same sender provides a task description or explicit command. */
export class InboundMessageAggregator {
  private readonly pendingByConversation = new Map<string, PendingImageBatch>();
  private readonly seenMessages = new Map<string, true>();
  private readonly locksByConversation = new Map<string, Promise<void>>();
  private readonly acceptCountByConversation = new Map<string, number>();
  private readonly overloadedConversations = new Set<string>();
  private generation = 0;

  public constructor(
    private readonly dispatch: (message: InboundMessage) => Promise<boolean | void>,
    private readonly options: InboundMessageAggregatorOptions = {},
  ) {}

  public accept(message: InboundMessage): Promise<void> {
    const key = conversationKey(message);
    const generation = this.generation;
    const acceptCount = this.acceptCountByConversation.get(key) ?? 0;
    if (acceptCount >= MAX_PENDING_ACCEPTS_PER_CONVERSATION) {
      if (this.overloadedConversations.has(key)) {
        return Promise.resolve();
      }
      this.overloadedConversations.add(key);
      return Promise.resolve(this.options.onOverloaded?.(message));
    }
    this.acceptCountByConversation.set(key, acceptCount + 1);
    const previous = this.locksByConversation.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.acceptLocked(key, generation, message));
    this.locksByConversation.set(key, current);
    void current.finally(() => {
      if (this.generation !== generation) {
        return;
      }
      const remaining = (this.acceptCountByConversation.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.acceptCountByConversation.set(key, remaining);
      } else {
        this.acceptCountByConversation.delete(key);
      }
      if (remaining < MAX_PENDING_ACCEPTS_PER_CONVERSATION) {
        this.overloadedConversations.delete(key);
      }
      if (this.locksByConversation.get(key) === current) {
        this.locksByConversation.delete(key);
      }
    }).catch(() => undefined);
    return current;
  }

  /** Applies a one-shot action from the pending-image card for the original sender. */
  public async handleImageBatchAction(
    action: InboundImageBatchAction,
  ): Promise<InboundImageBatchActionResult> {
    const key = conversationKey(action);
    const generation = this.generation;
    const previous = this.locksByConversation.get(key) ?? Promise.resolve();
    let result: InboundImageBatchActionResult = 'invalid';
    let claimedBatch: PendingImageBatch | undefined;
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.generation) {
          return;
        }
        const pending = this.pendingByConversation.get(key);
        if (!pending || pending.actionToken !== action.token) {
          return;
        }
        if (action.action === 'image-cancel') {
          this.pendingByConversation.delete(key);
          result = 'cancelled';
          return;
        }
        if (action.taskDescription !== undefined) {
          pending.taskDescription = action.taskDescription;
        }
        this.pendingByConversation.delete(key);
        claimedBatch = pending;
        result = 'submitted';
      });
    this.locksByConversation.set(key, current);
    try {
      await current;
      const backgroundBatch = claimedBatch;
      if (backgroundBatch) {
        void this.dispatchClaimedBatch(
          key,
          generation,
          backgroundBatch,
        ).catch((error: unknown) => {
          this.options.onBackgroundError?.(backgroundBatch.baseMessage, toError(error));
        });
      }
      return result;
    } finally {
      if (this.locksByConversation.get(key) === current) {
        this.locksByConversation.delete(key);
      }
    }
  }

  private async dispatchClaimedBatch(
    key: string,
    generation: number,
    batch: PendingImageBatch,
  ): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    try {
      const accepted = await this.dispatch(mergeBatch(batch, undefined, batch.taskDescription));
      if (accepted === false) {
        throw new Error('Inbound image batch was not accepted');
      }
    } catch (error) {
      await this.recoverFailedBatch(key, generation, batch, toError(error));
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    try {
      await this.options.onSubmitted?.(batch.baseMessage, batch.cardMessageId);
    } catch (error) {
      this.options.onBackgroundError?.(batch.baseMessage, toError(error));
    }
  }

  private async recoverFailedBatch(
    key: string,
    generation: number,
    batch: PendingImageBatch,
    error: Error,
  ): Promise<void> {
    const previous = this.locksByConversation.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (generation !== this.generation) {
        return;
      }
      let retryToken: string | null = null;
      let restored: PendingImageBatch | undefined;
      if (!this.pendingByConversation.has(key)) {
        retryToken = createOpaqueActionToken();
        restored = {
          baseMessage: batch.baseMessage,
          imageReferences: batch.imageReferences,
          actionToken: retryToken,
          ...(batch.taskDescription !== undefined
            ? { taskDescription: batch.taskDescription }
            : {}),
        };
        this.pendingByConversation.set(key, restored);
      }
      const cardMessageId = await this.options.onActionDispatchFailed?.(
        batch.baseMessage,
        batch.imageReferences.length,
        retryToken,
        error,
        batch.taskDescription,
        batch.cardMessageId,
      );
      if (
        restored
        && typeof cardMessageId === 'string'
        && this.pendingByConversation.get(key) === restored
      ) {
        restored.cardMessageId = cardMessageId;
      }
    });
    this.locksByConversation.set(key, current);
    try {
      await current;
    } finally {
      if (this.locksByConversation.get(key) === current) {
        this.locksByConversation.delete(key);
      }
    }
  }

  private async acceptLocked(
    key: string,
    generation: number,
    message: InboundMessage,
  ): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    if (this.isDuplicate(message)) {
      return;
    }
    const pending = this.pendingByConversation.get(key);
    const isTextCommand = (message.imageReferences?.length ?? 0) === 0;
    if (isImageOnly(message)) {
      await this.addPending(key, pending, message);
      return;
    }
    if (isTextCommand && message.text === '/image-cancel') {
      if (pending) {
        this.pendingByConversation.delete(key);
        await this.options.onCancelled?.(message);
      } else {
        await this.options.onEmptyBatch?.(message);
      }
      return;
    }
    if (isTextCommand && message.text === '/image-run') {
      if (pending) {
        const accepted = await this.dispatch(mergeBatch(pending));
        if (accepted !== false) {
          this.pendingByConversation.delete(key);
        }
      } else {
        await this.options.onEmptyBatch?.(message);
      }
      return;
    }
    if (isTextCommand && message.text.startsWith('/')) {
      await this.dispatch(message);
      return;
    }
    if (!pending) {
      await this.dispatch(message);
      return;
    }
    if (uniqueReferences([
      ...pending.imageReferences,
      ...(message.imageReferences ?? []),
    ]).length > MAX_INBOUND_IMAGES) {
      await this.options.onTooManyImages?.(message, MAX_INBOUND_IMAGES);
      return;
    }
    const accepted = await this.dispatch(mergeBatch(pending, message));
    if (accepted !== false) {
      this.pendingByConversation.delete(key);
    }
  }

  public close(): void {
    this.generation += 1;
    this.pendingByConversation.clear();
    this.seenMessages.clear();
    this.locksByConversation.clear();
    this.acceptCountByConversation.clear();
    this.overloadedConversations.clear();
  }

  private async addPending(
    key: string,
    pending: PendingImageBatch | undefined,
    message: InboundMessage,
  ): Promise<void> {
    const incoming = message.imageReferences ?? [];
    const existing = pending?.imageReferences ?? [];
    const merged = uniqueReferences([...existing, ...incoming]);
    if (merged.length > MAX_INBOUND_IMAGES) {
      await this.options.onTooManyImages?.(message, MAX_INBOUND_IMAGES);
      return;
    }
    if (pending) {
      pending.imageReferences.splice(0, pending.imageReferences.length, ...merged);
      if (pending.cardMessageId) {
        await this.options.onPendingUpdated?.(
          message,
          merged.length,
          pending.actionToken,
          pending.cardMessageId,
        );
      } else {
        const cardMessageId = await this.options.onPending?.(
          message,
          merged.length,
          pending.actionToken,
        );
        if (
          typeof cardMessageId === 'string'
          && this.pendingByConversation.get(key) === pending
        ) {
          pending.cardMessageId = cardMessageId;
        }
      }
      return;
    }
    const actionToken = createOpaqueActionToken();
    const batch: PendingImageBatch = {
      baseMessage: message,
      imageReferences: [...merged],
      actionToken,
    };
    this.pendingByConversation.set(key, batch);
    let cardMessageId: string | void;
    try {
      cardMessageId = await this.options.onPending?.(message, merged.length, actionToken);
    } catch (error) {
      if (this.pendingByConversation.get(key) === batch) {
        this.pendingByConversation.delete(key);
      }
      this.seenMessages.delete(messageIdentity(message));
      throw error;
    }
    if (typeof cardMessageId === 'string' && this.pendingByConversation.get(key) === batch) {
      batch.cardMessageId = cardMessageId;
    }
  }

  private isDuplicate(message: InboundMessage): boolean {
    const key = messageIdentity(message);
    if (this.seenMessages.has(key)) {
      return true;
    }
    this.seenMessages.set(key, true);
    if (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.keys().next().value as string | undefined;
      if (oldest) {
        this.seenMessages.delete(oldest);
      }
    }
    return false;
  }
}

function messageIdentity(message: Pick<InboundMessage, 'eventId' | 'messageId'>): string {
  return `${message.eventId}\0${message.messageId}`;
}

function conversationKey(
  message: Pick<InboundMessage, 'tenantKey' | 'chatId' | 'senderOpenId'>,
): string {
  return JSON.stringify([message.tenantKey, message.chatId, message.senderOpenId]);
}

function isImageOnly(message: InboundMessage): boolean {
  return message.hasExplicitText === false && (message.imageReferences?.length ?? 0) > 0;
}

function mergeBatch(
  batch: PendingImageBatch,
  description?: InboundMessage,
  submittedDescription?: string,
): InboundMessage {
  const base = description ?? batch.baseMessage;
  const references = uniqueReferences([
    ...batch.imageReferences,
    ...(description?.imageReferences ?? []),
  ]);
  const text = description?.text ?? submittedDescription ?? batch.baseMessage.text;
  return Object.freeze({
    ...base,
    messageType: references.length > 0 && description ? 'post' : base.messageType,
    hasExplicitText: description?.hasExplicitText ?? Boolean(submittedDescription),
    text,
    imageKey: references[0]?.imageKey,
    imageReferences: Object.freeze(references),
    payloadDigest: createHash('sha256')
      .update(base.payloadDigest)
      .update('\0')
      .update(text)
      .update('\0')
      .update(references.map((reference) => reference.imageKey).join('\0'))
      .digest('hex'),
  });
}

function uniqueReferences(references: readonly InboundImageReference[]): InboundImageReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.messageId}\0${reference.imageKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown inbound image batch error');
}
