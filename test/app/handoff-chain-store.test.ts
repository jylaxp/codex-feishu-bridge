import assert from 'node:assert/strict';
import test from 'node:test';

import { HandoffChainStore } from '../../src/app/collaboration/handoff-chain-store';
import type { HandoffEnvelope } from '../../src/app/collaboration/handoff-directive';

test('handoff chain store reserves first outbound handoff and rejects duplicates', () => {
  let now = 1_000;
  const store = new HandoffChainStore({ now: () => now, cooldownMs: 1 });
  const envelope = handoffEnvelope({ expiresAtMs: 10_000 });

  assert.deepEqual(store.reserveOutbound(envelope, 'cli_bbbbbbbbbbbbbbbb'), { accepted: true });
  assert.deepEqual(store.reserveOutbound(envelope, 'cli_bbbbbbbbbbbbbbbb'), {
    accepted: false,
    reason: 'duplicate',
  });
  now = 11_000;
  assert.deepEqual(store.reserveOutbound(envelope, 'cli_bbbbbbbbbbbbbbbb'), {
    accepted: false,
    reason: 'expired',
  });
});

test('handoff chain store allows visited targets and still blocks outbound hop overflow', () => {
  const store = new HandoffChainStore({ now: () => 1_000, maxHops: 2 });

  assert.deepEqual(store.reserveOutbound(
    handoffEnvelope({ visitedBotKeys: ['cli_aaaaaaaaaaaaaaaa', 'cli_bbbbbbbbbbbbbbbb'] }),
    'cli_bbbbbbbbbbbbbbbb',
  ), { accepted: true });
  assert.deepEqual(store.reserveOutbound(
    handoffEnvelope({ hop: 3 }),
    'cli_bbbbbbbbbbbbbbbb',
  ), { accepted: false, reason: 'max_hops' });
});

test('handoff chain store does not reject outbound handoffs only because target was visited', () => {
  const store = new HandoffChainStore({ now: () => 1_000, cooldownMs: 1 });

  assert.deepEqual(store.reserveOutbound(
    handoffEnvelope({
      handoffId: 'hf_visited_target_allowed',
      visitedBotKeys: ['cli_aaaaaaaaaaaaaaaa', 'cli_bbbbbbbbbbbbbbbb'],
    }),
    'cli_bbbbbbbbbbbbbbbb',
  ), { accepted: true });
});

test('handoff chain store rate limits source-target outbound pairs', () => {
  const store = new HandoffChainStore({ now: () => 1_000, cooldownMs: 10_000 });

  assert.deepEqual(store.reserveOutbound(handoffEnvelope({ handoffId: 'hf_first' }), 'cli_bbbbbbbbbbbbbbbb'), {
    accepted: true,
  });
  assert.deepEqual(store.reserveOutbound(handoffEnvelope({ handoffId: 'hf_second' }), 'cli_bbbbbbbbbbbbbbbb'), {
    accepted: false,
    reason: 'cooldown',
  });
});

function handoffEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    chainId: 'ch_aaaaaaaaaaaaaaaaaaaaaaaa',
    handoffId: 'hf_aaaaaaaaaaaaaaaaaaaaaaaa',
    sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
    hop: 1,
    expiresAtMs: 10_000,
    visitedBotKeys: ['cli_aaaaaaaaaaaaaaaa'],
    ...overrides,
  };
}
