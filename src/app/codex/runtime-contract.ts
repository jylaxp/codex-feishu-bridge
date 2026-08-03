import { execFile } from 'node:child_process';
import { basename } from 'node:path';
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
  type SupportedProtocolVersion,
} from './protocol-version-config';
import {
  runAppServerProtocolSmoke,
  type AppServerProtocolSmokeResult,
  type AppServerProtocolSmokeRunner,
  type AppServerProtocolSmokeTarget,
} from './app-server-protocol-smoke';

const execFileAsync = promisify(execFile);

export interface CodexRuntimeContractReport {
  readonly codexVersion: string;
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
  readonly binaryArtifact: CodexBinaryArtifact;
}

export interface CodexCompatibilityReport {
  readonly configPath: string;
  readonly config: ProtocolVersionConfig;
  readonly detection: RuntimeVersionDetection;
  readonly assessment: CompatibilityAssessment;
  readonly protocolProfile: AppServerProtocolProfile | null;
  readonly protocolSmoke: AppServerProtocolSmokeResult | null;
}

export interface CodexCompatibilityOptions {
  readonly autoProtocolSmoke?: boolean;
  readonly protocolSmokeRunner?: AppServerProtocolSmokeRunner;
  readonly onRuntimeDetected?: (target: AppServerProtocolSmokeTarget) => Promise<void> | void;
  readonly now?: () => Date;
}

export class CodexRuntimeCompatibilityError extends Error {
  public constructor(readonly status: CompatibilityAssessment['status']) {
    super('Local Codex protocol is incompatible with the configured supported versions');
    this.name = 'CodexRuntimeCompatibilityError';
  }
}

/** Verifies the configured CLI version or a successful protocol smoke result. */
export async function verifyCodexRuntimeContract(
  config: BridgeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
  options: Pick<
    CodexCompatibilityOptions,
    'now' | 'onRuntimeDetected' | 'protocolSmokeRunner'
  > = {},
): Promise<CodexRuntimeContractReport> {
  const configHome = config.configHome ?? temporaryRoot;
  const compatibility = await inspectCodexCompatibility(
    { codexBin: config.codexBin, codexCwd: config.codexCwd, configHome },
    sourceEnv,
    temporaryRoot,
    { ...options, autoProtocolSmoke: true },
  );
  if (compatibility.assessment.status !== 'supported' || compatibility.protocolProfile === null) {
    throw new CodexRuntimeCompatibilityError(compatibility.assessment.status);
  }
  return contractReport(compatibility.detection, compatibility.protocolProfile);
}

/** Detects the local runtime, persists the result, and can auto-support a smoke-verified version. */
export async function inspectCodexCompatibility(
  config: CodexRuntimeProbeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  temporaryRoot: string,
  options: CodexCompatibilityOptions = {},
): Promise<CodexCompatibilityReport> {
  const store = new ProtocolVersionConfigStore(config.configHome);
  store.loadOrCreate();
  const inspection = await inspectCodexRuntime(config, sourceEnv, temporaryRoot);
  const smokeTarget = Object.freeze({
    codexBin: config.codexBin,
    codexVersionOutput: inspection.codexVersionOutput,
    codexVersion: inspection.codexVersion,
  });
  await options.onRuntimeDetected?.(smokeTarget);
  let versionConfig = store.loadOrCreate();
  let assessment = assessProtocolCompatibility(
    versionConfig.supportedVersions,
    inspection.codexVersion,
  );
  let detection = createDetection(config, inspection, assessment, options.now ?? (() => new Date()));
  versionConfig = store.recordDetection(detection);
  detection = versionConfig.lastDetection!;
  assessment = assessProtocolCompatibility(
    versionConfig.supportedVersions,
    inspection.codexVersion,
  );
  let protocolSmoke: AppServerProtocolSmokeResult | null = null;

  if (assessment.status !== 'supported' && options.autoProtocolSmoke) {
    try {
      protocolSmoke = await (options.protocolSmokeRunner ?? runAppServerProtocolSmoke)({
        target: smokeTarget,
        sourceEnv,
        temporaryRoot,
      });
      versionConfig = store.approveProtocolSmokeVersion(detection, protocolSmoke.adapterProfileId);
    } catch {
      const failedAssessment = incompatibleRuntimeAssessment();
      versionConfig = store.recordDetectionWithAssessment(
        createDetection(config, inspection, failedAssessment, options.now ?? (() => new Date())),
        failedAssessment,
      );
    }
    detection = versionConfig.lastDetection!;
    assessment = assessmentFromDetection(detection, versionConfig.supportedVersions);
  }
  const supportedVersion = assessment.status === 'supported'
    ? versionConfig.supportedVersions.find((entry) => entry.codexVersion === inspection.codexVersion)
    : undefined;
  return Object.freeze({
    configPath: store.filePath,
    config: versionConfig,
    detection,
    assessment,
    protocolProfile: supportedVersion ? profileForSupportedVersion(supportedVersion) : null,
    protocolSmoke,
  });
}

/** Captures version and binary identity without deciding support. */
export async function inspectCodexRuntime(
  config: CodexRuntimeProbeConfig,
  sourceEnv: NodeJS.ProcessEnv,
  _temporaryRoot: string,
): Promise<CodexRuntimeInspection> {
  const env = buildCodexEnvironment(sourceEnv);
  const codexVersionOutput = await codexOutput(config, ['--version'], env);
  const codexVersion = parseCodexCliVersion(codexVersionOutput).version;
  const binaryArtifact = await captureCodexBinaryArtifact(config.codexBin);
  return Object.freeze({ codexVersionOutput, codexVersion, binaryArtifact });
}

/** Returns the registered profile for a supported CLI version. */
export function assertCompatibleCodexRuntime(
  codexVersion: string,
): AppServerProtocolProfile {
  const parsedVersion = parseCodexCliVersion(codexVersion);
  const versionMatch = BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS.find(
    (entry) => entry.codexVersion === parsedVersion.version,
  );
  if (versionMatch !== undefined) {
    return profileForSupportedVersion(versionMatch);
  }
  throw new Error('Configured Codex App Server protocol profile is unsupported');
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
    protocolProfile,
    runtimeArtifact: Object.freeze({
      binaryName: basename(detection.codexBinary),
      binarySha256: detection.binarySha256,
      protocolContractId: protocolProfile.id,
    }),
  });
}

function incompatibleRuntimeAssessment(): CompatibilityAssessment {
  return Object.freeze({
    conclusion: '不兼容',
    status: 'incompatible',
    adapterProfileId: null,
    matchedVersion: null,
  });
}

function assessmentFromDetection(
  detection: RuntimeVersionDetection,
  supportedVersions: readonly SupportedProtocolVersion[],
): CompatibilityAssessment {
  const matchedVersion = detection.compatibility.status === 'supported'
    ? supportedVersions.find((entry) => entry.codexVersion === detection.codexVersion) ?? null
    : null;
  return Object.freeze({
    conclusion: detection.compatibility.conclusion,
    status: detection.compatibility.status,
    adapterProfileId: detection.compatibility.adapterProfileId,
    matchedVersion,
  });
}
