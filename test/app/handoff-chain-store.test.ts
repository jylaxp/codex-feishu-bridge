import assert from 'node:assert/strict';
import test from 'node:test';

import { HandoffChainStore } from '../../src/app/collaboration/handoff-chain-store';
import type { HandoffEnvelope } from '../../src/app/collaboration/handoff-directive';

test('handoff chain store accepts first inbound handoff and rejects duplicates', () => {
  let now = 1_000;
  const store = new HandoffChainStore({ now: () => now, cooldownMs: 1 });
  const envelope = handoffEnvelope({ expiresAtMs: 10_000 });

  assert.deepEqual(store.acceptInbound(envelope, 'bot_bbbbbbbbbbbb'), { accepted: true });
  assert.deepEqual(store.acceptInbound(envelope, 'bot_bbbbbbbbbbbb'), {
    accepted: false,
    reason: 'duplicate',
  });
  now = 11_000;
  assert.deepEqual(store.acceptInbound(envelope, 'bot_bbbbbbbbbbbb'), {
    accepted: false,
    reason: 'expired',
  });
});

test('handoff chain store blocks loops and hop overflow', () => {
  const store = new HandoffChainStore({ now: () => 1_000, maxHops: 2 });

  assert.deepEqual(store.acceptInbound(
    handoffEnvelope({ visitedBotKeys: ['bot_aaaaaaaaaaaa', 'bot_bbbbbbbbbbbb'] }),
    'bot_bbbbbbbbbbbb',
  ), { accepted: false, reason: 'loop' });
  assert.deepEqual(store.acceptInbound(
    handoffEnvelope({ hop: 3 }),
    'bot_bbbbbbbbbbbb',
  ), { accepted: false, reason: 'max_hops' });
});

test('handoff chain store rate limits source-target outbound pairs', () => {
  const store = new HandoffChainStore({ now: () => 1_000, cooldownMs: 10_000 });

  assert.deepEqual(store.reserveOutbound(handoffEnvelope({ handoffId: 'hf_first' }), 'bot_bbbbbbbbbbbb'), {
    accepted: true,
  });
  assert.deepEqual(store.reserveOutbound(handoffEnvelope({ handoffId: 'hf_second' }), 'bot_bbbbbbbbbbbb'), {
    accepted: false,
    reason: 'cooldown',
  });
});

function handoffEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    chainId: 'ch_aaaaaaaaaaaaaaaaaaaaaaaa',
    handoffId: 'hf_aaaaaaaaaaaaaaaaaaaaaaaa',
    sourceBotKey: 'bot_aaaaaaaaaaaa',
    hop: 1,
    expiresAtMs: 10_000,
    visitedBotKeys: ['bot_aaaaaaaaaaaa'],
    ...overrides,
  };
}
