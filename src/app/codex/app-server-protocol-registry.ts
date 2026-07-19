import {
  APP_SERVER_SCHEMA_DIGEST_0_144_3,
  APP_SERVER_SCHEMA_DIGEST_0_145_0_ALPHA_18,
} from './contract';

const SEMVER_CORE_PATTERN = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const SEMVER_PRERELEASE_PATTERN = '(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const SEMVER_BUILD_PATTERN = '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const CODEX_CLI_VERSION_PATTERN = new RegExp(
  `^codex-cli (${SEMVER_CORE_PATTERN}${SEMVER_PRERELEASE_PATTERN}${SEMVER_BUILD_PATTERN})$`,
);
const APP_SERVER_USER_AGENT_PATTERN = new RegExp(
  '^(?:Codex Desktop|[A-Za-z][A-Za-z0-9._-]*)/'
    + `(${SEMVER_CORE_PATTERN}${SEMVER_PRERELEASE_PATTERN}${SEMVER_BUILD_PATTERN})`
    + '(?: \\([^()\\r\\n]*\\)(?: [A-Za-z0-9._-]+ \\([^()\\r\\n]*\\))?)?$',
);

export type AppServerProtocolProfileId =
  | 'app-server-0.144.3'
  | 'app-server-0.145.0-alpha.18';

/** Parsed and validated identity returned by `codex --version`. */
export interface CodexCliVersion {
  readonly cliOutput: string;
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

/** Immutable identity of one explicitly supported App Server protocol contract. */
export interface AppServerProtocolContract {
  readonly id: AppServerProtocolProfileId;
  readonly codexVersion: string;
  readonly cliVersionOutput: string;
  readonly schemaDigest: string;
  readonly diagnosticLabel: string;
}

/** @deprecated Use AppServerProtocolContract; retained for adapter API compatibility. */
export type AppServerProtocolProfile = AppServerProtocolContract;

export const APP_SERVER_PROTOCOL_PROFILE_0_144_3 = createProfile({
  id: 'app-server-0.144.3',
  codexVersion: '0.144.3',
  schemaDigest: APP_SERVER_SCHEMA_DIGEST_0_144_3,
  diagnosticLabel: 'Codex App Server 0.144.3',
});

export const APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18 = createProfile({
  id: 'app-server-0.145.0-alpha.18',
  codexVersion: '0.145.0-alpha.18',
  schemaDigest: APP_SERVER_SCHEMA_DIGEST_0_145_0_ALPHA_18,
  diagnosticLabel: 'Codex App Server 0.145.0-alpha.18',
});

/** Exact supported contracts. There is deliberately no version-range fallback. */
export const APP_SERVER_PROTOCOL_PROFILES: readonly AppServerProtocolProfile[] =
  Object.freeze([
    APP_SERVER_PROTOCOL_PROFILE_0_144_3,
    APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  ]);

assertUniqueProfiles(APP_SERVER_PROTOCOL_PROFILES);

/**
 * Parses the exact Codex CLI version response and validates SemVer syntax.
 *
 * Numeric prerelease identifiers with leading zeroes are rejected as required
 * by SemVer. Build metadata remains part of the exact version identity.
 */
export function parseCodexCliVersion(cliOutput: string): CodexCliVersion {
  const match = CODEX_CLI_VERSION_PATTERN.exec(cliOutput);
  if (match === null) {
    throw new Error('Configured Codex CLI version response is invalid');
  }

  const version = requiredMatchGroup(match[1]);
  const majorText = requiredMatchGroup(match[2]);
  const minorText = requiredMatchGroup(match[3]);
  const patchText = requiredMatchGroup(match[4]);
  const prerelease = splitIdentifiers(match[5]);
  if (prerelease.some(hasInvalidNumericPrerelease)) {
    throw new Error('Configured Codex CLI version response is invalid');
  }

  const major = parseSafeVersionNumber(majorText);
  const minor = parseSafeVersionNumber(minorText);
  const patch = parseSafeVersionNumber(patchText);
  return Object.freeze({
    cliOutput,
    version,
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(splitIdentifiers(match[6])),
  });
}

/**
 * Extracts and validates the exact SemVer carried by an initialize userAgent.
 *
 * The version is deliberately passed back through the same parser used for
 * `codex --version`, so CLI probing and daemon corroboration cannot drift into
 * separate prerelease rules.
 */
export function parseAppServerUserAgentVersion(userAgent: string): CodexCliVersion {
  const match = APP_SERVER_USER_AGENT_PATTERN.exec(userAgent);
  if (match === null || match[1] === undefined) {
    throw new Error('App Server initialize identity is invalid');
  }
  try {
    return parseCodexCliVersion(`codex-cli ${match[1]}`);
  } catch {
    throw new Error('App Server initialize identity is invalid');
  }
}

/** Selects the sole registered profile matching both version and schema digest. */
export function selectAppServerProtocolProfile(
  codexVersion: CodexCliVersion,
  schemaDigest: string,
): AppServerProtocolProfile {
  const versionProfile = APP_SERVER_PROTOCOL_PROFILES.find(
    (profile) => profile.codexVersion === codexVersion.version,
  );
  const digestProfile = APP_SERVER_PROTOCOL_PROFILES.find(
    (profile) => profile.schemaDigest === schemaDigest,
  );

  if (versionProfile !== undefined && digestProfile !== undefined) {
    if (versionProfile !== digestProfile) {
      throw new Error(
        'Configured Codex CLI version and App Server schema digest '
          + 'identify different supported profiles',
      );
    }
    return versionProfile;
  }
  if (versionProfile !== undefined) {
    throw new Error(
      'Configured Codex App Server schema digest does not match the registered CLI profile',
    );
  }
  if (digestProfile !== undefined) {
    throw new Error(
      'Configured Codex CLI version does not match the registered App Server schema profile',
    );
  }
  throw new Error('Configured Codex App Server protocol profile is unsupported');
}

function createProfile(input: {
  readonly id: AppServerProtocolProfileId;
  readonly codexVersion: string;
  readonly schemaDigest: string;
  readonly diagnosticLabel: string;
}): AppServerProtocolProfile {
  return Object.freeze({
    ...input,
    cliVersionOutput: `codex-cli ${input.codexVersion}`,
  });
}

function splitIdentifiers(value: string | undefined): string[] {
  return value === undefined ? [] : value.split('.');
}

function requiredMatchGroup(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Configured Codex CLI version response is invalid');
  }
  return value;
}

function hasInvalidNumericPrerelease(identifier: string): boolean {
  return /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0');
}

function parseSafeVersionNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error('Configured Codex CLI version response is invalid');
  }
  return result;
}

function assertUniqueProfiles(profiles: readonly AppServerProtocolProfile[]): void {
  const ids = new Set<AppServerProtocolProfileId>();
  const versions = new Set<string>();
  const digests = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id) || versions.has(profile.codexVersion) || digests.has(profile.schemaDigest)) {
      throw new Error('App Server protocol registry contains a duplicate identity');
    }
    ids.add(profile.id);
    versions.add(profile.codexVersion);
    digests.add(profile.schemaDigest);
  }
}
