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
import {
  type AppServerProtocolProfile,
  parseCodexCliVersion,
} from './app-server-protocol-registry';
import { inspectChatGptAppVersion } from './chatgpt-app-version';
import { buildCodexEnvironment } from './environment';
import {
  captureCodexBinaryArtifact,
  type CodexBinaryArtifact,
  type CodexRuntimeArtifact,
} from './runtime-artifact';
import {
  assessProtocolCompatibility,
  BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS,
  profileForSupportedVersion,
  ProtocolVersionConfigStore,
  type CompatibilityAssessment,
  type ProtocolVersionConfig,
  type RuntimeVersionDetection,
} from './protocol-version-config';

const execFileAsync = promisify(execFile);

export interface CodexRuntimeContractReport {
  readonly codexVersion: string;
  readonly schemaDigest: string;
  readonly protocolProfile: AppServerProtocolProfile;
  readonly runtimeArtifact: CodexRuntimeArtifact;
}

export interface CodexRuntimeProbeConfig {
  readonly codexBin: string;
  readonly codexCwd: string;
  readonly configHome: string;
}

export interface CodexRuntimeInspection {
  readonly codexVersionOutput: string;
  readonly codexVersion: string;
  readonly schemaDigest: string;
  readonly binaryArtifact: CodexBinaryArtifact;
}

export interface CodexCompatibilityReport {
  readonly configPath: string;
  readonly config: ProtocolVersionConfig;
  readonly detection: RuntimeVersionDetection;
  readonly assessment: CompatibilityAssessment;
  readonly protocolProfile: AppServerProtocolProfile | null;
}

export interface CodexCompatibilityOptions {
  readonly approve?: boolean;
  readonly now?: () => Date;
}

export class CodexRuntimeCompatibilityError extends Error {
  public constructor(readonly status: CompatibilityAssessment['status']) {
    super(status === 'upgrade_available'
      ? 'Local Codex protocol is compatible but the exact version requires operator approval'
      : 'Local Codex protocol is incompatible with the configured supported versions');
    this.name = 'CodexRuntimeCompatibilityError';
  }
}

/** Verifies the configured CLI and its generated App Server protocol exactly. */
export async function verifyCodexRuntimeContract(
  config: BridgeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
): Promise<CodexRuntimeContractReport> {
  const configHome = config.configHome ?? temporaryRoot;
  const compatibility = await inspectCodexCompatibility(
    { codexBin: config.codexBin, codexCwd: config.codexCwd, configHome },
    sourceEnv,
    temporaryRoot,
  );
  if (compatibility.assessment.status !== 'supported' || compatibility.protocolProfile === null) {
    throw new CodexRuntimeCompatibilityError(compatibility.assessment.status);
  }
  return contractReport(compatibility.detection, compatibility.protocolProfile);
}

/** Detects the local runtime, persists the result, and optionally approves a compatible version. */
export async function inspectCodexCompatibility(
  config: CodexRuntimeProbeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
  options: CodexCompatibilityOptions = {},
): Promise<CodexCompatibilityReport> {
  const store = new ProtocolVersionConfigStore(config.configHome);
  store.loadOrCreate();
  const inspection = await inspectCodexRuntime(config, sourceEnv, temporaryRoot);
  let versionConfig = store.loadOrCreate();
  let assessment = assessProtocolCompatibility(
    versionConfig.supportedVersions,
    inspection.codexVersion,
    inspection.schemaDigest,
  );
  let detection = createDetection(config, inspection, assessment, options.now ?? (() => new Date()));
  versionConfig = store.recordDetection(detection);
  detection = versionConfig.lastDetection!;
  assessment = assessProtocolCompatibility(
    versionConfig.supportedVersions,
    inspection.codexVersion,
    inspection.schemaDigest,
  );

  if (options.approve && assessment.status === 'upgrade_available') {
    versionConfig = store.approveCompatibleVersion(detection);
    detection = versionConfig.lastDetection!;
    assessment = assessProtocolCompatibility(
      versionConfig.supportedVersions,
      inspection.codexVersion,
      inspection.schemaDigest,
    );
  }
  const supportedVersion = assessment.status === 'supported'
    ? versionConfig.supportedVersions.find((entry) => (
      entry.codexVersion === inspection.codexVersion
      && entry.schemaDigest === inspection.schemaDigest
    ))
    : undefined;
  return Object.freeze({
    configPath: store.filePath,
    config: versionConfig,
    detection,
    assessment,
    protocolProfile: supportedVersion ? profileForSupportedVersion(supportedVersion) : null,
  });
}

/** Captures version, full schema digest, and binary identity without deciding support. */
export async function inspectCodexRuntime(
  config: CodexRuntimeProbeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
): Promise<CodexRuntimeInspection> {
  const schemaDirectory = mkdtempSync(join(temporaryRoot, 'schema-'));
  const env = buildCodexEnvironment(sourceEnv);
  try {
    const codexVersionOutput = await codexOutput(config, ['--version'], env);
    const codexVersion = parseCodexCliVersion(codexVersionOutput).version;
    await codexOutput(
      config,
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDirectory],
      env,
    );
    const schemaDigest = digestJsonSchemaDirectory(schemaDirectory);
    const binaryArtifact = await captureCodexBinaryArtifact(config.codexBin);
    return Object.freeze({ codexVersionOutput, codexVersion, schemaDigest, binaryArtifact });
  } finally {
    rmSync(schemaDirectory, { recursive: true, force: true });
  }
}

/** Returns the exact registered profile after validating CLI and schema identity. */
export function assertCompatibleCodexRuntime(
  codexVersion: string,
  schemaDigest: string,
): AppServerProtocolProfile {
  const parsedVersion = parseCodexCliVersion(codexVersion);
  const versionMatch = BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS.find(
    (entry) => entry.codexVersion === parsedVersion.version,
  );
  const digestMatch = BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS.find(
    (entry) => entry.schemaDigest === schemaDigest,
  );
  if (versionMatch !== undefined && versionMatch.schemaDigest === schemaDigest) {
    return profileForSupportedVersion(versionMatch);
  }
  if (
    versionMatch !== undefined
    && digestMatch !== undefined
    && versionMatch.adapterProfileId !== digestMatch.adapterProfileId
  ) {
    throw new Error(
      'Configured Codex CLI version and App Server schema digest '
        + 'identify different supported profiles',
    );
  }
  if (versionMatch !== undefined) {
    throw new Error(
      'Configured Codex App Server schema digest does not match the registered CLI profile',
    );
  }
  if (digestMatch !== undefined) {
    throw new Error(
      'Configured Codex CLI version does not match the registered App Server schema profile',
    );
  }
  throw new Error('Configured Codex App Server protocol profile is unsupported');
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
  config: Pick<CodexRuntimeProbeConfig, 'codexBin' | 'codexCwd'>,
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

function createDetection(
  config: CodexRuntimeProbeConfig,
  inspection: CodexRuntimeInspection,
  assessment: CompatibilityAssessment,
  now: () => Date,
): RuntimeVersionDetection {
  return Object.freeze({
    checkedAt: now().toISOString(),
    codexBinary: config.codexBin,
    codexVersion: inspection.codexVersion,
    binarySha256: inspection.binaryArtifact.binarySha256,
    schemaDigest: inspection.schemaDigest,
    chatGptApp: inspectChatGptAppVersion(config.codexBin),
    compatibility: Object.freeze({
      conclusion: assessment.conclusion,
      status: assessment.status,
      adapterProfileId: assessment.adapterProfileId,
    }),
  });
}

function contractReport(
  detection: RuntimeVersionDetection,
  protocolProfile: AppServerProtocolProfile,
): CodexRuntimeContractReport {
  return Object.freeze({
    codexVersion: `codex-cli ${detection.codexVersion}`,
    schemaDigest: detection.schemaDigest,
    protocolProfile,
    runtimeArtifact: Object.freeze({
      binaryName: basename(detection.codexBinary),
      binarySha256: detection.binarySha256,
      protocolContractId: protocolProfile.id,
    }),
  });
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
