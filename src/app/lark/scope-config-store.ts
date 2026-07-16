import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError } from '../config';

export interface LarkScope {
  readonly tenantKey: string;
  readonly allowedChats: string;
  readonly authorizedUsers?: string;
  readonly allowedApprovers?: string;
}

/**
 * Persists only the Feishu event scope learned during first private-chat use.
 * This is configuration bootstrap state, not task/runtime state.
 */
export class LarkScopeConfigStore {
  private readonly envPath: string;

  public constructor(private readonly configHome: string) {
    if (!configHome.trim()) {
      throw new ConfigurationError('config home must not be blank');
    }
    this.envPath = join(configHome, '.env');
  }

  public save(scope: LarkScope): void {
    if (!scope.tenantKey.trim()) {
      throw new ConfigurationError('LARK_TENANT_KEY must not be blank');
    }
    if (!scope.allowedChats.trim()) {
      throw new ConfigurationError('ALLOWED_CHATS must not be blank');
    }

    let updated = readEnvironmentSource(this.configHome, this.envPath);
    updated = setEnvValue(updated, 'LARK_TENANT_KEY', scope.tenantKey.trim());
    updated = setEnvValue(updated, 'ALLOWED_CHATS', scope.allowedChats.trim());
    if (scope.authorizedUsers?.trim()) {
      updated = setEnvValue(updated, 'AUTHORIZED_USERS', scope.authorizedUsers.trim());
    }
    if (scope.allowedApprovers?.trim()) {
      updated = setEnvValue(updated, 'ALLOWED_APPROVERS', scope.allowedApprovers.trim());
    }
    writeFileSync(this.envPath, updated.endsWith('\n') ? updated : `${updated}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function readEnvironmentSource(configHome: string, envPath: string): string {
  if (!existsSync(configHome)) {
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
  }
  const homeStat = lstatSync(configHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new ConfigurationError('BRIDGE_CONFIG_HOME must be a real directory, not a symlink');
  }
  if (!existsSync(envPath)) {
    return '';
  }
  const envStat = lstatSync(envPath);
  if (envStat.isSymbolicLink() || !envStat.isFile()) {
    throw new ConfigurationError('Bridge .env must be a regular file, not a symlink');
  }
  return readFileSync(envPath, 'utf8');
}

function setEnvValue(source: string, key: string, value: string): string {
  const line = `${key}=${formatEnvValue(value)}`;
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  if (!source) {
    return `${line}\n`;
  }
  return `${source.endsWith('\n') ? source : `${source}\n`}${line}\n`;
}

function formatEnvValue(value: string): string {
  if (!/[#\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
