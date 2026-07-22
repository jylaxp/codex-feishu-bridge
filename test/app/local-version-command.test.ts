import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { digestJsonSchemaDirectory } from '../../src/app/codex/runtime-contract';
import { runLocalVersionCommand } from '../../src/app/local-version-command';

test('local version command resolves the real environment and persists its report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-local-version-command-'));
  try {
    const workspace = join(root, 'workspace');
    const schemaRoot = join(root, 'expected-schema');
    mkdirSync(workspace);
    writeJson(join(schemaRoot, 'v2/Fake.json'), { type: 'string', title: 'Local version' });
    const schemaDigest = digestJsonSchemaDirectory(schemaRoot);
    const codexBinary = createFakeCodex(
      root,
      '0.145.0-alpha.19',
      { type: 'string', title: 'Local version' },
    );
    writeJson(join(root, 'protocol-versions.json'), {
      schemaVersion: 1,
      supportedVersions: [{
        codexVersion: '0.145.0-alpha.19',
        schemaDigest,
        adapterProfileId: 'app-server-0.145.0-alpha.18',
        source: 'approved',
      }],
      lastDetection: null,
    });

    const report = await runLocalVersionCommand({
      BRIDGE_CONFIG_HOME: root,
      CODEX_BIN: codexBinary,
      CODEX_CWD: workspace,
      PATH: process.env.PATH,
    }, { now: () => new Date('2026-07-19T09:30:00.000Z') });

    assert.equal(report.conclusion, '兼容');
    assert.equal(report.status, 'supported');
    assert.equal(report.codexVersion, '0.145.0-alpha.19');
    assert.equal(report.codexBinary, realpathSync.native(codexBinary));
    assert.equal(report.schemaDigest, schemaDigest);
    assert.equal(report.chatGptApp, null);
    assert.deepEqual(report.supportedVersions, [
      '0.145.0-alpha.19',
      '0.144.3',
      '0.145.0-alpha.18',
      '0.145.0-alpha.27',
      '0.145.0-alpha.30',
    ]);
    const persisted = JSON.parse(
      readFileSync(join(root, 'protocol-versions.json'), 'utf8'),
    ) as {
      readonly supportedVersions: ReadonlyArray<{
        readonly codexVersion: string;
        readonly source: string;
      }>;
      readonly lastDetection: {
        readonly checkedAt: string;
        readonly compatibility: { readonly status: string };
      };
    };
    assert.deepEqual(
      persisted.supportedVersions.map((entry) => [entry.codexVersion, entry.source]),
      [
        ['0.145.0-alpha.19', 'approved'],
        ['0.144.3', 'builtin'],
        ['0.145.0-alpha.18', 'builtin'],
        ['0.145.0-alpha.27', 'builtin'],
        ['0.145.0-alpha.30', 'builtin'],
      ],
    );
    assert.equal(persisted.lastDetection.checkedAt, '2026-07-19T09:30:00.000Z');
    assert.equal(persisted.lastDetection.compatibility.status, 'supported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local version command rejects invalid binary and working directory paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-local-version-command-invalid-'));
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    await assert.rejects(
      runLocalVersionCommand({
        BRIDGE_CONFIG_HOME: root,
        CODEX_BIN: join(root, 'missing-codex'),
        CODEX_CWD: workspace,
      }),
      /CODEX_BIN must resolve to an executable file/,
    );

    const codexBinary = createFakeCodex(root, '0.145.0-alpha.19', { type: 'string' });
    await assert.rejects(
      runLocalVersionCommand({
        BRIDGE_CONFIG_HOME: root,
        CODEX_BIN: codexBinary,
        CODEX_CWD: join(root, 'missing-workspace'),
      }),
      /CODEX_CWD must resolve to a directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFakeCodex(root: string, version: string, schemaValue: unknown): string {
  const filePath = join(root, 'fake-codex.mjs');
  const source = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
if (process.argv[2] === '--version') {
  console.log(${JSON.stringify(`codex-cli ${version}`)});
  process.exit(0);
}
const output = process.argv[process.argv.indexOf('--out') + 1];
const schemaPath = join(output, 'v2/Fake.json');
mkdirSync(dirname(schemaPath), { recursive: true });
writeFileSync(schemaPath, ${JSON.stringify(JSON.stringify(schemaValue))});
`;
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
  return filePath;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}
