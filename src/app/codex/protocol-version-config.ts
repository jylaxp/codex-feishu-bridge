import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { BridgeProcessLock } from '../process-lock';
import {
  APP_SERVER_PROTOCOL_PROFILES,
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  parseCodexCliVersion,
  type AppServerProtocolProfile,
  type AppServerProtocolProfileId,
} from './app-server-protocol-registry';

const CONFIG_FILE_NAME = 'protocol-versions.json';
const CONFIG_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME = 'protocol-versions.lock';

export type ProtocolVersionSource = 'builtin' | 'approved';
export type CompatibilityStatus = 'supported' | 'upgrade_available' | 'incompatible';
export type CompatibilityConclusion = '兼容' | '不兼容';

export interface SupportedProtocolVersion {
  readonly codexVersion: string;
  readonly schemaDigest: string;
  readonly adapterProfileId: AppServerProtocolProfileId;
  readonly source: ProtocolVersionSource;
}

/** Exact versions bundled into new configurations, including reviewed adapter-compatible aliases. */
export const BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS: readonly SupportedProtocolVersion[] =
  Object.freeze([
    ...APP_SERVER_PROTOCOL_PROFILES.map((profile) => Object.freeze({
      codexVersion: profile.codexVersion,
      schemaDigest: profile.schemaDigest,
      adapterProfileId: profile.id,
      source: 'builtin' as const,
    })),
    Object.freeze({
      codexVersion: '0.145.0-alpha.27',
      schemaDigest: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest,
      adapterProfileId: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.id,
      source: 'builtin' as const,
    }),
    Object.freeze({
      codexVersion: '0.145.0-alpha.30',
      schemaDigest: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest,
      adapterProfileId: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.id,
      source: 'builtin' as const,
    }),
  ]);

assertSupportedVersions(BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS);

export interface ChatGptAppVersion {
  readonly appPath: string;
  readonly version: string;
  readonly build: string;
}

export interface RuntimeVersionDetection {
  readonly checkedAt: string;
  readonly codexBinary: string;
  readonly codexVersion: string;
  readonly binarySha256: string;
  readonly schemaDigest: string;
  readonly chatGptApp: ChatGptAppVersion | null;
  readonly compatibility: {
    readonly conclusion: CompatibilityConclusion;
    readonly status: CompatibilityStatus;
    readonly adapterProfileId: AppServerProtocolProfileId | null;
  };
}

export interface ProtocolVersionConfig {
  readonly schemaVersion: 1;
  readonly supportedVersions: readonly SupportedProtocolVersion[];
  readonly lastDetection: RuntimeVersionDetection | null;
}

export interface CompatibilityAssessment {
  readonly conclusion: CompatibilityConclusion;
  readonly status: CompatibilityStatus;
  readonly adapterProfileId: AppServerProtocolProfileId | null;
  readonly matchedVersion: SupportedProtocolVersion | null;
}

/** Owns the local, operator-editable exact-version support catalog. */
export class ProtocolVersionConfigStore {
  public readonly filePath: string;

  public constructor(private readonly configHome: string) {
    this.filePath = join(configHome, CONFIG_FILE_NAME);
  }

  /** Seeds the catalog and adds newly shipped built-ins without replacing operator approvals. */
  public loadOrCreate(): ProtocolVersionConfig {
    return this.withMutationLock(() => this.loadOrCreateUnlocked());
  }

  public recordDetection(detection: RuntimeVersionDetection): ProtocolVersionConfig {
    return this.withMutationLock(() => {
      const config = this.loadOrCreateUnlocked();
      const assessment = assessProtocolCompatibility(
        config.supportedVersions,
        detection.codexVersion,
        detection.schemaDigest,
      );
      const updated = freezeConfig({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        supportedVersions: config.supportedVersions,
        lastDetection: detectionWithAssessment(detection, assessment),
      });
      this.write(updated);
      return updated;
    });
  }

  public approveCompatibleVersion(detection: RuntimeVersionDetection): ProtocolVersionConfig {
    return this.withMutationLock(() => {
      const config = this.loadOrCreateUnlocked();
      const assessment = assessProtocolCompatibility(
        config.supportedVersions,
        detection.codexVersion,
        detection.schemaDigest,
      );
      if (assessment.status === 'incompatible' || assessment.adapterProfileId === null) {
        throw new Error('Only a schema-compatible exact version can be approved');
      }
      if (assessment.status === 'supported') {
        const updated = freezeConfig({
          schemaVersion: CONFIG_SCHEMA_VERSION,
          supportedVersions: config.supportedVersions,
          lastDetection: detectionWithAssessment(detection, assessment),
        });
        this.write(updated);
        return updated;
      }

      const supportedVersions = Object.freeze([
        ...config.supportedVersions,
        Object.freeze({
          codexVersion: detection.codexVersion,
          schemaDigest: detection.schemaDigest,
          adapterProfileId: assessment.adapterProfileId,
          source: 'approved' as const,
        }),
      ]);
      assertSupportedVersions(supportedVersions);
      const approvedAssessment = assessProtocolCompatibility(
        supportedVersions,
        detection.codexVersion,
        detection.schemaDigest,
      );
      const updated = freezeConfig({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        supportedVersions,
        lastDetection: detectionWithAssessment(detection, approvedAssessment),
      });
      this.write(updated);
      return updated;
    });
  }

  private load(): ProtocolVersionConfig {
    return parseProtocolVersionConfig(readFileSync(this.filePath, 'utf8'));
  }

  private loadOrCreateUnlocked(): ProtocolVersionConfig {
    if (existsSync(this.filePath)) {
      const persisted = this.load();
      const merged = mergeMissingBuiltInVersions(persisted);
      if (merged !== persisted) {
        this.write(merged);
      }
      return merged;
    }
    const initial = builtInProtocolVersionConfig();
    this.write(initial);
    return initial;
  }

  private withMutationLock<T>(mutation: () => T): T {
    mkdirSync(this.configHome, { recursive: true, mode: 0o700 });
    const lock = new BridgeProcessLock(this.configHome, {
      lockFileName: PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME,
    });
    lock.acquire();
    try {
      return mutation();
    } finally {
      lock.release();
    }
  }

  private write(config: ProtocolVersionConfig): void {
    mkdirSync(this.configHome, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}

function mergeMissingBuiltInVersions(config: ProtocolVersionConfig): ProtocolVersionConfig {
  const persistedVersions = new Set(config.supportedVersions.map((entry) => entry.codexVersion));
  const missingBuiltIns = BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS.filter(
    (entry) => !persistedVersions.has(entry.codexVersion),
  );
  if (missingBuiltIns.length === 0) {
    return config;
  }
  const supportedVersions = Object.freeze([
    ...config.supportedVersions,
    ...missingBuiltIns,
  ]);
  assertSupportedVersions(supportedVersions);
  return freezeConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    supportedVersions,
    lastDetection: config.lastDetection,
  });
}

function detectionWithAssessment(
  detection: RuntimeVersionDetection,
  assessment: CompatibilityAssessment,
): RuntimeVersionDetection {
  return Object.freeze({
    ...detection,
    compatibility: Object.freeze({
      conclusion: assessment.conclusion,
      status: assessment.status,
      adapterProfileId: assessment.adapterProfileId,
    }),
  });
}

export function assessProtocolCompatibility(
  supportedVersions: readonly SupportedProtocolVersion[],
  codexVersion: string,
  schemaDigest: string,
): CompatibilityAssessment {
  const exactVersion = supportedVersions.find((entry) => entry.codexVersion === codexVersion);
  if (exactVersion?.schemaDigest === schemaDigest) {
    return Object.freeze({
      conclusion: '兼容',
      status: 'supported',
      adapterProfileId: exactVersion.adapterProfileId,
      matchedVersion: exactVersion,
    });
  }
  if (exactVersion !== undefined) {
    return incompatibleAssessment();
  }
  const schemaMatches = supportedVersions.filter((entry) => entry.schemaDigest === schemaDigest);
  const adapterProfileIds = new Set(schemaMatches.map((entry) => entry.adapterProfileId));
  if (schemaMatches.length > 0 && adapterProfileIds.size === 1) {
    return Object.freeze({
      conclusion: '兼容',
      status: 'upgrade_available',
      adapterProfileId: schemaMatches[0]!.adapterProfileId,
      matchedVersion: schemaMatches[0]!,
    });
  }
  return incompatibleAssessment();
}

export function profileForSupportedVersion(
  supportedVersion: SupportedProtocolVersion,
): AppServerProtocolProfile {
  const baseProfile = APP_SERVER_PROTOCOL_PROFILES.find(
    (profile) => profile.id === supportedVersion.adapterProfileId,
  );
  if (baseProfile === undefined) {
    throw new Error('Configured protocol version references an unavailable adapter profile');
  }
  if (
    baseProfile.codexVersion === supportedVersion.codexVersion
    && baseProfile.schemaDigest === supportedVersion.schemaDigest
  ) {
    return baseProfile;
  }
  return Object.freeze({
    ...baseProfile,
    codexVersion: supportedVersion.codexVersion,
    cliVersionOutput: `codex-cli ${supportedVersion.codexVersion}`,
    schemaDigest: supportedVersion.schemaDigest,
    diagnosticLabel: `${baseProfile.diagnosticLabel} (${supportedVersion.codexVersion})`,
  });
}

export function builtInProtocolVersionConfig(): ProtocolVersionConfig {
  return freezeConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    supportedVersions: BUILT_IN_SUPPORTED_PROTOCOL_VERSIONS,
    lastDetection: null,
  });
}

function parseProtocolVersionConfig(source: string): ProtocolVersionConfig {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Protocol version configuration is not valid JSON');
  }
  if (!isRecord(value) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error('Protocol version configuration schema is unsupported');
  }
  if (!Array.isArray(value.supportedVersions)) {
    throw new Error('Protocol version configuration supportedVersions is invalid');
  }
  const supportedVersions = Object.freeze(value.supportedVersions.map(parseSupportedVersion));
  assertSupportedVersions(supportedVersions);
  const lastDetection = value.lastDetection === null
    ? null
    : parseDetection(value.lastDetection);
  return freezeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, supportedVersions, lastDetection });
}

function parseSupportedVersion(value: unknown): SupportedProtocolVersion {
  if (!isRecord(value)) {
    throw new Error('Protocol version configuration contains an invalid supported version');
  }
  const adapterProfileId = parseAdapterProfileId(value.adapterProfileId);
  if (
    typeof value.codexVersion !== 'string'
    || !isSha256(value.schemaDigest)
    || (value.source !== 'builtin' && value.source !== 'approved')
  ) {
    throw new Error('Protocol version configuration contains an invalid supported version');
  }
  return Object.freeze({
    codexVersion: value.codexVersion,
    schemaDigest: value.schemaDigest,
    adapterProfileId,
    source: value.source,
  });
}

function parseDetection(value: unknown): RuntimeVersionDetection {
  if (!isRecord(value) || !isRecord(value.compatibility)) {
    throw new Error('Protocol version configuration contains an invalid detection');
  }
  const adapterProfileId = value.compatibility.adapterProfileId === null
    ? null
    : parseAdapterProfileId(value.compatibility.adapterProfileId);
  const status = value.compatibility.status;
  const conclusion = value.compatibility.conclusion;
  if (
    typeof value.checkedAt !== 'string'
    || !Number.isFinite(Date.parse(value.checkedAt))
    || typeof value.codexBinary !== 'string'
    || typeof value.codexVersion !== 'string'
    || !isSha256(value.binarySha256)
    || !isSha256(value.schemaDigest)
    || (status !== 'supported' && status !== 'upgrade_available' && status !== 'incompatible')
    || (conclusion !== '兼容' && conclusion !== '不兼容')
  ) {
    throw new Error('Protocol version configuration contains an invalid detection');
  }
  return Object.freeze({
    checkedAt: value.checkedAt,
    codexBinary: value.codexBinary,
    codexVersion: value.codexVersion,
    binarySha256: value.binarySha256,
    schemaDigest: value.schemaDigest,
    chatGptApp: parseChatGptApp(value.chatGptApp),
    compatibility: Object.freeze({ conclusion, status, adapterProfileId }),
  });
}

function parseChatGptApp(value: unknown): ChatGptAppVersion | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value)
    || typeof value.appPath !== 'string'
    || typeof value.version !== 'string'
    || typeof value.build !== 'string'
  ) {
    throw new Error('Protocol version configuration contains invalid ChatGPT app metadata');
  }
  return Object.freeze({ appPath: value.appPath, version: value.version, build: value.build });
}

function assertSupportedVersions(supportedVersions: readonly SupportedProtocolVersion[]): void {
  if (supportedVersions.length === 0) {
    throw new Error('Protocol version configuration must contain at least one supported version');
  }
  const versions = new Set<string>();
  const adaptersByDigest = new Map<string, AppServerProtocolProfileId>();
  for (const entry of supportedVersions) {
    parseCodexCliVersion(`codex-cli ${entry.codexVersion}`);
    if (versions.has(entry.codexVersion)) {
      throw new Error('Protocol version configuration contains a duplicate Codex version');
    }
    const digestAdapter = adaptersByDigest.get(entry.schemaDigest);
    if (digestAdapter !== undefined && digestAdapter !== entry.adapterProfileId) {
      throw new Error('Protocol version configuration maps one schema to multiple adapters');
    }
    versions.add(entry.codexVersion);
    adaptersByDigest.set(entry.schemaDigest, entry.adapterProfileId);
    profileForSupportedVersion(entry);
  }
}

function incompatibleAssessment(): CompatibilityAssessment {
  return Object.freeze({
    conclusion: '不兼容',
    status: 'incompatible',
    adapterProfileId: null,
    matchedVersion: null,
  });
}

function parseAdapterProfileId(value: unknown): AppServerProtocolProfileId {
  const profile = APP_SERVER_PROTOCOL_PROFILES.find((candidate) => candidate.id === value);
  if (profile === undefined) {
    throw new Error('Protocol version configuration references an unknown adapter profile');
  }
  return profile.id;
}

function freezeConfig(config: ProtocolVersionConfig): ProtocolVersionConfig {
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    supportedVersions: Object.freeze([...config.supportedVersions]),
    lastDetection: config.lastDetection,
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
