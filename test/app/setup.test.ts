import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotConfigStore } from '../../src/app/bot-config-store';
import { writeBridgeConfigFile } from '../../src/app/config-file';
import { runSetup } from '../../src/app/setup';

test('setup preserves an existing configured Codex working directory', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-setup-preserve-cwd-'));
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-setup-workspace-'));
  try {
    writeBridgeConfigFile(configHome, {
      CODEX_BIN: '/codex',
      CODEX_CWD: workspace,
    });
    new BotConfigStore(configHome).save({
      botKey: 'cli_1111111111111111',
      appId: 'cli_1111111111111111',
      appSecret: 'secret',
      enabled: true,
      tenantKey: '',
      allowedChats: [],
      authorizedUsers: [],
      allowedApprovers: [],
      allowGroupUserMentions: true,
      allowExternalGroupUserMentions: true,
      allowGroupBotMentions: true,
      source: 'import',
    });

    await runSetup({
      configHome,
      stdout: { write: () => undefined },
    }, {});

    const document = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8')) as {
      readonly codex: { readonly cwd: string };
    };
    assert.equal(document.codex.cwd, workspace);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
