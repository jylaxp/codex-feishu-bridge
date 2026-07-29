import { statSync } from 'node:fs';

import { BindingStore } from './binding-store';
import { BotConfigStore } from './bot-config-store';
import {
  appServerIdentityAssurance,
  type AppServerIdentityAssurance,
} from './codex/app-server-client';
import { adapterForAppServerProfile } from './codex/app-server-control-plane';
import type { AppServerProtocolProfileId } from './codex/app-server-protocol-registry';
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
  readonly appServerIdentityAssurance: AppServerIdentityAssurance;
  readonly protocolProfileId: AppServerProtocolProfileId;
  readonly approvalCardMode: BridgeConfig['approvalCardMode'];
  readonly platform: NodeJS.Platform;
  readonly desktopAttachedSupported: boolean;
  readonly schemaDigest: string;
  readonly bindingCount: number;
  readonly bindingsFileBytes: number;
  readonly allowedChatCount: number;
  readonly authorizedUserCount: number;
  readonly allowedApproverCount: number;
  readonly botCount: number;
  readonly enabledBotCount: number;
  readonly bots: readonly DoctorBotReport[];
}

export interface DoctorBotReport {
  readonly botKey: string;
  readonly appId: string;
  readonly enabled: boolean;
  readonly tenantKeyConfigured: boolean;
  readonly allowedChatCount: number;
  readonly authorizedUserCount: number;
  readonly allowedApproverCount: number;
  readonly allowGroupUserMentions: boolean;
  readonly allowExternalGroupUserMentions: boolean;
  readonly allowGroupBotMentions: boolean;
  readonly identityResolved: boolean;
  readonly roleProfileConfigured: boolean;
  readonly groupBindingCount: number;
  readonly groupBotMentionReadyCount: number;
  readonly displayName?: string;
}

export interface DoctorDependencies {
  readonly verifyRuntimeContract?: typeof verifyCodexRuntimeContract;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
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
  const botStore = new BotConfigStore(preflight.configHome);
  botStore.load(preflight.config);
  const contract = await (dependencies.verifyRuntimeContract ?? verifyCodexRuntimeContract)(
    preflight.config,
    effectiveEnv,
    preflight.runtimeDirectory.temporaryDir,
  );
  adapterForAppServerProfile(contract.protocolProfile);
  const bindingsFileBytes = statSync(store.filePath, { throwIfNoEntry: false })?.size ?? 0;
  const platform = dependencies.platform ?? process.platform;
  return Object.freeze({
    ok: true,
    nodeVersion: preflight.nodeVersion,
    codexVersion: contract.codexVersion,
    codexBinary: preflight.config.codexBin,
    appServerMode: preflight.config.appServerMode,
    appServerIdentityAssurance: appServerIdentityAssurance(preflight.config.appServerMode),
    protocolProfileId: contract.protocolProfile.id,
    approvalCardMode: preflight.config.approvalCardMode,
    platform,
    desktopAttachedSupported: platform === 'darwin',
    schemaDigest: contract.schemaDigest,
    bindingCount: store.list().length,
    bindingsFileBytes,
    allowedChatCount: preflight.config.allowedChats.length,
    authorizedUserCount: preflight.config.authorizedUsers.length,
    allowedApproverCount: preflight.config.allowedApprovers.length,
    botCount: botStore.list().length,
    enabledBotCount: botStore.activeBots().length,
    bots: Object.freeze(botStore.list().map((bot) => {
      const botBindings = store.list().filter((binding) => (binding.botKey ?? 'default') === bot.botKey);
      return Object.freeze({
        botKey: bot.botKey,
        appId: bot.appId,
        enabled: bot.enabled,
        tenantKeyConfigured: bot.tenantKey.length > 0,
        allowedChatCount: bot.allowedChats.length,
        authorizedUserCount: bot.authorizedUsers.length,
        allowedApproverCount: bot.allowedApprovers.length,
        allowGroupUserMentions: bot.allowGroupUserMentions,
        allowExternalGroupUserMentions: bot.allowExternalGroupUserMentions,
        allowGroupBotMentions: bot.allowGroupBotMentions,
        identityResolved: Boolean(bot.botOpenId),
        roleProfileConfigured: Boolean(bot.roleProfile),
        groupBindingCount: botBindings.length,
        groupBotMentionReadyCount: bot.allowGroupBotMentions ? botBindings.length : 0,
        ...(bot.displayName ? { displayName: bot.displayName } : {}),
      });
    })),
  });
}
