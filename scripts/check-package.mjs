import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertNodeSupportContract } from './node-support-contract.mjs';
import {
  assertRuntimePackageFiles,
  parsePackResult,
} from './package-contract.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli)) {
  throw new Error('Package check must run through npm with an absolute npm_execpath');
}

const cacheDirectory = join(tmpdir(), 'codex-feishu-bridge-npm-cache');
mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });

const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--silent'], {
  env: {
    ...process.env,
    npm_config_cache: cacheDirectory,
  },
  encoding: 'utf8',
  shell: false,
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const packResult = parsePackResult(result.stdout);

const projectRoot = resolve(import.meta.dirname, '..');
const packageManifest = readJson(join(projectRoot, 'package.json'));
const packageLock = readJson(join(projectRoot, 'package-lock.json'));
const builtRuntimeFiles = listJavaScriptFiles(projectRoot, join(projectRoot, 'dist/app'));
assertRuntimePackageFiles({
  files: packResult.files,
  packageManifest,
  builtRuntimeFiles,
});

const runtimeConfigUrl = pathToFileURL(join(projectRoot, 'dist/app/config.js')).href;
const runtimeConfig = await import(runtimeConfigUrl);

assertNodeSupportContract({
  minNodeVersion: runtimeConfig.MIN_NODE_VERSION,
  maxNodeMajorExclusive: runtimeConfig.MAX_NODE_MAJOR_EXCLUSIVE,
  packageEngine: packageManifest.engines?.node,
  packageLockEngine: packageLock.packages?.['']?.engines?.node,
});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function listJavaScriptFiles(projectRoot, directory) {
  const packagePaths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      packagePaths.push(...listJavaScriptFiles(projectRoot, entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      packagePaths.push(relative(projectRoot, entryPath).split(sep).join('/'));
    }
  }
  return packagePaths;
}
