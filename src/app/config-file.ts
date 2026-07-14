import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError, resolveConfigHome } from './config';

export interface ConfigFileOptions {
  readonly homeDirectory?: string;
}

/**
 * Loads the user's private Bridge `.env` without mutating process.env.
 * Explicit process/service-manager variables always take precedence over the
 * file so a deployment can override one value without rewriting credentials.
 */
export function loadBridgeEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  options: ConfigFileOptions = {},
): NodeJS.ProcessEnv {
  const configHome = resolveConfigHome(baseEnv, options.homeDirectory);
  const envPath = join(configHome, '.env');
  if (!existsSync(envPath)) {
    return { ...baseEnv };
  }

  assertRegularConfigFile(configHome, envPath);
  const fromFile = parseEnvironmentFile(readFileSync(envPath, 'utf8'), envPath);
  return { ...fromFile, ...baseEnv };
}

function assertRegularConfigFile(configHome: string, envPath: string): void {
  const homeStat = lstatSync(configHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new ConfigurationError('BRIDGE_CONFIG_HOME must be a real directory, not a symlink');
  }
  const envStat = lstatSync(envPath);
  if (envStat.isSymbolicLink() || !envStat.isFile()) {
    throw new ConfigurationError('Bridge .env must be a regular file, not a symlink');
  }
}

function parseEnvironmentFile(source: string, sourceName: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      throw new ConfigurationError(`${sourceName}:${index + 1} is not a valid environment assignment`);
    }
    parsed[assignment[1]!] = parseValue(assignment[2]!, sourceName, index + 1);
  }
  return parsed;
}

function parseValue(raw: string, sourceName: string, lineNumber: number): string {
  if (!raw) {
    return '';
  }
  if (raw.startsWith("'")) {
    return parseQuotedValue(raw, "'", sourceName, lineNumber);
  }
  if (raw.startsWith('"')) {
    return decodeDoubleQuotedValue(parseQuotedValue(raw, '"', sourceName, lineNumber));
  }
  const commentIndex = raw.search(/\s#/);
  return (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trim();
}

function parseQuotedValue(
  raw: string,
  quote: string,
  sourceName: string,
  lineNumber: number,
): string {
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      const trailing = raw.slice(index + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        throw new ConfigurationError(`${sourceName}:${lineNumber} has invalid trailing content`);
      }
      return raw.slice(1, index);
    }
    escaped = false;
  }
  throw new ConfigurationError(`${sourceName}:${lineNumber} has an unterminated quoted value`);
}

function decodeDoubleQuotedValue(value: string): string {
  return value.replace(/\\([\\"nrt])/g, (_match, escape: string) => {
    if (escape === 'n') {
      return '\n';
    }
    if (escape === 'r') {
      return '\r';
    }
    if (escape === 't') {
      return '\t';
    }
    return escape;
  });
}
