import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimePackageFiles,
  deriveRequiredPackagePaths,
  isAllowedRuntimePackagePath,
  parsePackResult,
} from '../../scripts/package-contract.mjs';

const packageManifest = Object.freeze({
  main: 'dist/app/main.js',
  bin: {
    bridge: './dist/app/cli.js',
  },
});

const completePackageFiles = Object.freeze([
  { path: '.env.example' },
  { path: 'README.md' },
  { path: 'dist/app/cli.js' },
  { path: 'dist/app/main.js' },
  { path: 'dist/app/runtime/module.js' },
  { path: 'package.json' },
]);

test('parses one well-formed npm pack result', () => {
  const result = parsePackResult(JSON.stringify([{ files: completePackageFiles }]));
  assert.deepEqual(result.files, completePackageFiles);
});

test('rejects malformed npm pack output', () => {
  assert.throws(() => parsePackResult('not-json'), /npm pack returned invalid JSON/);
  assert.throws(() => parsePackResult(JSON.stringify([])), /npm pack returned an unexpected result/);
  assert.throws(
    () => parsePackResult(JSON.stringify([{ files: [{ size: 12 }] }])),
    /npm pack returned an invalid file entry/,
  );
});

test('derives required main and bin paths from package metadata', () => {
  assert.deepEqual(
    [...deriveRequiredPackagePaths({
      main: './dist/app/main.js',
      bin: {
        bridge: './dist/app/cli.js',
        helper: 'dist/app/helper.js',
      },
    })].sort(),
    [
      '.env.example',
      'README.md',
      'dist/app/cli.js',
      'dist/app/helper.js',
      'dist/app/main.js',
      'package.json',
    ],
  );

  assert.deepEqual(
    [...deriveRequiredPackagePaths({
      main: 'dist/app/main.js',
      bin: './dist/app/cli.js',
    })].sort(),
    [
      '.env.example',
      'README.md',
      'dist/app/cli.js',
      'dist/app/main.js',
      'package.json',
    ],
  );
});

test('rejects malformed package entrypoint metadata', () => {
  assert.throws(
    () => deriveRequiredPackagePaths({ bin: './dist/app/cli.js' }),
    /package.json main must be a non-empty string/,
  );
  assert.throws(
    () => deriveRequiredPackagePaths({ main: 'dist/app/main.js', bin: ['dist/app/cli.js'] }),
    /package.json bin must be a string or an object of strings/,
  );
  assert.throws(
    () => deriveRequiredPackagePaths({ main: 'dist/app/main.js', bin: { bridge: '../cli.js' } }),
    /package.json bin.bridge must be a normalized package-relative path/,
  );
  assert.throws(
    () => deriveRequiredPackagePaths({ main: 'README.md' }),
    /package.json main must refer to an allowed runtime JavaScript file/,
  );
});

test('allows normal runtime modules and rejects test-style JavaScript paths', () => {
  assert.equal(isAllowedRuntimePackagePath('dist/app/main.js'), true);
  assert.equal(isAllowedRuntimePackagePath('dist/app/codex/client.js'), true);

  const forbiddenPaths = [
    'dist/app/test/helper.js',
    'dist/app/tests/helper.js',
    'dist/app/__tests__/helper.js',
    'dist/app/test.js',
    'dist/app/spec.js',
    'dist/app/client.test.js',
    'dist/app/client.spec.js',
    'dist/app/../client.js',
  ];
  for (const packagePath of forbiddenPaths) {
    assert.equal(isAllowedRuntimePackagePath(packagePath), false, packagePath);
  }
});

test('rejects a test-style JavaScript file in npm pack output', () => {
  assert.throws(
    () => assertRuntimePackageFiles({
      files: [...completePackageFiles, { path: 'dist/app/test/helper.js' }],
      packageManifest,
      builtRuntimeFiles: [
        'dist/app/cli.js',
        'dist/app/main.js',
        'dist/app/runtime/module.js',
      ],
    }),
    /npm package contains a non-runtime file: dist\/app\/test\/helper.js/,
  );
});

test('rejects a built runtime module omitted from npm pack output', () => {
  assert.throws(
    () => assertRuntimePackageFiles({
      files: completePackageFiles.filter((entry) => entry.path !== 'dist/app/runtime/module.js'),
      packageManifest,
      builtRuntimeFiles: [
        'dist/app/cli.js',
        'dist/app/main.js',
        'dist/app/runtime/module.js',
      ],
    }),
    /npm package is missing built runtime files: dist\/app\/runtime\/module.js/,
  );
});

test('requires every entrypoint derived from package metadata', () => {
  assert.throws(
    () => assertRuntimePackageFiles({
      files: completePackageFiles.filter((entry) => entry.path !== 'dist/app/cli.js'),
      packageManifest,
      builtRuntimeFiles: [
        'dist/app/main.js',
        'dist/app/runtime/module.js',
      ],
    }),
    /npm package is missing required files: dist\/app\/cli.js/,
  );
});

test('accepts a package containing all runtime modules and public entrypoints', () => {
  assert.doesNotThrow(() => assertRuntimePackageFiles({
    files: completePackageFiles,
    packageManifest,
    builtRuntimeFiles: [
      'dist/app/cli.js',
      'dist/app/main.js',
      'dist/app/runtime/module.js',
    ],
  }));
});
