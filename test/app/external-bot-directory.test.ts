import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExternalBotDirectoryStore } from '../../src/app/external-bot-directory';

test('external bot directory replaces one source-bot group and preserves discovery time', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-external-bots-'));
  try {
    let tick = 1_000;
    const store = new ExternalBotDirectoryStore(configHome, { now: () => tick });
    const initial = store.replaceGroup({
      sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      bots: [
        { botOpenId: 'ou_external_order', displayName: 'Order Bot' },
        { botOpenId: 'ou_external_price', displayName: 'Pricing Bot' },
      ],
    });
    assert.equal(initial.length, 2);

    tick = 2_000;
    const updated = store.replaceGroup({
      sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      bots: [{ botOpenId: 'ou_external_order', displayName: 'Order Assistant' }],
    });
    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.displayName, 'Order Assistant');
    assert.equal(updated[0]?.discoveredAtMs, 1_000);
    assert.equal(updated[0]?.updatedAtMs, 2_000);

    const loaded = new ExternalBotDirectoryStore(configHome);
    loaded.load();
    assert.equal(loaded.listForGroup('cli_aaaaaaaaaaaaaaaa', 'tenant', 'chat').length, 1);
    assert.equal(
      loaded.resolveForGroup('cli_aaaaaaaaaaaaaaaa', 'tenant', 'chat', 'Order Assistant').status,
      'found',
    );

    const document = JSON.parse(readFileSync(
      join(configHome, 'channels', 'feishu', 'external-bots.json'),
      'utf8',
    )) as {
      readonly schemaVersion: number;
      readonly entries: readonly { readonly sourceAppId?: string; readonly sourceBotKey?: string; readonly displayName: string }[];
    };
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.entries[0]?.sourceAppId, 'cli_aaaaaaaaaaaaaaaa');
    assert.equal(document.entries[0]?.sourceBotKey, undefined);
    assert.deepEqual(document.entries.map((entry) => entry.displayName), ['Order Assistant']);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('external bot directory ignores development root external-bots.json', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-external-bots-ignore-root-'));
  try {
    writeFileSync(join(configHome, 'external-bots.json'), JSON.stringify({
      schemaVersion: 2,
      entries: [{
        sourceAppId: 'cli_0123456789abcdef',
        tenantKey: 'tenant',
        chatId: 'chat',
        botOpenId: 'ou_external',
        displayName: 'External Bot',
        discoveredAtMs: 1,
        updatedAtMs: 1,
      }],
    }));

    const store = new ExternalBotDirectoryStore(configHome);
    store.load();

    assert.equal(store.list().length, 0);
    assert.equal(existsSync(join(configHome, 'external-bots.json')), true);
    assert.equal(existsSync(join(configHome, 'channels', 'feishu', 'external-bots.json')), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('external bot directory reports ambiguous display names', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-external-bots-ambiguous-'));
  try {
    const store = new ExternalBotDirectoryStore(configHome, { now: () => 1_000 });
    store.replaceGroup({
      sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      bots: [
        { botOpenId: 'ou_external_one', displayName: 'Helper Bot' },
        { botOpenId: 'ou_external_two', displayName: 'Helper Bot' },
      ],
    });

    const result = store.resolveForGroup('cli_aaaaaaaaaaaaaaaa', 'tenant', 'chat', 'Helper Bot');
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.status === 'ambiguous' ? result.matches.length : 0, 2);
    assert.equal(
      store.resolveForGroup('cli_aaaaaaaaaaaaaaaa', 'tenant', 'chat', 'ou_external_two').status,
      'found',
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
