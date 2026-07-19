import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, normalize } from 'node:path';

import { ConfigurationError, resolveConfigHome } from './config';
import { loadBridgeEnvironment } from './config-file';
import { prepareConfigHome } from './preflight';
import {
  inspectCodexCompatibility,
  type CodexCompatibilityReport,
  type CodexRuntimeProbeConfig,
} from './codex/runtime-contract';

const DEFAULT_MACOS_CODEX_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';

export interface LocalVersionCommandOptions {
  readonly approve?: boolean;
  readonly now?: () => Date;
}

export interface LocalVersionReport {
  readonly configPath: string;
  readonly conclusion: '兼容' | '不兼容';
  readonly compatible: boolean;
  readonly status: 'supported' | 'upgrade_available' | 'incompatible';
  readonly requiresApproval: boolean;
  readonly codexBinary: string;
  readonly codexVersion: string;
  readonly binarySha256: string;
  readonly schemaDigest: string;
  readonly chatGptApp: CodexCompatibilityReport['detection']['chatGptApp'];
  readonly protocolProfileId: string | null;
  readonly supportedVersions: readonly string[];
}

/** Detects and persists local version state without changing the approved support catalog by default. */
export async function runLocalVersionCommand(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: LocalVersionCommandOptions = {},
): Promise<LocalVersionReport> {
  const effectiveEnv = loadBridgeEnvironment(baseEnv);
  const target = resolveProbeConfig(effectiveEnv);
  const report = await inspectCodexCompatibility(target, effectiveEnv, tmpdir(), options);
  return toLocalVersionReport(report);
}

export function formatLocalVersion(report: LocalVersionReport): string {
  const app = report.chatGptApp
    ? `${report.chatGptApp.version} (build ${report.chatGptApp.build})`
    : '未检测到 ChatGPT.app 宿主';
  return [
    `ChatGPT App: ${app}`,
    `Codex: ${report.codexVersion}`,
    `Codex binary: ${report.codexBinary}`,
    `Binary SHA-256: ${report.binarySha256}`,
    `Schema SHA-256: ${report.schemaDigest}`,
    `版本配置: ${report.configPath}`,
    '',
  ].join('\n');
}

export function formatCompatibility(report: LocalVersionReport): string {
  const approval = report.requiresApproval ? '（需要人工确认升级支持版本）' : '';
  return [
    report.conclusion,
    `Codex: ${report.codexVersion}`,
    `状态: ${report.status}${approval}`,
    `协议: ${report.protocolProfileId ?? '未匹配'}`,
    `版本配置: ${report.configPath}`,
    '',
  ].join('\n');
}

function resolveProbeConfig(env: NodeJS.ProcessEnv): CodexRuntimeProbeConfig {
  const configHome = resolveConfigHome(env);
  const preparedConfigHome = prepareConfigHome(configHome);
  const configuredBinary = env.CODEX_BIN?.trim();
  const codexBin = configuredBinary
    || (process.platform === 'darwin' && existsSync(DEFAULT_MACOS_CODEX_BINARY)
      ? DEFAULT_MACOS_CODEX_BINARY
      : '');
  if (!codexBin) {
    throw new ConfigurationError('CODEX_BIN is required when bundled ChatGPT Codex is unavailable');
  }
  const canonicalBinary = canonicalExecutable(codexBin);
  const configuredCwd = env.CODEX_CWD?.trim();
  const codexCwd = canonicalDirectory(configuredCwd || preparedConfigHome, 'CODEX_CWD');
  return Object.freeze({ codexBin: canonicalBinary, codexCwd, configHome: preparedConfigHome });
}

function canonicalExecutable(filePath: string): string {
  if (!isAbsolute(filePath)) {
    throw new ConfigurationError('CODEX_BIN must be an absolute path');
  }
  try {
    const canonicalPath = realpathSync.native(normalize(filePath));
    if (!statSync(canonicalPath).isFile()) {
      throw new Error('not a file');
    }
    accessSync(canonicalPath, constants.X_OK);
    return canonicalPath;
  } catch {
    throw new ConfigurationError('CODEX_BIN must resolve to an executable file');
  }
}

function canonicalDirectory(directoryPath: string, fieldName: string): string {
  if (!isAbsolute(directoryPath)) {
    throw new ConfigurationError(`${fieldName} must be an absolute path`);
  }
  try {
    const canonicalPath = realpathSync.native(normalize(directoryPath));
    if (!statSync(canonicalPath).isDirectory()) {
      throw new Error('not a directory');
    }
    return canonicalPath;
  } catch {
    throw new ConfigurationError(`${fieldName} must resolve to a directory`);
  }
}

function toLocalVersionReport(report: CodexCompatibilityReport): LocalVersionReport {
  const detection = report.detection;
  return Object.freeze({
    configPath: report.configPath,
    conclusion: report.assessment.conclusion,
    compatible: report.assessment.conclusion === '兼容',
    status: report.assessment.status,
    requiresApproval: report.assessment.status === 'upgrade_available',
    codexBinary: detection.codexBinary,
    codexVersion: detection.codexVersion,
    binarySha256: detection.binarySha256,
    schemaDigest: detection.schemaDigest,
    chatGptApp: detection.chatGptApp,
    protocolProfileId: report.assessment.adapterProfileId,
    supportedVersions: Object.freeze(report.config.supportedVersions.map((entry) => entry.codexVersion)),
  });
}
