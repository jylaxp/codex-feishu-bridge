import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNodeSupportContract } from '../../scripts/node-support-contract.mjs';

const coherentContract = Object.freeze({
  minNodeVersion: '20.17.0',
  maxNodeMajorExclusive: 27,
  packageEngine: '>=20.17.0 <27',
  packageLockEngine: '>=20.17.0 <27',
});

test('accepts matching runtime and npm Node support contracts', () => {
  assert.equal(assertNodeSupportContract(coherentContract), '>=20.17.0 <27');
});

test('rejects a package manifest that drifts from the runtime contract', () => {
  assert.throws(
    () => assertNodeSupportContract({
      ...coherentContract,
      packageEngine: '>=20.17.0 <25',
    }),
    /package\.json engines\.node=">=20\.17\.0 <25"/,
  );
});

test('rejects a root lockfile entry that drifts from the runtime contract', () => {
  assert.throws(
    () => assertNodeSupportContract({
      ...coherentContract,
      packageLockEngine: '>=20.17.0 <21',
    }),
    /package-lock\.json root engines\.node=">=20\.17\.0 <21"/,
  );
});
