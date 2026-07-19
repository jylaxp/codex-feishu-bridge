import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../../src/app/cli';
import type { LocalVersionReport } from '../../src/app/local-version-command';

test('version command emits the detected local application and Codex versions as JSON', async () => {
  const output = await captureStdout(() => runCli(['version', '--json'], {}, {
    runLocalVersionCommand: async () => compatibleReport(),
  }));
  const value = JSON.parse(output) as LocalVersionReport;

  assert.equal(value.codexVersion, '0.145.0-alpha.18');
  assert.equal(value.chatGptApp?.version, '26.715.31925');
  assert.equal(value.conclusion, '兼容');
});

test('compatibility command prints the required conclusion and only approves explicitly', async () => {
  let approved = false;
  const output = await captureStdout(() => runCli(['compatibility', '--approve'], {}, {
    runLocalVersionCommand: async (_env, options) => {
      approved = options.approve === true;
      return compatibleReport();
    },
  }));

  assert.equal(approved, true);
  assert.equal(output.split('\n')[0], '兼容');
  await assert.rejects(
    runCli(['version', '--approve'], {}, {
      runLocalVersionCommand: async () => compatibleReport(),
    }),
    /--approve is only valid with compatibility/,
  );
});

test('compatibility command fails closed with an explicit incompatible conclusion', async () => {
  const output = await captureStdout(() => runCli(['compatibility', '--json'], {}, {
    runLocalVersionCommand: async () => {
      throw new Error('probe failed');
    },
  }));
  assert.deepEqual(JSON.parse(output), {
    conclusion: '不兼容',
    compatible: false,
    status: 'inspection_failed',
  });
});

function compatibleReport(): LocalVersionReport {
  return Object.freeze({
    configPath: '/tmp/protocol-versions.json',
    conclusion: '兼容',
    compatible: true,
    status: 'supported',
    requiresApproval: false,
    codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexVersion: '0.145.0-alpha.18',
    binarySha256: 'a'.repeat(64),
    schemaDigest: 'b'.repeat(64),
    chatGptApp: Object.freeze({
      appPath: '/Applications/ChatGPT.app',
      version: '26.715.31925',
      build: '5551',
    }),
    protocolProfileId: 'app-server-0.145.0-alpha.18',
    supportedVersions: Object.freeze(['0.144.3', '0.145.0-alpha.18']),
  });
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return output;
  } finally {
    process.stdout.write = original;
  }
}
