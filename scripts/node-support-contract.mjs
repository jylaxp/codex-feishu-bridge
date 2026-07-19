/**
 * Verifies that npm metadata accepts exactly the range enforced at runtime.
 */
export function assertNodeSupportContract({
  minNodeVersion,
  maxNodeMajorExclusive,
  packageEngine,
  packageLockEngine,
}) {
  if (typeof minNodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(minNodeVersion)) {
    throw new Error('Runtime MIN_NODE_VERSION must be a semantic version');
  }
  if (!Number.isInteger(maxNodeMajorExclusive) || maxNodeMajorExclusive <= 0) {
    throw new Error('Runtime MAX_NODE_MAJOR_EXCLUSIVE must be a positive integer');
  }

  const runtimeEngine = `>=${minNodeVersion} <${maxNodeMajorExclusive}`;
  const mismatches = [
    ['package.json engines.node', packageEngine],
    ['package-lock.json root engines.node', packageLockEngine],
  ].filter(([, engine]) => engine !== runtimeEngine);

  if (mismatches.length > 0) {
    const details = mismatches
      .map(([source, engine]) => `${source}=${JSON.stringify(engine)}`)
      .join(', ');
    throw new Error(`Node support contract mismatch: runtime=${runtimeEngine}; ${details}`);
  }

  return runtimeEngine;
}
