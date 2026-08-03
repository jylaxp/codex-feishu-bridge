import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assessProtocolCompatibility,
  builtInProtocolVersionConfig,
  ProtocolVersionConfigStore,
  type RuntimeVersionDetection,
} from '../../src/app/codex/protocol-version-config';
import { BridgeProcessLock } from '../../src/app/process-lock';

test('first load seeds built-ins and protocol smoke can add an unknown version', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-'));
  try {
    const store = new ProtocolVersionConfigStore(root);
    const initial = store.loadOrCreate();
    assert.deepEqual(
      initial.supportedVersions.map((entry) => entry.codexVersion),
      [
        '0.144.3',
        '0.145.0-alpha.18',
        '0.145.0-alpha.27',
        '0.145.0-alpha.30',
        '0.146.0-alpha.3',
        '0.146.0-alpha.3.1',
      ],
    );
    assert.deepEqual(initial.supportedVersions[2], {
      codexVersion: '0.145.0-alpha.27',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'builtin',
    });
    assert.deepEqual(initial.supportedVersions[5], {
      codexVersion: '0.146.0-alpha.3.1',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'builtin',
    });
    assert.equal(initial.lastDetection, null);

    const candidate = detection('0.146.0-alpha.9.2', 'incompatible');
    store.recordDetection(candidate);
    store.approveProtocolSmokeVersion(candidate, 'app-server-0.145.0-alpha.18');

    const reloaded = new ProtocolVersionConfigStore(root).loadOrCreate();
    assert.deepEqual(reloaded.supportedVersions.at(-1), {
      codexVersion: '0.146.0-alpha.9.2',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'auto_smoke',
    });
    assert.equal(reloaded.lastDetection?.compatibility.status, 'supported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing catalogs ignore legacy schema digests and gain newly shipped built-ins', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-upgrade-'));
  try {
    const filePath = join(root, 'protocol-versions.json');
    writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      supportedVersions: [
        {
          codexVersion: '0.144.3',
          schemaDigest: '3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7',
          adapterProfileId: 'app-server-0.144.3',
          source: 'builtin',
        },
        {
          codexVersion: '0.145.0-alpha.18',
          schemaDigest: '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
          adapterProfileId: 'app-server-0.145.0-alpha.18',
          source: 'approved',
        },
        {
          codexVersion: '0.145.0-alpha.19',
          schemaDigest: '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
          adapterProfileId: 'app-server-0.145.0-alpha.18',
          source: 'auto_smoke',
        },
      ],
      lastDetection: {
        checkedAt: '2026-07-19T08:33:48.000Z',
        codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
        codexVersion: '0.145.0-alpha.28',
        binarySha256: 'b'.repeat(64),
        schemaDigest: '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c',
        chatGptApp: null,
        compatibility: {
          conclusion: '兼容',
          status: 'upgrade_available',
          adapterProfileId: 'app-server-0.145.0-alpha.18',
        },
      },
    }, null, 2)}\n`);

    const upgraded = new ProtocolVersionConfigStore(root).loadOrCreate();

    assert.deepEqual(
      upgraded.supportedVersions.map((entry) => [entry.codexVersion, entry.source]),
      [
        ['0.144.3', 'builtin'],
        ['0.145.0-alpha.18', 'approved'],
        ['0.145.0-alpha.19', 'auto_smoke'],
        ['0.145.0-alpha.27', 'builtin'],
        ['0.145.0-alpha.30', 'builtin'],
        ['0.146.0-alpha.3', 'builtin'],
        ['0.146.0-alpha.3.1', 'builtin'],
      ],
    );
    assert.deepEqual(upgraded.lastDetection?.compatibility, {
      conclusion: '不兼容',
      status: 'incompatible',
      adapterProfileId: null,
    });
    assert.equal(assessProtocolCompatibility(upgraded.supportedVersions, '0.145.0-alpha.27').status, 'supported');
    assert.equal(assessProtocolCompatibility(upgraded.supportedVersions, '0.145.0-alpha.28').status, 'incompatible');
    assert.equal(assessProtocolCompatibility(upgraded.supportedVersions, '0.146.0-alpha.3.1').status, 'supported');
    assert.doesNotMatch(readFileSync(filePath, 'utf8'), /schemaDigest|upgrade_available/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale detection writers preserve versions added by another store', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-race-'));
  try {
    const staleStore = new ProtocolVersionConfigStore(root);
    staleStore.loadOrCreate();
    const approvingStore = new ProtocolVersionConfigStore(root);
    const candidate = detection('0.146.0-alpha.9.2', 'incompatible');

    approvingStore.recordDetection(candidate);
    approvingStore.approveProtocolSmokeVersion(candidate, 'app-server-0.145.0-alpha.18');
    staleStore.recordDetection(detection('0.144.3', 'supported'));

    const reloaded = new ProtocolVersionConfigStore(root).loadOrCreate();
    assert.deepEqual(
      reloaded.supportedVersions.map((entry) => entry.codexVersion),
      [
        '0.144.3',
        '0.145.0-alpha.18',
        '0.145.0-alpha.27',
        '0.145.0-alpha.30',
        '0.146.0-alpha.3',
        '0.146.0-alpha.3.1',
        '0.146.0-alpha.9.2',
      ],
    );
    assert.equal(reloaded.lastDetection?.compatibility.status, 'supported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protocol smoke approval records one entry per Codex version', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-smoke-'));
  try {
    const store = new ProtocolVersionConfigStore(root);
    store.loadOrCreate();
    const candidate = detection('0.146.0-alpha.9.2', 'incompatible');

    const approved = store.approveProtocolSmokeVersion(
      candidate,
      'app-server-0.145.0-alpha.18',
    );
    const approvedAgain = store.approveProtocolSmokeVersion(
      candidate,
      'app-server-0.145.0-alpha.18',
    );

    assert.equal(
      approvedAgain.supportedVersions.filter(
        (entry) => entry.codexVersion === '0.146.0-alpha.9.2',
      ).length,
      1,
    );
    assert.equal(approved.supportedVersions.at(-1)?.source, 'auto_smoke');
    assert.equal(
      assessProtocolCompatibility(approved.supportedVersions, '0.146.0-alpha.9.2').status,
      'supported',
    );
    assert.deepEqual(new ProtocolVersionConfigStore(root).loadOrCreate().supportedVersions.at(-1), {
      codexVersion: '0.146.0-alpha.9.2',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'auto_smoke',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('catalog mutation fails closed while another process lock is held', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-locked-'));
  const store = new ProtocolVersionConfigStore(root);
  store.loadOrCreate();
  const lock = new BridgeProcessLock(root, { lockFileName: 'protocol-versions.lock' });
  lock.acquire();
  try {
    assert.throws(
      () => store.recordDetection(detection('0.144.3', 'supported')),
      /already owns this data directory/,
    );
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('compatibility is version-only before protocol smoke runs', () => {
  const supported = builtInProtocolVersionConfig().supportedVersions;

  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.145.0-alpha.18'),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[1],
    },
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.146.0-alpha.3.1'),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[5],
    },
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.146.0-alpha.9.2'),
    {
      conclusion: '不兼容',
      status: 'incompatible',
      adapterProfileId: null,
      matchedVersion: null,
    },
  );
});

test('invalid or empty persisted catalogs fail closed instead of restoring built-ins', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-invalid-'));
  try {
    const filePath = join(root, 'protocol-versions.json');
    writeFileSync(filePath, '{"schemaVersion":1,"supportedVersions":[],"lastDetection":null}\n');
    assert.throws(
      () => new ProtocolVersionConfigStore(root).loadOrCreate(),
      /at least one supported version/,
    );
    assert.match(readFileSync(filePath, 'utf8'), /"supportedVersions":\[\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persisted catalog rejects malformed Codex versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-malformed-'));
  try {
    writeFileSync(join(root, 'protocol-versions.json'), JSON.stringify({
      schemaVersion: 1,
      supportedVersions: [{
        codexVersion: '0.145',
        adapterProfileId: 'app-server-0.145.0-alpha.18',
        source: 'approved',
      }],
      lastDetection: null,
    }));
    assert.throws(
      () => new ProtocolVersionConfigStore(root).loadOrCreate(),
      /version response is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function detection(
  codexVersion: string,
  status: 'supported' | 'incompatible',
): RuntimeVersionDetection {
  return Object.freeze({
    checkedAt: '2026-07-19T08:33:48.000Z',
    codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexVersion,
    binarySha256: 'b'.repeat(64),
    chatGptApp: Object.freeze({
      appPath: '/Applications/ChatGPT.app',
      version: '26.715.31925',
      build: '5551',
    }),
    compatibility: Object.freeze({
      conclusion: status === 'incompatible' ? '不兼容' : '兼容',
      status,
      adapterProfileId: status === 'incompatible'
        ? null
        : 'app-server-0.145.0-alpha.18',
    }),
  });
}
