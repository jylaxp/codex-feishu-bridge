import { createHash, randomUUID } from 'node:crypto';

import { CardKitJson } from './layouts';
import { FetchLike, TenantTokenProvider } from '../lark/client';

const CARDKIT_BASE_URL = 'https://open.feishu.cn/open-apis/cardkit/v1/cards';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CARD_SEQUENCE = 2_147_483_647;
const MAX_MESSAGE_UUID_LENGTH = 50;
const CARD_REFERENCE_MAX_ATTEMPTS = 6;
const CARD_REFERENCE_RETRY_BASE_DELAY_MS = 500;

export type CardKitErrorKind =
  | 'HTTP_RETRYABLE'
  | 'HTTP_FATAL'
  | 'API_FATAL'
  | 'SEQUENCE_UNKNOWN'
  | 'INVALID_RESPONSE'
  | 'NETWORK_RETRYABLE';

export class CardKitError extends Error {
  public constructor(
    public readonly kind: CardKitErrorKind,
    message: string,
    public readonly apiCode?: number,
  ) {
    super(message);
    this.name = 'CardKitError';
  }

  public get retryable(): boolean {
    return this.kind === 'HTTP_RETRYABLE' || this.kind === 'NETWORK_RETRYABLE';
  }
}

export interface LarkReplyApi {
  readonly im: {
    readonly message: {
      reply(payload: {
        readonly data: {
          readonly content: string;
          readonly msg_type: string;
          readonly reply_in_thread: boolean;
          readonly uuid: string;
        };
        readonly path: { readonly message_id: string };
      }): Promise<{
        readonly code?: number;
        readonly msg?: string;
        readonly data?: { readonly message_id?: string };
      }>;
      create(payload: {
        readonly params: { readonly receive_id_type: 'chat_id' };
        readonly data: {
          readonly receive_id: string;
          readonly content: string;
          readonly msg_type: string;
          readonly uuid: string;
        };
      }): Promise<{
        readonly code?: number;
        readonly msg?: string;
        readonly data?: { readonly message_id?: string };
      }>;
      patch(payload: {
        readonly path: { readonly message_id: string };
        readonly data: { readonly content: string };
      }): Promise<{
        readonly code?: number;
        readonly msg?: string;
      }>;
    };
  };
}

interface CardKitResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: { readonly card_id?: string };
}

export class CardKitClient {
  public constructor(
    private readonly tokenProvider: TenantTokenProvider,
    private readonly larkApi: LarkReplyApi,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
    private readonly transformCard: (card: CardKitJson) => Promise<CardKitJson> = async (card) => card,
  ) {}

  /** Creates a CardKit instance in streaming mode. */
  public async createCard(card: CardKitJson): Promise<string> {
    const renderedCard = await this.transformCard(card);
    const payload = await this.request(CARDKIT_BASE_URL, {
      method: 'POST',
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(renderedCard) }),
    });
    const cardId = payload.data?.card_id;
    if (!cardId) {
      throw new CardKitError('INVALID_RESPONSE', 'CardKit create response has no card id');
    }
    return cardId;
  }

  /** Replies inline to the root message with an idempotent card reference. */
  public async replyCard(
    rootMessageId: string,
    cardId: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<string> {
    return this.retryCardReference(async () => {
      try {
        const response = await this.larkApi.im.message.reply({
          path: { message_id: rootMessageId },
          data: {
            msg_type: 'interactive',
            reply_in_thread: false,
            uuid: messageOperationId(idempotencyKey),
            content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new CardKitError(
            'API_FATAL',
            `Lark card reply rejected: ${response.msg ?? 'unknown error'}`,
            response.code,
          );
        }
        const messageId = response.data?.message_id;
        if (!messageId) {
          throw new CardKitError('INVALID_RESPONSE', 'Lark card reply has no message id');
        }
        return messageId;
      } catch (error) {
        if (error instanceof CardKitError) {
          throw error;
        }
        throw new CardKitError('NETWORK_RETRYABLE', 'Lark card reply request failed');
      }
    });
  }

  /** Posts an independent card into a bound Feishu chat for a Desktop-originated turn. */
  public async sendCard(
    chatId: string,
    cardId: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<string> {
    return this.retryCardReference(async () => {
      try {
        const response = await this.larkApi.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            uuid: messageOperationId(idempotencyKey),
            content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new CardKitError(
            'API_FATAL',
            `Lark card send rejected: ${response.msg ?? 'unknown error'}`,
            response.code,
          );
        }
        const messageId = response.data?.message_id;
        if (!messageId) {
          throw new CardKitError('INVALID_RESPONSE', 'Lark card send has no message id');
        }
        return messageId;
      } catch (error) {
        if (error instanceof CardKitError) {
          throw error;
        }
        throw new CardKitError('NETWORK_RETRYABLE', 'Lark card send request failed');
      }
    });
  }

  /** Replaces one interactive message with a complete card, matching the legacy product flow. */
  public async patchMessage(messageId: string, card: CardKitJson): Promise<void> {
    const renderedCard = await this.transformCard(card);
    try {
      const response = await this.larkApi.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(renderedCard) },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new CardKitError(
          'API_FATAL',
          `Lark card patch rejected: ${response.msg ?? 'unknown error'}`,
          response.code,
        );
      }
    } catch (error) {
      if (error instanceof CardKitError) {
        throw error;
      }
      throw new CardKitError('NETWORK_RETRYABLE', 'Lark card patch request failed');
    }
  }

  private async retryCardReference<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    for (let attempt = 1; attempt <= CARD_REFERENCE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isCardReferenceRetryable(error) || attempt === CARD_REFERENCE_MAX_ATTEMPTS) {
          throw error;
        }
        await delay(CARD_REFERENCE_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    throw new CardKitError('NETWORK_RETRYABLE', 'Lark card reference retry exhausted');
  }

  /** Replaces the complete card at one exact CardKit sequence. */
  public async replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number> {
    const sequence = nextCardSequence(acknowledgedSequence);
    const renderedCard = await this.transformCard(card);
    await this.request(`${CARDKIT_BASE_URL}/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        card: { type: 'card_json', data: JSON.stringify(renderedCard) },
        sequence,
        ...(idempotencyKey ? { uuid: requireCardOperationId(idempotencyKey) } : {}),
      }),
    });
    return sequence;
  }

  /** Closes CardKit streaming mode at one exact sequence. */
  public async closeStreaming(
    cardId: string,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number> {
    const sequence = nextCardSequence(acknowledgedSequence);
    await this.request(`${CARDKIT_BASE_URL}/${encodeURIComponent(cardId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence,
        ...(idempotencyKey ? { uuid: requireCardOperationId(idempotencyKey) } : {}),
      }),
    });
    return sequence;
  }

  private async request(url: string, init: RequestInit): Promise<CardKitResponse> {
    const response = await this.authorizedFetch(url, init);
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch {
      throw new CardKitError(
        'NETWORK_RETRYABLE',
        'CardKit response body read failed',
      );
    }
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_RESPONSE_BYTES) {
      if (!response.ok) {
        throw new CardKitError(
          httpErrorKind(response.status),
          `CardKit HTTP status ${response.status}`,
        );
      }
      throw new CardKitError('INVALID_RESPONSE', 'CardKit response is too large');
    }

    let payload: CardKitResponse | undefined;
    try {
      payload = JSON.parse(rawBody) as CardKitResponse;
    } catch {
      if (response.ok) {
        throw new CardKitError('INVALID_RESPONSE', 'CardKit response is invalid JSON');
      }
    }
    if (payload?.code === 300317) {
      throw new CardKitError(
        'SEQUENCE_UNKNOWN',
        'CardKit rejected the expected sequence',
        payload.code,
      );
    }
    if (!response.ok) {
      throw new CardKitError(
        httpErrorKind(response.status),
        `CardKit HTTP status ${response.status}`,
        payload?.code,
      );
    }
    if (!payload) {
      throw new CardKitError('INVALID_RESPONSE', 'CardKit response is invalid JSON');
    }
    if (payload.code !== 0) {
      throw new CardKitError(
        'API_FATAL',
        `CardKit API rejected the request: ${payload.msg ?? 'unknown error'}`,
        payload.code,
      );
    }
    return payload;
  }

  private async authorizedFetch(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokenProvider.getToken();
      const response = await this.fetchOnce(url, init, token);
      if (
        attempt === 0
        && (response.status === 401 || response.status === 403)
        && this.tokenProvider.invalidateToken
      ) {
        this.tokenProvider.invalidateToken(token);
        continue;
      }
      return response;
    }
    throw new CardKitError('HTTP_FATAL', 'CardKit authentication retry failed');
  }

  private async fetchOnce(url: string, init: RequestInit, token: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CardKitError('NETWORK_RETRYABLE', 'CardKit network request failed');
    }
    return response;
  }
}

function httpErrorKind(status: number): CardKitErrorKind {
  return status === 429 || status >= 500 ? 'HTTP_RETRYABLE' : 'HTTP_FATAL';
}

function nextCardSequence(acknowledgedSequence: number): number {
  if (
    !Number.isSafeInteger(acknowledgedSequence)
    || acknowledgedSequence < 0
    || acknowledgedSequence >= MAX_CARD_SEQUENCE
  ) {
    throw new CardKitError('API_FATAL', 'CardKit sequence is outside the supported range');
  }
  return acknowledgedSequence + 1;
}

function requireCardOperationId(value: string): string {
  if (!value || value.length > 64) {
    throw new CardKitError('API_FATAL', 'CardKit operation id must contain 1 to 64 characters');
  }
  return value;
}

function messageOperationId(value: string): string {
  if (!value) {
    throw new CardKitError('API_FATAL', 'Lark message operation id must not be empty');
  }
  return value.length <= MAX_MESSAGE_UUID_LENGTH
    ? value
    : createHash('sha256').update(value).digest('base64url');
}

function isCardReferenceRetryable(error: unknown): boolean {
  return error instanceof CardKitError
    && (error.retryable || error.apiCode === 230099 || /card\s*id is invalid/i.test(error.message));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
