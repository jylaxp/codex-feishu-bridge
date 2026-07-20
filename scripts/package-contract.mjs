const REQUIRED_METADATA_FILES = Object.freeze([
  '.env.example',
  'README.md',
  'package.json',
]);

const TEST_DIRECTORY_NAMES = new Set([
  '__tests__',
  'test',
  'tests',
]);

/**
 * Parses the single-package JSON result emitted by `npm pack`.
 */
export function parsePackResult(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error('npm pack returned invalid JSON', { cause: error });
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
    throw new Error('npm pack returned an unexpected result');
  }
  if (parsed[0].files.some((entry) => !entry || typeof entry.path !== 'string' || entry.path.length === 0)) {
    throw new Error('npm pack returned an invalid file entry');
  }
  return parsed[0];
}

/**
 * Derives every public runtime entrypoint that must be present in the package.
 */
export function deriveRequiredPackagePaths(packageManifest) {
  if (!packageManifest || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) {
    throw new Error('package.json must contain an object');
  }

  const requiredPaths = new Set(REQUIRED_METADATA_FILES);
  requiredPaths.add(normalizeManifestEntrypoint(packageManifest.main, 'package.json main'));

  const packageBin = packageManifest.bin;
  if (packageBin === undefined) {
    return requiredPaths;
  }
  if (typeof packageBin === 'string') {
    requiredPaths.add(normalizeManifestEntrypoint(packageBin, 'package.json bin'));
    return requiredPaths;
  }
  if (!packageBin || typeof packageBin !== 'object' || Array.isArray(packageBin)) {
    throw new Error('package.json bin must be a string or an object of strings');
  }

  for (const [commandName, target] of Object.entries(packageBin)) {
    if (commandName.length === 0) {
      throw new Error('package.json bin contains an empty command name');
    }
    requiredPaths.add(normalizeManifestEntrypoint(target, `package.json bin.${commandName}`));
  }
  return requiredPaths;
}

/**
 * Returns whether a path is an allowed JavaScript runtime module.
 */
export function isAllowedRuntimePackagePath(packagePath) {
  if (typeof packagePath !== 'string'
    || !packagePath.startsWith('dist/app/')
    || !packagePath.endsWith('.js')) {
    return false;
  }

  const runtimeSegments = packagePath.slice('dist/app/'.length).split('/');
  if (runtimeSegments.length === 0
    || packagePath.includes('\\')
    || runtimeSegments.some((segment) => segment.length === 0
      || segment === '.'
      || segment === '..'
      || TEST_DIRECTORY_NAMES.has(segment))) {
    return false;
  }

  const fileName = runtimeSegments.at(-1);
  return fileName !== 'test.js'
    && fileName !== 'spec.js'
    && !fileName.endsWith('.test.js')
    && !fileName.endsWith('.spec.js');
}

/**
 * Verifies that an npm package contains only runtime files and includes every
 * built JavaScript module and public entrypoint.
 */
export function assertRuntimePackageFiles({ files, packageManifest, builtRuntimeFiles }) {
  if (!Array.isArray(files)) {
    throw new Error('npm pack files must be an array');
  }
  if (!Array.isArray(builtRuntimeFiles)) {
    throw new Error('Built runtime files must be an array');
  }

  const packedPaths = new Set();
  for (const entry of files) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('npm pack returned an invalid file entry');
    }

    const packagePath = entry.path;
    packedPaths.add(packagePath);
    const allowedMetadataFile = REQUIRED_METADATA_FILES.includes(packagePath);
    if (!isAllowedRuntimePackagePath(packagePath) && !allowedMetadataFile) {
      throw new Error(`npm package contains a non-runtime file: ${packagePath}`);
    }
  }

  const requiredPaths = deriveRequiredPackagePaths(packageManifest);
  const missingRuntimeFiles = builtRuntimeFiles.filter((packagePath) => {
    if (!isAllowedRuntimePackagePath(packagePath)) {
      throw new Error(`Built runtime contains a forbidden JavaScript file: ${packagePath}`);
    }
    return !packedPaths.has(packagePath);
  });
  if (missingRuntimeFiles.length > 0) {
    throw new Error(`npm package is missing built runtime files: ${missingRuntimeFiles.join(', ')}`);
  }

  const missingRequiredPaths = [...requiredPaths].filter((packagePath) => !packedPaths.has(packagePath));
  if (missingRequiredPaths.length > 0) {
    throw new Error(`npm package is missing required files: ${missingRequiredPaths.join(', ')}`);
  }
}

function normalizeManifestEntrypoint(target, source) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`${source} must be a non-empty string`);
  }

  const normalizedTarget = target.startsWith('./') ? target.slice(2) : target;
  const segments = normalizedTarget.split('/');
  if (normalizedTarget.length === 0
    || normalizedTarget.startsWith('/')
    || normalizedTarget.includes('\\')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${source} must be a normalized package-relative path`);
  }
  if (!isAllowedRuntimePackagePath(normalizedTarget)) {
    throw new Error(`${source} must refer to an allowed runtime JavaScript file`);
  }
  return normalizedTarget;
}
