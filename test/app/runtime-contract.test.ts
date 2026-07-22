import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import type { BridgeConfig } from '../../src/app/domain';
import {
  APP_SERVER_PROTOCOL_PROFILES,
  APP_SERVER_PROTOCOL_PROFILE_0_144_3,
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  parseCodexCliVersion,
} from '../../src/app/codex/app-server-protocol-registry';
import {
  assertCompatibleCodexRuntime,
  CodexRuntimeCompatibilityError,
  digestJsonSchemaDirectory,
  inspectCodexCompatibility,
  verifyCodexRuntimeContract,
} from '../../src/app/codex/runtime-contract';
import { builtInProtocolVersionConfig } from '../../src/app/codex/protocol-version-config';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(__dirname, '../../..');
const fixtureRoot = join(
  projectRoot,
  'test/fixtures/app-server/0.145.0-alpha.18',
);
const fixture144Root = join(projectRoot, 'test/fixtures/app-server/0.144.3');
const captureScript = join(projectRoot, 'scripts/capture-app-server-contract.mjs');
const codex145Bin = process.env.CODEX_145_BIN
  ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
const codex144Bin = process.env.CODEX_144_BIN;
const schemaFilesByMethod = Object.freeze({
  'thread/list': ['v2/ThreadListParams.json', 'v2/ThreadListResponse.json'],
  'thread/read': ['v2/ThreadReadParams.json', 'v2/ThreadReadResponse.json'],
  'thread/resume': ['v2/ThreadResumeParams.json', 'v2/ThreadResumeResponse.json'],
  'thread/start': ['v2/ThreadStartParams.json', 'v2/ThreadStartResponse.json'],
  'thread/fork': ['v2/ThreadForkParams.json', 'v2/ThreadForkResponse.json'],
  'thread/name/set': ['v2/ThreadSetNameParams.json', 'v2/ThreadSetNameResponse.json'],
  'thread/archive': ['v2/ThreadArchiveParams.json', 'v2/ThreadArchiveResponse.json'],
  'thread/goal/get': ['v2/ThreadGoalGetParams.json', 'v2/ThreadGoalGetResponse.json'],
  'thread/goal/set': ['v2/ThreadGoalSetParams.json', 'v2/ThreadGoalSetResponse.json'],
  'thread/goal/clear': ['v2/ThreadGoalClearParams.json', 'v2/ThreadGoalClearResponse.json'],
  'thread/compact/start': [
    'v2/ThreadCompactStartParams.json',
    'v2/ThreadCompactStartResponse.json',
  ],
  'skills/list': ['v2/SkillsListParams.json', 'v2/SkillsListResponse.json'],
  'mcpServerStatus/list': [
    'v2/ListMcpServerStatusParams.json',
    'v2/ListMcpServerStatusResponse.json',
  ],
  'account/rateLimits/read': [null, 'v2/GetAccountRateLimitsResponse.json'],
  'turn/start': ['v2/TurnStartParams.json', 'v2/TurnStartResponse.json'],
} as const);

test('schema digest ignores JSON object key order', () => {
  withTemporaryDirectory((root) => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    writeJson(join(first, 'v2/Example.json'), { z: 1, nested: { b: 2, a: 1 } });
    writeJson(join(second, 'v2/Example.json'), { nested: { a: 1, b: 2 }, z: 1 });

    assert.equal(digestJsonSchemaDirectory(first), digestJsonSchemaDirectory(second));
  });
});

test('schema digest changes when path, file set, or field content changes', () => {
  withTemporaryDirectory((root) => {
    const baseline = join(root, 'baseline');
    const changedPath = join(root, 'changed-path');
    const changedSet = join(root, 'changed-set');
    const changedField = join(root, 'changed-field');
    writeJson(join(baseline, 'v2/Example.json'), { type: 'string' });
    writeJson(join(changedPath, 'v1/Example.json'), { type: 'string' });
    writeJson(join(changedSet, 'v2/Example.json'), { type: 'string' });
    writeJson(join(changedSet, 'v2/Extra.json'), { type: 'null' });
    writeJson(join(changedField, 'v2/Example.json'), { type: 'number' });

    const digest = digestJsonSchemaDirectory(baseline);
    assert.notEqual(digest, digestJsonSchemaDirectory(changedPath));
    assert.notEqual(digest, digestJsonSchemaDirectory(changedSet));
    assert.notEqual(digest, digestJsonSchemaDirectory(changedField));
  });
});

test('145 fixture records the current full experimental schema digest', () => {
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
    readonly cliVersion: string;
    readonly schemaDigest: string;
    readonly schemaGeneration: { readonly schemaFileCount: number };
  };

  assert.equal(manifest.cliVersion, 'codex-cli 0.145.0-alpha.18');
  assert.equal(
    manifest.schemaDigest,
    '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
  );
  assert.equal(manifest.schemaGeneration.schemaFileCount, 341);
});

test('one protocol contract records multiple independently verified runtime artifacts', () => {
  const evidence = readJson(join(fixtureRoot, 'artifacts.json')) as {
    readonly protocolContractId: string;
    readonly artifacts: ReadonlyArray<{
      readonly capturedAt: string;
      readonly codexVersion: string;
      readonly binaryName: string;
      readonly binarySha256: string;
      readonly distribution: string;
      readonly appVersion: string | null;
      readonly appBuild: string | null;
    }>;
  };

  assert.equal(evidence.protocolContractId, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.id);
  assert.deepEqual(
    evidence.artifacts.map((artifact) => artifact.codexVersion),
    [
      '0.145.0-alpha.18',
      '0.145.0-alpha.18',
      '0.145.0-alpha.27',
      '0.145.0-alpha.30',
    ],
  );
  assert.deepEqual(
    evidence.artifacts.map((artifact) => artifact.appBuild),
    [null, '5551', '5650', '5702'],
  );
  assert.equal(new Set(evidence.artifacts.map((artifact) => artifact.binarySha256)).size, 4);
  assert.deepEqual(evidence.artifacts[2], {
    capturedAt: '2026-07-22T00:46:59Z',
    codexVersion: '0.145.0-alpha.27',
    binaryName: 'codex',
    binarySha256: 'd1c9c5d262c2cc2c58a0f330a82e16316397cc371736ff39fe5856dd1fe0227f',
    distribution: 'ChatGPT.app',
    appVersion: '26.715.70719',
    appBuild: '5650',
  });
  assert.deepEqual(evidence.artifacts[3], {
    capturedAt: '2026-07-22T05:00:28Z',
    codexVersion: '0.145.0-alpha.30',
    binaryName: 'codex',
    binarySha256: '9de41fd67ac24873dd7852160536cff004633f76f224fed602654457da27db02',
    distribution: 'ChatGPT.app',
    appVersion: '26.715.71837',
    appBuild: '5702',
  });
});

test('144 fixture records exact binary provenance and full experimental schema digest', () => {
  const manifest = JSON.parse(readFileSync(join(fixture144Root, 'manifest.json'), 'utf8')) as {
    readonly cliVersion: string;
    readonly schemaDigest: string;
    readonly schemaGeneration: { readonly schemaFileCount: number };
    readonly source: { readonly binarySha256: string; readonly distribution: string };
    readonly handshake: { readonly userAgent: string };
  };

  assert.equal(manifest.cliVersion, 'codex-cli 0.144.3');
  assert.equal(
    manifest.schemaDigest,
    '3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7',
  );
  assert.equal(manifest.schemaGeneration.schemaFileCount, 337);
  assert.equal(
    manifest.source.binarySha256,
    '718724d7221cf1298071ca92411cb74caa8422809154150cedca7b569a4518e3',
  );
  assert.match(manifest.source.distribution, /@openai\/codex@0\.144\.3/);
  assert.match(manifest.handshake.userAgent, /\/0\.144\.3 /);
});

test('recorded 144/145 method comparison matches schemas generated by both binaries', async (t) => {
  if (codex144Bin === undefined || !existsSync(codex144Bin) || !existsSync(codex145Bin)) {
    t.skip('CODEX_144_BIN and CODEX_145_BIN are required for schema comparison');
    return;
  }
  await withTemporaryDirectoryAsync(async (root) => {
    const schema144 = join(root, 'schema-144');
    const schema145 = join(root, 'schema-145');
    const codexHome = join(root, 'codex-home');
    mkdirSync(codexHome);
    const options = {
      env: { ...process.env, HOME: root, CODEX_HOME: codexHome, TMPDIR: root },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    };
    await execFileAsync(codex144Bin, [
      'app-server', 'generate-json-schema', '--experimental', '--out', schema144,
    ], options);
    await execFileAsync(codex145Bin, [
      'app-server', 'generate-json-schema', '--experimental', '--out', schema145,
    ], options);

    assert.equal(
      digestJsonSchemaDirectory(schema144),
      APP_SERVER_PROTOCOL_PROFILE_0_144_3.schemaDigest,
    );
    assert.equal(
      digestJsonSchemaDirectory(schema145),
      APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest,
    );
    const comparison = readJson(join(fixture144Root, 'schema-comparison.json')) as {
      readonly result: { readonly consumedResponseFieldsChanged: readonly string[] };
      readonly methods: Readonly<Record<string, {
        readonly params: string;
        readonly response: string;
      }>>;
    };
    assert.deepEqual(comparison.result.consumedResponseFieldsChanged, []);
    assert.deepEqual(Object.keys(comparison.methods).sort(), Object.keys(schemaFilesByMethod).sort());
    for (const [method, [paramsFile, responseFile]] of Object.entries(schemaFilesByMethod)) {
      const expected = comparison.methods[method];
      assert.ok(expected, method);
      const paramsEqual = paramsFile === null
        || schemasEqual(schema144, schema145, paramsFile);
      assert.equal(paramsEqual, expected.params === 'identical', `${method} params`);
      assert.equal(
        schemasEqual(schema144, schema145, responseFile),
        expected.response === 'identical',
        `${method} response`,
      );
    }
  });
});

test('runtime contract selects the exact stable 0.144.3 profile', () => {
  const profile = assertCompatibleCodexRuntime(
    'codex-cli 0.144.3',
    '3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7',
  );

  assert.equal(profile, APP_SERVER_PROTOCOL_PROFILE_0_144_3);
});

test('protocol profile registry and its entries are immutable', () => {
  assert.equal(Object.isFrozen(APP_SERVER_PROTOCOL_PROFILES), true);
  assert.deepEqual(
    APP_SERVER_PROTOCOL_PROFILES.map((profile) => {
      assert.equal(Object.isFrozen(profile), true);
      return profile.id;
    }),
    ['app-server-0.144.3', 'app-server-0.145.0-alpha.18'],
  );
});

test('runtime contract selects the exact 0.145.0-alpha.18 profile', () => {
  const profile = assertCompatibleCodexRuntime(
    'codex-cli 0.145.0-alpha.18',
    '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
  );

  assert.equal(profile, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18);
});

test('runtime contract selects built-in 145 aliases through the base adapter', () => {
  const schemaDigest = '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c';
  for (const codexVersion of ['0.145.0-alpha.27', '0.145.0-alpha.30']) {
    const profile = assertCompatibleCodexRuntime(`codex-cli ${codexVersion}`, schemaDigest);

    assert.equal(profile.id, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.id);
    assert.equal(profile.codexVersion, codexVersion);
    assert.equal(profile.schemaDigest, schemaDigest);
  }
});

test('runtime verification reports and cleans up the selected profile', async (t) => {
  if (!existsSync(codex145Bin)) {
    t.skip('ChatGPT bundled Codex binary is not installed');
    return;
  }
  await withTemporaryDirectoryAsync(async (root) => {
    const temporaryRoot = join(root, 'runtime');
    mkdirSync(temporaryRoot);
    const versionResult = await execFileAsync(codex145Bin, ['--version'], {
      env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'codex-home'), TMPDIR: root },
    });
    const expectedCodexVersion = parseCodexCliVersion(versionResult.stdout.trim()).version;
    assert.equal(
      builtInProtocolVersionConfig().supportedVersions.some(
        (entry) => entry.codexVersion === expectedCodexVersion,
      ),
      true,
    );

    const report = await verifyCodexRuntimeContract(
      minimalConfig(codex145Bin, root),
      { PATH: process.env.PATH },
      temporaryRoot,
    );

    assert.equal(report.codexVersion, `codex-cli ${expectedCodexVersion}`);
    assert.equal(report.protocolProfile.id, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.id);
    assert.equal(report.protocolProfile.codexVersion, expectedCodexVersion);
    assert.equal(report.schemaDigest, report.protocolProfile.schemaDigest);
    assert.equal(report.runtimeArtifact.protocolContractId, report.protocolProfile.id);
    assert.match(report.runtimeArtifact.binarySha256, /^[a-f0-9]{64}$/);
    const versionConfig = readJson(join(root, 'config', 'protocol-versions.json')) as {
      readonly supportedVersions: readonly { readonly codexVersion: string }[];
      readonly lastDetection: {
        readonly codexVersion: string;
        readonly compatibility: { readonly conclusion: string; readonly status: string };
      };
    };
    assert.deepEqual(
      versionConfig.supportedVersions.map((entry) => entry.codexVersion),
      ['0.144.3', '0.145.0-alpha.18', '0.145.0-alpha.27', '0.145.0-alpha.30'],
    );
    assert.equal(versionConfig.lastDetection.codexVersion, expectedCodexVersion);
    assert.deepEqual(
      versionConfig.lastDetection.compatibility,
      {
        conclusion: '兼容',
        status: 'supported',
        adapterProfileId: 'app-server-0.145.0-alpha.18',
      },
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);
  });
});

test('compatible exact-version upgrade requires approval and persists across startup', async () => {
  await withTemporaryDirectoryAsync(async (root) => {
    const codexCwd = join(root, 'workspace');
    const configHome = join(root, 'config');
    const temporaryRoot = join(root, 'runtime');
    mkdirSync(codexCwd);
    mkdirSync(configHome);
    mkdirSync(temporaryRoot);
    const schemaValue = { type: 'string', title: 'Hermetic protocol schema' };
    const schemaRoot = join(root, 'expected-schema');
    writeJson(join(schemaRoot, 'v2/Fake.json'), schemaValue);
    const schemaDigest = digestJsonSchemaDirectory(schemaRoot);
    const candidateBinary = createVersionedFakeCodex(
      root,
      '0.145.0-alpha.19',
      schemaValue,
      'candidate',
    );
    writeJson(join(configHome, 'protocol-versions.json'), {
      schemaVersion: 1,
      supportedVersions: [{
        codexVersion: '0.145.0-alpha.18',
        schemaDigest,
        adapterProfileId: 'app-server-0.145.0-alpha.18',
        source: 'approved',
      }],
      lastDetection: null,
    });
    const probe = { codexBin: candidateBinary, codexCwd, configHome };
    const config = { ...minimalConfig(candidateBinary, codexCwd), configHome };
    const env = { PATH: process.env.PATH };

    await assert.rejects(
      verifyCodexRuntimeContract(config, env, temporaryRoot),
      (error: unknown) => error instanceof CodexRuntimeCompatibilityError
        && error.status === 'upgrade_available',
    );

    const approved = await inspectCodexCompatibility(
      probe,
      env,
      temporaryRoot,
      { approve: true },
    );
    assert.equal(approved.assessment.status, 'supported');
    assert.equal(approved.config.supportedVersions.at(-1)?.codexVersion, '0.145.0-alpha.19');

    const freshStore = readJson(join(configHome, 'protocol-versions.json')) as {
      readonly supportedVersions: readonly { readonly codexVersion: string }[];
    };
    assert.equal(freshStore.supportedVersions.at(-1)?.codexVersion, '0.145.0-alpha.19');
    const accepted = await verifyCodexRuntimeContract(config, env, temporaryRoot);
    assert.equal(accepted.codexVersion, 'codex-cli 0.145.0-alpha.19');

    const incompatibleBinary = createVersionedFakeCodex(
      root,
      '0.145.0-alpha.20',
      { type: 'number', title: 'Unknown protocol schema' },
      'incompatible',
    );
    const rejected = await inspectCodexCompatibility(
      { codexBin: incompatibleBinary, codexCwd, configHome },
      env,
      temporaryRoot,
      { approve: true },
    );
    assert.equal(rejected.assessment.status, 'incompatible');
    assert.equal(
      rejected.config.supportedVersions.some((entry) => entry.codexVersion === '0.145.0-alpha.20'),
      false,
    );
  });
});

test('Codex CLI version parser supports SemVer prerelease and build metadata', () => {
  assert.deepEqual(
    parseCodexCliVersion('codex-cli 0.145.0-alpha.19+chatgpt.arm64'),
    {
      cliOutput: 'codex-cli 0.145.0-alpha.19+chatgpt.arm64',
      version: '0.145.0-alpha.19+chatgpt.arm64',
      major: 0,
      minor: 145,
      patch: 0,
      prerelease: Object.freeze(['alpha', '19']),
      build: Object.freeze(['chatgpt', 'arm64']),
    },
  );
});

test('legal but unregistered prerelease version is rejected', () => {
  assert.throws(
    () => assertCompatibleCodexRuntime(
      'codex-cli 0.145.0-alpha.19+chatgpt.arm64',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
    /protocol profile is unsupported/,
  );
});

test('malformed Codex CLI version output is rejected', () => {
  for (const output of [
    '',
    'codex-cli 0.145',
    'codex-cli 0.145.0-01',
    'codex-cli 00.145.0',
    'other-cli 0.145.0-alpha.18',
    'codex-cli 0.145.0-alpha.18 extra',
  ]) {
    assert.throws(
      () => assertCompatibleCodexRuntime(
        output,
        '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
      ),
      /version response is invalid/,
      output,
    );
  }
});

test('known version with unknown schema digest is rejected', () => {
  assert.throws(
    () => assertCompatibleCodexRuntime(
      'codex-cli 0.145.0-alpha.18',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
    /schema digest does not match/,
  );
});

test('known schema digest with unknown version is rejected', () => {
  assert.throws(
    () => assertCompatibleCodexRuntime(
      'codex-cli 0.145.0-alpha.19',
      '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
    ),
    /version does not match/,
  );
});

test('cross-matched registered version and schema digest are rejected', () => {
  assert.throws(
    () => assertCompatibleCodexRuntime(
      'codex-cli 0.144.3',
      '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
    ),
    /identify different supported profiles/,
  );
});

test('runtime verification cleans generated schema after invalid JSON', async () => {
  await withTemporaryDirectoryAsync(async (root) => {
    const binary = createFakeCodex(root, 'invalid-json');
    const temporaryRoot = join(root, 'runtime');
    mkdirSync(temporaryRoot);

    await assert.rejects(
      verifyCodexRuntimeContract(
        minimalConfig(binary, root),
        { PATH: process.env.PATH },
        temporaryRoot,
      ),
      /Unexpected token|JSON/,
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);
  });
});

test('capture reports CLI, missing schema, invalid JSON, and timeout failures cleanly', async () => {
  for (const scenario of ['cli-failure', 'missing-schema', 'invalid-json', 'timeout'] as const) {
    await withTemporaryDirectoryAsync(async (root) => {
      const binary = createFakeCodex(root, scenario);
      const output = join(root, 'fixture');
      const timeoutMs = scenario === 'timeout' ? '30' : '1000';
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [
            captureScript,
            '--codex-bin', binary,
            '--out', output,
            '--timeout-ms', timeoutMs,
          ],
          { env: { ...process.env, TMPDIR: root } },
        ),
        (error: unknown) => {
          assert.match(errorText(error), /contract capture failed:/);
          return true;
        },
      );
      assert.equal(existsSync(output), false);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith('codex-app-server-contract-')),
        false,
      );
    });
  }
});

test('capture requires exact matching SemVer identities from CLI and userAgent', async () => {
  const rejected = [
    {
      cli: 'codex-cli 0.144.3',
      userAgent: 'capture/0.144.30 (Mac OS 15.6.1; arm64)',
    },
    {
      cli: 'codex-cli 0.144.3',
      userAgent: 'capture/0.144.3-evil (Mac OS 15.6.1; arm64)',
    },
    {
      cli: 'codex-cli 0.144.3 extra',
      userAgent: null,
    },
    {
      cli: 'codex-cli 0.144.3',
      userAgent: 'malformed user agent 0.144.3',
    },
    {
      cli: 'codex-cli 0.145.0-alpha.01',
      userAgent: null,
    },
  ] as const;
  for (const candidate of rejected) {
    await withTemporaryDirectoryAsync(async (root) => {
      const binary = createSuccessfulCaptureCodex(root, candidate.cli);
      const output = join(root, 'fixture');
      const args = [captureScript, '--codex-bin', binary, '--out', output];
      if (candidate.userAgent !== null) {
        args.push('--server-user-agent', candidate.userAgent);
      }
      await assert.rejects(
        execFileAsync(process.execPath, args),
        (error: unknown) => {
          assert.match(errorText(error), /exact SemVer identity|does not attest/);
          return true;
        },
        `${candidate.cli} / ${candidate.userAgent}`,
      );
      assert.equal(existsSync(output), false);
    });
  }

  await withTemporaryDirectoryAsync(async (root) => {
    const cli = 'codex-cli 0.145.0-alpha.18+chatgpt.arm64';
    const binary = createSuccessfulCaptureCodex(root, cli);
    const output = join(root, 'fixture');
    await execFileAsync(process.execPath, [
      captureScript,
      '--codex-bin', binary,
      '--out', output,
      '--server-user-agent',
      'capture/0.145.0-alpha.18+chatgpt.arm64 (Mac OS 15.6.1; arm64)',
    ]);
    const manifest = readJson(join(output, 'manifest.json')) as {
      readonly profileId: string;
    };
    assert.equal(manifest.profileId, 'app-server-0.145.0-alpha.18+chatgpt.arm64');
  });
});

test('bundled supported 145 binary reproduces the committed protocol contract', async (t) => {
  if (!existsSync(codex145Bin)) {
    t.skip('ChatGPT bundled Codex binary is not installed');
    return;
  }
  await withTemporaryDirectoryAsync(async (root) => {
    const versionResult = await execFileAsync(codex145Bin, ['--version'], {
      env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'codex-home'), TMPDIR: root },
    });
    const cliVersion = versionResult.stdout.trim();
    const codexVersion = parseCodexCliVersion(cliVersion).version;
    assert.equal(
      builtInProtocolVersionConfig().supportedVersions.some(
        (entry) => entry.codexVersion === codexVersion,
      ),
      true,
    );
    const output = join(root, 'fixture');
    await execFileAsync(process.execPath, [
      captureScript,
      '--codex-bin', codex145Bin,
      '--out', output,
      '--captured-at', '2026-07-17T23:06:52Z',
      '--distribution', 'ChatGPT.app',
      '--server-user-agent',
      `Codex Desktop/${codexVersion} (Mac OS 15.6.1; arm64) `
        + 'dumb (bridge_contract_capture; 2.0.0)',
    ]);
    const expectedManifest = JSON.parse(
      readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const actualManifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const expectedMessages = JSON.parse(
      readFileSync(join(fixtureRoot, 'representative-messages.json'), 'utf8'),
    ) as RepresentativeMessages;
    const actualMessages = JSON.parse(
      readFileSync(join(output, 'representative-messages.json'), 'utf8'),
    ) as RepresentativeMessages;
    assert.equal(actualManifest.profileId, `app-server-${codexVersion}`);
    assert.equal(actualManifest.cliVersion, cliVersion);
    assert.equal(actualManifest.schemaDigest, expectedManifest.schemaDigest);
    assert.deepEqual(actualManifest.schemaGeneration, expectedManifest.schemaGeneration);
    assert.deepEqual(actualManifest.evidence, expectedManifest.evidence);
    assert.match(actualMessages.initializeResponse.result.userAgent, new RegExp(`/${codexVersion} `));
    assert.equal(actualMessages.threadListResponse.result.data[0]?.cliVersion, codexVersion);
    assert.deepEqual(
      withoutRepresentativeRuntimeIdentity(actualMessages),
      withoutRepresentativeRuntimeIdentity(expectedMessages),
    );
  });
});

interface RepresentativeMessages {
  readonly initializeResponse: {
    readonly result: { readonly userAgent: string };
  };
  readonly threadListResponse: {
    readonly result: { readonly data: ReadonlyArray<{ readonly cliVersion: string }> };
  };
  readonly [key: string]: unknown;
}

function withoutRepresentativeRuntimeIdentity(value: RepresentativeMessages): unknown {
  const comparable = structuredClone(value) as {
    initializeResponse: { result: { userAgent: string } };
    threadListResponse: { result: { data: Array<{ cliVersion: string }> } };
  } & Record<string, unknown>;
  comparable.initializeResponse.result.userAgent = '<runtime-user-agent>';
  if (comparable.threadListResponse.result.data[0] !== undefined) {
    comparable.threadListResponse.result.data[0].cliVersion = '<runtime-cli-version>';
  }
  return comparable;
}

function createFakeCodex(
  root: string,
  scenario: 'cli-failure' | 'missing-schema' | 'invalid-json' | 'timeout',
): string {
  const filePath = join(root, `fake-codex-${scenario}.mjs`);
  const source = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario = ${JSON.stringify(scenario)};
if (scenario === 'cli-failure') process.exit(7);
if (scenario === 'timeout') await new Promise((resolve) => setTimeout(resolve, 5_000));
if (process.argv[2] === '--version') {
  console.log('codex-cli 0.145.0-alpha.18');
  process.exit(0);
}
const output = process.argv[process.argv.indexOf('--out') + 1];
if (scenario !== 'missing-schema') mkdirSync(output, { recursive: true });
if (scenario === 'invalid-json') writeFileSync(join(output, 'Broken.json'), '{');
`;
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
  return filePath;
}

function createSuccessfulCaptureCodex(root: string, cliOutput: string): string {
  const manifest = readJson(join(fixtureRoot, 'manifest.json')) as {
    readonly evidence: { readonly schemaFiles: readonly string[] };
  };
  const filePath = join(root, 'fake-codex-capture.mjs');
  const source = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cliOutput = ${JSON.stringify(cliOutput)};
const schemaFiles = ${JSON.stringify(manifest.evidence.schemaFiles)};
if (process.argv[2] === '--version') {
  console.log(cliOutput);
  process.exit(0);
}
const output = process.argv[process.argv.indexOf('--out') + 1];
for (const relativePath of schemaFiles) {
  const filePath = join(output, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '{}');
}
`;
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
  return filePath;
}

function createVersionedFakeCodex(
  root: string,
  version: string,
  schemaValue: unknown,
  name: string,
): string {
  const filePath = join(root, `fake-codex-${name}.mjs`);
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

function minimalConfig(codexBin: string, codexCwd: string): BridgeConfig {
  return { codexBin, codexCwd, configHome: join(codexCwd, 'config') } as BridgeConfig;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function schemasEqual(leftRoot: string, rightRoot: string, relativePath: string): boolean {
  try {
    assert.deepEqual(readJson(join(leftRoot, relativePath)), readJson(join(rightRoot, relativePath)));
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const stderr = 'stderr' in error ? String(error.stderr) : '';
  const message = 'message' in error ? String(error.message) : '';
  return `${message}\n${stderr}`;
}

function withTemporaryDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-contract-test-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTemporaryDirectoryAsync(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-contract-test-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
