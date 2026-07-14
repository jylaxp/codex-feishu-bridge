import { parseEnvironment } from './config';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { BridgeDatabase } from './db/database';
import { BridgeRepositories } from './db/repositories';
import { BridgeConfig } from './domain';
import { runPreflight } from './preflight';

export interface DoctorReport {
  readonly ok: true;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly codexVersion: string;
  readonly codexBinary: string;
  readonly appServerMode: BridgeConfig['appServerMode'];
  readonly schemaDigest: string;
  readonly databaseSchemaVersion: number;
  readonly workspace: string;
  readonly allowedWorkspaceRootCount: number;
  readonly allowedChatCount: number;
  readonly authorizedUserCount: number;
  readonly allowedApproverCount: number;
  readonly failedOutboxCount: number;
}

export interface DoctorDependencies {
  readonly verifyRuntimeContract?: typeof verifyCodexRuntimeContract;
}

/** Verifies the exact runtime binary, generated protocol, SQLite, and security boundaries. */
export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const preflight = runPreflight(parseEnvironment(env));
  const config = preflight.config;
  const database = new BridgeDatabase(preflight.dataDirectory.databasePath);
  try {
    database.open();
    const contract = await (dependencies.verifyRuntimeContract ?? verifyCodexRuntimeContract)(
      config,
      env,
      preflight.dataDirectory.temporaryDir,
    );
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get()?.version;
    if (typeof sqliteVersion !== 'string') {
      throw new Error('SQLite version could not be read');
    }
    return Object.freeze({
      ok: true,
      nodeVersion: preflight.nodeVersion,
      sqliteVersion,
      codexVersion: contract.codexVersion,
      codexBinary: config.codexBin,
      appServerMode: config.appServerMode,
      schemaDigest: contract.schemaDigest,
      databaseSchemaVersion: database.getSchemaVersion(),
      workspace: config.codexCwd,
      allowedWorkspaceRootCount: config.allowedWorkspaceRoots.length,
      allowedChatCount: config.allowedChats.length,
      authorizedUserCount: config.authorizedUsers.length,
      allowedApproverCount: config.allowedApprovers.length,
      failedOutboxCount: new BridgeRepositories(database).cardOutbox.countFailed(),
    });
  } finally {
    database.close();
  }
}
