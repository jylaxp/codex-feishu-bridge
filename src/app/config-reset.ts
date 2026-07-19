import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { BindingStore } from './binding-store';
import {
  PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME,
  ProtocolVersionConfigStore,
} from './codex/protocol-version-config';
import { BridgeProcessLock } from './process-lock';

const CONFIG_VERSION_LINE = 'BRIDGE_CONFIG_VERSION=2';
const CONFIG_HOME_NAME = '.codex-feishu-bridge';

export interface ConfigResetReport {
  readonly configHome: string;
  readonly action: 'reset_required' | 'already_current';
  readonly entriesToRemove: readonly string[];
  readonly preservesEnv: boolean;
  readonly requiresConfirmation: boolean;
}

export interface ConfigResetOptions {
  readonly confirm?: boolean;
  readonly destructive?: boolean;
}

export class ConfigResetError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigResetError';
  }
}

/** Returns the portable default without embedding any user's home path. */
export function defaultConfigHome(homeDirectory = homedir()): string {
  return join(homeDirectory, CONFIG_HOME_NAME);
}

/** Lists the reset effect without reading legacy task, approval, or DB content. */
export function inspectConfigReset(configHome: string): ConfigResetReport {
  assertConfigHome(configHome);
  if (!existsSync(configHome)) {
    return Object.freeze({
      configHome,
      action: 'reset_required',
      entriesToRemove: Object.freeze([]),
      preservesEnv: false,
      requiresConfirmation: true,
    });
  }
  const entries = readdirSync(configHome, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const current = isCurrentStructure(configHome, entries);
  return Object.freeze({
    configHome,
    action: current ? 'already_current' : 'reset_required',
    entriesToRemove: Object.freeze(current ? [] : entries),
    preservesEnv: entries.includes('.env'),
    requiresConfirmation: !current,
  });
}

/**
 * Replaces an old config directory as one unit. It copies only .env verbatim;
 * no legacy business state is parsed or migrated.
 */
export function resetConfigHome(
  configHome: string,
  options: ConfigResetOptions = {},
): ConfigResetReport {
  const report = inspectConfigReset(configHome);
  if (report.action === 'already_current' && !options.destructive) {
    return report;
  }
  if (!options.confirm) {
    throw new ConfigResetError('config reset requires explicit confirmation');
  }
  const parent = dirname(configHome);
  const name = basename(configHome);
  const resetLock = new BridgeProcessLock(parent, { lockFileName: resetLockName(configHome) });
  try {
    resetLock.acquire();
  } catch (error) {
    throw new ConfigResetError('Bridge start or another config reset is in progress', { cause: error });
  }
  try {
    if (!existsSync(configHome)) {
      mkdirSync(configHome, { recursive: false, mode: 0o700 });
    }
  } catch (error) {
    resetLock.release();
    throw new ConfigResetError('Config home could not be prepared for reset', { cause: error });
  }
  const bridgeLock = new BridgeProcessLock(configHome);
  try {
    bridgeLock.acquire();
  } catch (error) {
    resetLock.release();
    throw new ConfigResetError('Bridge must be stopped before config reset', { cause: error });
  }
  const protocolLock = new BridgeProcessLock(configHome, {
    lockFileName: PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME,
  });
  try {
    protocolLock.acquire();
  } catch (error) {
    bridgeLock.release();
    resetLock.release();
    throw new ConfigResetError(
      'Protocol version inspection or approval must finish before config reset',
      { cause: error },
    );
  }
  const staging = join(parent, `.${name}.staging-${randomUUID()}`);
  const rollback = join(parent, `.${name}.rollback-${randomUUID()}`);
  let movedOldDirectory = false;
  try {
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    copyEnvironmentIfPresent(configHome, staging);
    writeFileSync(join(staging, 'bindings.json'), '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const store = new BindingStore(staging);
    store.load();

    if (existsSync(configHome)) {
      renameSync(configHome, rollback);
      movedOldDirectory = true;
    }
    renameSync(staging, configHome);
    if (movedOldDirectory) {
      rmSync(rollback, { recursive: true, force: true });
    }
    return inspectConfigReset(configHome);
  } catch (error) {
    if (!existsSync(configHome) && movedOldDirectory && existsSync(rollback)) {
      try {
        renameSync(rollback, configHome);
      } catch {
        // Keep the original reset failure; the rollback path remains visible.
      }
    }
    rmSync(staging, { recursive: true, force: true });
    throw error instanceof ConfigResetError
      ? error
      : new ConfigResetError('config reset could not replace the configuration directory', {
          cause: error,
        });
  } finally {
    protocolLock.release();
    bridgeLock.release();
    resetLock.release();
  }
}

/**
 * Excludes reset before startup preflight creates or validates the config home.
 * The caller must release the returned lock after it has acquired bridge.lock.
 */
export function acquireConfigResetExclusion(configHome: string): BridgeProcessLock {
  const lock = new BridgeProcessLock(dirname(configHome), { lockFileName: resetLockName(configHome) });
  try {
    lock.acquire();
    return lock;
  } catch (error) {
    throw new ConfigResetError('Bridge configuration reset is in progress', { cause: error });
  }
}

function assertConfigHome(configHome: string): void {
  if (!configHome.trim()) {
    throw new ConfigResetError('config home must not be blank');
  }
  if (existsSync(configHome) && !lstatSync(configHome).isDirectory()) {
    throw new ConfigResetError('config home must be a directory');
  }
}

function isCurrentStructure(configHome: string, entries: readonly string[]): boolean {
  const allowed = new Set(['.env', 'bindings.json', 'protocol-versions.json']);
  if (entries.some((entry) => !allowed.has(entry))) {
    return false;
  }
  if (!hasCurrentConfigVersion(configHome, entries)) {
    return false;
  }
  const bindingsPath = join(configHome, 'bindings.json');
  if (!existsSync(bindingsPath)) {
    return false;
  }
  try {
    const store = new BindingStore(configHome);
    store.load();
    if (entries.includes('protocol-versions.json')) {
      new ProtocolVersionConfigStore(configHome).loadOrCreate();
    }
    return true;
  } catch {
    return false;
  }
}

function hasCurrentConfigVersion(configHome: string, entries: readonly string[]): boolean {
  if (!entries.includes('.env')) {
    return true;
  }
  try {
    return /^(?:export\s+)?BRIDGE_CONFIG_VERSION\s*=\s*2\s*$/m.test(
      readFileSync(join(configHome, '.env'), 'utf8'),
    );
  } catch {
    return false;
  }
}

function copyEnvironmentIfPresent(oldHome: string, staging: string): void {
  const oldEnv = join(oldHome, '.env');
  if (!existsSync(oldEnv)) {
    writeFileSync(join(staging, '.env'), `${CONFIG_VERSION_LINE}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return;
  }
  const source = readFileSync(oldEnv, 'utf8');
  const withTrailingNewline = source.endsWith('\n') ? source : `${source}\n`;
  const upgraded = /^(?:export\s+)?BRIDGE_CONFIG_VERSION\s*=.*$/m.test(withTrailingNewline)
    ? withTrailingNewline.replace(/^(?:export\s+)?BRIDGE_CONFIG_VERSION\s*=.*$/m, CONFIG_VERSION_LINE)
    : `${withTrailingNewline}${CONFIG_VERSION_LINE}\n`;
  writeFileSync(join(staging, '.env'), upgraded, { encoding: 'utf8', mode: 0o600 });
}

function resetLockName(configHome: string): string {
  const name = basename(configHome);
  return `${name.startsWith('.') ? name : `.${name}`}.reset.lock`;
}
