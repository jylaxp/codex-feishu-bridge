import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';

import type { BridgeConfig } from '../domain';
import { SUPPORTED_APP_SERVER_SCHEMA_DIGEST } from './contract';
import { buildCodexEnvironment } from './environment';

const execFileAsync = promisify(execFile);

export interface CodexRuntimeContractReport {
  readonly codexVersion: string;
  readonly schemaDigest: string;
}

/** Verifies the configured CLI and its generated App Server protocol exactly. */
export async function verifyCodexRuntimeContract(
  config: BridgeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
): Promise<CodexRuntimeContractReport> {
  const schemaDirectory = mkdtempSync(join(temporaryRoot, 'schema-'));
  const env = buildCodexEnvironment(sourceEnv);
  try {
    const codexVersion = await codexOutput(config, ['--version'], env);
    await codexOutput(
      config,
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDirectory],
      env,
    );
    const schemaDigest = digestJsonSchemaDirectory(schemaDirectory);
    assertCompatibleCodexRuntime(codexVersion, schemaDigest);
    return Object.freeze({ codexVersion, schemaDigest });
  } finally {
    rmSync(schemaDirectory, { recursive: true, force: true });
  }
}

/** Accepts patch-level CLI changes only when the generated protocol is unchanged. */
export function assertCompatibleCodexRuntime(codexVersion: string, schemaDigest: string): void {
  if (!/^codex-cli \d+\.\d+\.\d+$/.test(codexVersion)) {
    throw new Error('Configured Codex CLI version response is invalid');
  }
  if (schemaDigest !== SUPPORTED_APP_SERVER_SCHEMA_DIGEST) {
    throw new Error('Configured Codex App Server schema is unsupported');
  }
}

/** Digests generated schemas independently of nondeterministic JSON object key order. */
export function digestJsonSchemaDirectory(root: string): string {
  const hash = createHash('sha256');
  for (const filePath of listFiles(root)) {
    hash.update(relative(root, filePath));
    hash.update('\0');
    const schema = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    hash.update(JSON.stringify(canonicalizeJson(schema)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function codexOutput(
  config: BridgeConfig,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(config.codexBin, [...args], {
    cwd: config.codexCwd,
    env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  return result.stdout.trim();
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJson(value[key]);
    }
    return result;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function listFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile() && basename(filePath) !== '.DS_Store') {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files;
}
