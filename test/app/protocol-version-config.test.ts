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

const schema145 = '7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c';
const schema144 = '3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7';
const schema146 = '8535b3371e916d0ea4f2bc62c28a7236323d5f37fd7652184098c90d256c738f';

test('first load seeds built-ins and later loads preserve approved versions', () => {
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
      ],
    );
    assert.deepEqual(initial.supportedVersions[2], {
      codexVersion: '0.145.0-alpha.27',
      schemaDigest: schema145,
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'builtin',
    });
    assert.deepEqual(initial.supportedVersions[3], {
      codexVersion: '0.145.0-alpha.30',
      schemaDigest: schema145,
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'builtin',
    });
    assert.deepEqual(initial.supportedVersions[4], {
      codexVersion: '0.146.0-alpha.3',
      schemaDigest: schema146,
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      source: 'builtin',
    });
    assert.equal(initial.lastDetection, null);

    const candidate = detection('0.145.0-alpha.19', schema145, 'upgrade_available');
    store.recordDetection(candidate);
    store.approveCompatibleVersion(candidate);

    const reloaded = new ProtocolVersionConfigStore(root).loadOrCreate();
    assert.deepEqual(
      reloaded.supportedVersions.map((entry) => entry.codexVersion),
      [
        '0.144.3',
        '0.145.0-alpha.18',
        '0.145.0-alpha.27',
        '0.145.0-alpha.30',
        '0.146.0-alpha.3',
        '0.145.0-alpha.19',
      ],
    );
    assert.equal(reloaded.supportedVersions[5]?.source, 'approved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing catalogs gain newly shipped built-ins without replacing approved entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-upgrade-'));
  try {
    const filePath = join(root, 'protocol-versions.json');
    writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      supportedVersions: [
        {
          codexVersion: '0.144.3',
          schemaDigest: schema144,
          adapterProfileId: 'app-server-0.144.3',
          source: 'builtin',
        },
        {
          codexVersion: '0.145.0-alpha.18',
          schemaDigest: schema145,
          adapterProfileId: 'app-server-0.145.0-alpha.18',
          source: 'approved',
        },
        {
          codexVersion: '0.145.0-alpha.19',
          schemaDigest: schema145,
          adapterProfileId: 'app-server-0.145.0-alpha.18',
          source: 'approved',
        },
      ],
      lastDetection: null,
    }, null, 2)}\n`);

    const upgraded = new ProtocolVersionConfigStore(root).loadOrCreate();

    assert.deepEqual(
      upgraded.supportedVersions.map((entry) => [entry.codexVersion, entry.source]),
      [
        ['0.144.3', 'builtin'],
        ['0.145.0-alpha.18', 'approved'],
        ['0.145.0-alpha.19', 'approved'],
        ['0.145.0-alpha.27', 'builtin'],
        ['0.145.0-alpha.30', 'builtin'],
        ['0.146.0-alpha.3', 'builtin'],
      ],
    );
    assert.equal(
      assessProtocolCompatibility(upgraded.supportedVersions, '0.145.0-alpha.27', schema145).status,
      'supported',
    );
    assert.equal(
      assessProtocolCompatibility(upgraded.supportedVersions, '0.145.0-alpha.30', schema145).status,
      'supported',
    );
    assert.equal(
      assessProtocolCompatibility(upgraded.supportedVersions, '0.145.0-alpha.28', schema145).status,
      'upgrade_available',
    );
    assert.equal(
      assessProtocolCompatibility(upgraded.supportedVersions, '0.146.0-alpha.3', schema146).status,
      'supported',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')),
      upgraded,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale detection writers preserve versions approved by another store', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-protocol-versions-race-'));
  try {
    const staleStore = new ProtocolVersionConfigStore(root);
    staleStore.loadOrCreate();
    const approvingStore = new ProtocolVersionConfigStore(root);
    const candidate = detection('0.145.0-alpha.19', schema145, 'upgrade_available');

    approvingStore.recordDetection(candidate);
    approvingStore.approveCompatibleVersion(candidate);
    staleStore.recordDetection(detection('0.144.3', schema144, 'incompatible'));

    const reloaded = new ProtocolVersionConfigStore(root).loadOrCreate();
    assert.deepEqual(
      reloaded.supportedVersions.map((entry) => entry.codexVersion),
      [
        '0.144.3',
        '0.145.0-alpha.18',
        '0.145.0-alpha.27',
        '0.145.0-alpha.30',
        '0.146.0-alpha.3',
        '0.145.0-alpha.19',
      ],
    );
    assert.equal(reloaded.lastDetection?.compatibility.status, 'supported');
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
      () => store.recordDetection(detection('0.144.3', schema144, 'supported')),
      /already owns this data directory/,
    );
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('compatibility distinguishes supported, compatible upgrade, and incompatible protocols', () => {
  const supported = builtInProtocolVersionConfig().supportedVersions;

  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.145.0-alpha.18', schema145),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[1],
    },
  );
  assert.equal(
    assessProtocolCompatibility(supported, '0.145.0-alpha.19', schema145).status,
    'upgrade_available',
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.145.0-alpha.27', schema145),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[2],
    },
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.145.0-alpha.30', schema145),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[3],
    },
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.146.0-alpha.3', schema146),
    {
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: 'app-server-0.145.0-alpha.18',
      matchedVersion: supported[4],
    },
  );
  assert.deepEqual(
    assessProtocolCompatibility(supported, '0.145.0-alpha.18', 'a'.repeat(64)),
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
        schemaDigest: schema145,
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
  schemaDigest: string,
  status: 'supported' | 'upgrade_available' | 'incompatible',
): RuntimeVersionDetection {
  return Object.freeze({
    checkedAt: '2026-07-19T08:33:48.000Z',
    codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexVersion,
    binarySha256: 'b'.repeat(64),
    schemaDigest,
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
