import { statSync } from 'node:fs';

import { BindingStore } from './binding-store';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { BridgeConfig } from './domain';
import { runPreflight } from './preflight';

export interface DoctorReport {
  readonly ok: true;
  readonly nodeVersion: string;
  readonly codexVersion: string;
  readonly codexBinary: string;
  readonly appServerMode: BridgeConfig['appServerMode'];
  readonly schemaDigest: string;
  readonly bindingCount: number;
  readonly bindingsFileBytes: number;
  readonly allowedChatCount: number;
  readonly authorizedUserCount: number;
  readonly allowedApproverCount: number;
}

export interface DoctorDependencies {
  readonly verifyRuntimeContract?: typeof verifyCodexRuntimeContract;
  readonly nodeVersion?: string;
}

/** Reports runtime capabilities without opening a database or reading task history. */
export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const effectiveEnv = loadBridgeEnvironment(env);
  const preflight = runPreflight(parseEnvironment(effectiveEnv), { nodeVersion: dependencies.nodeVersion });
  const store = new BindingStore(preflight.configHome);
  store.load();
  const contract = await (dependencies.verifyRuntimeContract ?? verifyCodexRuntimeContract)(
    preflight.config,
    effectiveEnv,
    preflight.runtimeDirectory.temporaryDir,
  );
  const bindingsFileBytes = statSync(store.filePath, { throwIfNoEntry: false })?.size ?? 0;
  return Object.freeze({
    ok: true,
    nodeVersion: preflight.nodeVersion,
    codexVersion: contract.codexVersion,
    codexBinary: preflight.config.codexBin,
    appServerMode: preflight.config.appServerMode,
    schemaDigest: contract.schemaDigest,
    bindingCount: store.list().length,
    bindingsFileBytes,
    allowedChatCount: preflight.config.allowedChats.length,
    authorizedUserCount: preflight.config.authorizedUsers.length,
    allowedApproverCount: preflight.config.allowedApprovers.length,
  });
}
