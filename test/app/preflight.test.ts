import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSupportedNodeVersion,
  PreflightError,
} from '../../src/app/preflight';

test('Node.js versions from 20.17 through 26.x are supported', () => {
  const supportedVersions = [
    '20.17.0',
    '21.0.0',
    '22.22.3',
    '23.11.1',
    '24.18.0',
    '25.6.0',
    '26.5.0',
  ];
  for (const version of supportedVersions) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
});

test('Node.js versions outside the supported range fail closed', () => {
  for (const version of ['20.16.99', '19.99.99', '27.0.0']) {
    assert.throws(
      () => assertSupportedNodeVersion(version),
      (error: unknown) => error instanceof PreflightError
        && error.message.includes('>=20.17.0 <27.0.0'),
    );
  }
});

test('malformed Node.js versions are rejected', () => {
  assert.throws(
    () => assertSupportedNodeVersion('25'),
    (error: unknown) => error instanceof PreflightError
      && error.message === 'Unsupported Node.js version format: 25',
  );
});
