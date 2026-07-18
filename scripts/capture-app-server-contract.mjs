import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SEMVER_CORE_PATTERN = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const SEMVER_PRERELEASE_PATTERN = '(?:-(?<prerelease>[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const SEMVER_BUILD_PATTERN = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const SEMVER_PATTERN = `${SEMVER_CORE_PATTERN}${SEMVER_PRERELEASE_PATTERN}${SEMVER_BUILD_PATTERN}`;
const CODEX_CLI_VERSION_PATTERN = new RegExp(`^codex-cli (?<version>${SEMVER_PATTERN})$`);
const APP_SERVER_USER_AGENT_PATTERN = new RegExp(
  '^(?:Codex Desktop|[A-Za-z][A-Za-z0-9._-]*)/'
    + `(?<version>${SEMVER_PATTERN})`
    + '(?: \\([^()\\r\\n]*\\)(?: [A-Za-z0-9._-]+ \\([^()\\r\\n]*\\))?)?$',
);
const SAFE_ENVIRONMENT_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'TERM', 'CODEX_HOME', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
]);
const METHODS = Object.freeze([
  'initialize',
  'thread/list',
  'thread/read',
  'thread/resume',
  'thread/start',
  'thread/fork',
  'thread/name/set',
  'thread/archive',
  'thread/goal/get',
  'thread/goal/set',
  'thread/goal/clear',
  'thread/compact/start',
  'skills/list',
  'mcpServerStatus/list',
  'account/rateLimits/read',
  'turn/start',
]);
const SCHEMA_FILES = Object.freeze([
  'v1/InitializeResponse.json',
  'v2/ThreadListParams.json',
  'v2/ThreadListResponse.json',
  'v2/ThreadReadParams.json',
  'v2/ThreadReadResponse.json',
  'v2/ThreadResumeParams.json',
  'v2/ThreadResumeResponse.json',
  'v2/ThreadStartParams.json',
  'v2/ThreadStartResponse.json',
  'v2/ThreadForkParams.json',
  'v2/ThreadForkResponse.json',
  'v2/ThreadSetNameParams.json',
  'v2/ThreadSetNameResponse.json',
  'v2/ThreadArchiveParams.json',
  'v2/ThreadArchiveResponse.json',
  'v2/ThreadGoalGetParams.json',
  'v2/ThreadGoalGetResponse.json',
  'v2/ThreadGoalSetParams.json',
  'v2/ThreadGoalSetResponse.json',
  'v2/ThreadGoalClearParams.json',
  'v2/ThreadGoalClearResponse.json',
  'v2/ThreadCompactStartParams.json',
  'v2/ThreadCompactStartResponse.json',
  'v2/SkillsListParams.json',
  'v2/SkillsListResponse.json',
  'v2/ListMcpServerStatusParams.json',
  'v2/ListMcpServerStatusResponse.json',
  'v2/GetAccountRateLimitsResponse.json',
  'v2/TurnStartParams.json',
  'v2/TurnStartResponse.json',
  'v2/TurnStartedNotification.json',
]);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'codex-app-server-contract-'));
  const schemaDirectory = join(temporaryRoot, 'schema');
  const stagingDirectory = join(temporaryRoot, 'fixture');
  mkdirSync(schemaDirectory);
  try {
    if (existsSync(options.outputDirectory)) {
      throw new Error(`output already exists: ${options.outputDirectory}`);
    }
    const cliVersion = await codexOutput(options, ['--version']);
    await codexOutput(options, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      schemaDirectory,
    ]);
    const schemaFiles = listFiles(schemaDirectory);
    if (schemaFiles.length === 0) {
      throw new Error('Codex generated no App Server schema files');
    }
    validateRequiredSchemaFiles(schemaDirectory);
    const schemaDigest = digestJsonSchemaDirectory(schemaDirectory, schemaFiles);
    const manifest = createManifest(options, cliVersion, schemaDigest, schemaFiles.length);
    mkdirSync(stagingDirectory);
    writeJson(join(stagingDirectory, 'manifest.json'), manifest);
    writeJson(
      join(stagingDirectory, 'representative-messages.json'),
      representativeMessages(cliVersion, options.serverUserAgent),
    );
    mkdirSync(dirname(options.outputDirectory), { recursive: true });
    renameSync(stagingDirectory, options.outputDirectory);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('arguments must be provided as --name value pairs');
    }
    values.set(key, value);
  }
  const codexBin = values.get('--codex-bin');
  const output = values.get('--out');
  if (!codexBin || !output) {
    throw new Error('--codex-bin and --out are required');
  }
  const timeoutMs = Number(values.get('--timeout-ms') ?? '30000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  const capturedAt = values.get('--captured-at') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('--captured-at must be an ISO-8601 timestamp');
  }
  return Object.freeze({
    codexBin: resolve(codexBin),
    outputDirectory: resolve(output),
    timeoutMs,
    capturedAt,
    distribution: values.get('--distribution') ?? 'unknown',
    serverUserAgent: values.get('--server-user-agent') ?? null,
  });
}

async function codexOutput(options, args) {
  const result = await execFileAsync(options.codexBin, args, {
    env: captureEnvironment(process.env),
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  return result.stdout.trim();
}

function captureEnvironment(source) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function validateRequiredSchemaFiles(schemaDirectory) {
  for (const relativePath of SCHEMA_FILES) {
    if (!existsSync(join(schemaDirectory, relativePath))) {
      throw new Error(`required App Server schema is missing: ${relativePath}`);
    }
  }
}

function digestJsonSchemaDirectory(root, files) {
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(relative(root, filePath));
    hash.update('\0');
    const schema = JSON.parse(readFileSync(filePath, 'utf8'));
    hash.update(JSON.stringify(canonicalizeJson(schema)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object' && value !== null) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalizeJson(value[key]);
    return result;
  }
  return value;
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && entry.name !== '.DS_Store') files.push(filePath);
    }
  };
  visit(root);
  return files;
}

function createManifest(options, cliVersion, schemaDigest, schemaFileCount) {
  const version = parseExactVersion(CODEX_CLI_VERSION_PATTERN, cliVersion, 'CLI version');
  if (options.serverUserAgent !== null) {
    const userAgentVersion = parseExactVersion(
      APP_SERVER_USER_AGENT_PATTERN,
      options.serverUserAgent,
      'server user agent',
    );
    if (userAgentVersion !== version) {
      throw new Error('server user agent does not attest the captured CLI version');
    }
  }
  return {
    profileId: `app-server-${version}`,
    cliVersion,
    schemaDigest,
    capturedAt: options.capturedAt,
    schemaGeneration: { experimental: true, schemaFileCount },
    source: {
      binaryName: basename(options.codexBin),
      binarySha256: digestFile(options.codexBin),
      distribution: options.distribution,
    },
    handshake: options.serverUserAgent === null
      ? null
      : { mode: 'owned_stdio', userAgent: options.serverUserAgent },
    evidence: {
      representativeMessages: 'representative-messages.json',
      methods: METHODS,
      schemaFiles: SCHEMA_FILES,
    },
  };
}

function digestFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function representativeMessages(cliVersion, serverUserAgent) {
  const version = parseExactVersion(CODEX_CLI_VERSION_PATTERN, cliVersion, 'CLI version');
  return {
    initializeResponse: {
      id: 1,
      result: {
        userAgent: serverUserAgent
          ?? `Codex Desktop/${version} (unverified-platform) dumb (bridge_contract_capture; 2.0.0)`,
        codexHome: '/Users/example/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    },
    threadListRequest: {
      id: 2,
      method: 'thread/list',
      params: { limit: 20, sortKey: 'updated_at', sortDirection: 'desc', archived: false },
    },
    threadListResponse: {
      id: 2,
      result: {
        data: [{
          id: '019f-thread',
          sessionId: '019f-session',
          preview: 'Protocol fixture',
          modelProvider: 'openai',
          createdAt: 1784300000,
          updatedAt: 1784300001,
          status: { type: 'notLoaded' },
          cwd: '/workspace',
          cliVersion: version,
          source: 'appServer',
          turns: [],
          ephemeral: false,
        }],
        nextCursor: null,
      },
    },
    rateLimitsResponse: {
      id: 3,
      result: {
        rateLimits: { limitId: 'codex', limitName: 'Codex', spendControlReached: false },
      },
    },
    turnStartRequest: {
      id: 4,
      method: 'turn/start',
      params: {
        threadId: '019f-thread',
        input: [{ type: 'text', text: 'protocol fixture', text_elements: [] }],
      },
    },
    turnStartResponse: {
      id: 4,
      result: { turn: { id: '019f-turn', items: [], status: 'inProgress' } },
    },
    turnStartedNotification: {
      method: 'turn/started',
      params: {
        threadId: '019f-thread',
        turn: { id: '019f-turn', items: [], status: 'inProgress' },
      },
    },
  };
}

function parseExactVersion(pattern, value, label) {
  const match = pattern.exec(value);
  const version = match?.groups?.version;
  if (version === undefined || hasInvalidNumericPrerelease(match.groups?.prerelease)) {
    throw new Error(`${label} is not an exact SemVer identity`);
  }
  return version;
}

function hasInvalidNumericPrerelease(prerelease) {
  if (prerelease === undefined) return false;
  return prerelease.split('.').some((identifier) => (
    /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')
  ));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`contract capture failed: ${message}\n`);
  process.exitCode = 1;
});
