import type { HandoffEnvelope } from './handoff-directive';

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_HOPS = 2;

export type HandoffChainBlockReason =
  | 'expired'
  | 'duplicate'
  | 'max_hops'
  | 'cooldown';

export type HandoffChainDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: HandoffChainBlockReason };

export interface HandoffChainStoreOptions {
  readonly now?: () => number;
  readonly maxHops?: number;
  readonly defaultTtlMs?: number;
  readonly cooldownMs?: number;
}

export interface HandoffChainSnapshot {
  readonly emitted: number;
  readonly accepted: number;
  readonly blocked: number;
  readonly duplicate: number;
  readonly loopBlocked: number;
}

/** In-process guard for autonomous bot handoffs. It stores no prompt or answer content. */
export class HandoffChainStore {
  private readonly now: () => number;
  private readonly maxHops: number;
  private readonly defaultTtlMs: number;
  private readonly cooldownMs: number;
  private readonly seenHandoffs = new Map<string, number>();
  private readonly pairCooldowns = new Map<string, number>();
  private emitted = 0;
  private accepted = 0;
  private blocked = 0;
  private duplicate = 0;

  public constructor(options: HandoffChainStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxHops = positiveInteger(options.maxHops ?? DEFAULT_MAX_HOPS, 'maxHops');
    this.defaultTtlMs = positiveInteger(options.defaultTtlMs ?? DEFAULT_TTL_MS, 'defaultTtlMs');
    this.cooldownMs = positiveInteger(options.cooldownMs ?? DEFAULT_COOLDOWN_MS, 'cooldownMs');
  }

  public ttlMs(): number {
    return this.defaultTtlMs;
  }

  public reserveOutbound(
    envelope: HandoffEnvelope,
    targetBotKey: string,
  ): HandoffChainDecision {
    this.prune();
    const decision = this.validateEnvelope(envelope, targetBotKey);
    if (!decision.accepted) {
      this.recordBlock(decision.reason);
      return decision;
    }
    const pairKey = `${envelope.sourceBotKey}\0${targetBotKey}`;
    const cooldownUntil = this.pairCooldowns.get(pairKey) ?? 0;
    if (cooldownUntil > this.now()) {
      this.recordBlock('cooldown');
      return { accepted: false, reason: 'cooldown' };
    }
    this.seenHandoffs.set(handoffKey(envelope, targetBotKey), envelope.expiresAtMs);
    this.pairCooldowns.set(pairKey, this.now() + this.cooldownMs);
    this.emitted += 1;
    return { accepted: true };
  }

  public acceptInbound(envelope: HandoffEnvelope, targetBotKey: string): HandoffChainDecision {
    this.prune();
    const decision = this.validateEnvelope(envelope, targetBotKey);
    if (!decision.accepted) {
      this.recordBlock(decision.reason);
      return decision;
    }
    this.seenHandoffs.set(handoffKey(envelope, targetBotKey), envelope.expiresAtMs);
    this.accepted += 1;
    return { accepted: true };
  }

  public snapshot(): HandoffChainSnapshot {
    return Object.freeze({
      emitted: this.emitted,
      accepted: this.accepted,
      blocked: this.blocked,
      duplicate: this.duplicate,
      loopBlocked: 0,
    });
  }

  private validateEnvelope(envelope: HandoffEnvelope, targetBotKey: string): HandoffChainDecision {
    if (envelope.expiresAtMs <= this.now()) {
      return { accepted: false, reason: 'expired' };
    }
    if (envelope.hop > this.maxHops) {
      return { accepted: false, reason: 'max_hops' };
    }
    if (this.seenHandoffs.has(handoffKey(envelope, targetBotKey))) {
      return { accepted: false, reason: 'duplicate' };
    }
    return { accepted: true };
  }

  private recordBlock(reason: HandoffChainBlockReason): void {
    this.blocked += 1;
    if (reason === 'duplicate') {
      this.duplicate += 1;
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAtMs] of this.seenHandoffs) {
      if (expiresAtMs <= now) {
        this.seenHandoffs.delete(key);
      }
    }
    for (const [key, expiresAtMs] of this.pairCooldowns) {
      if (expiresAtMs <= now) {
        this.pairCooldowns.delete(key);
      }
    }
  }
}

function handoffKey(envelope: HandoffEnvelope, targetBotKey: string): string {
  return `${envelope.chainId}\0${envelope.handoffId}\0${targetBotKey}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
