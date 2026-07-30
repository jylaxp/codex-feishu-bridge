import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { BindingStore, type ChatThreadBinding } from './binding-store';
import {
  BotConfigStore,
  botConfigToBridgeConfig,
  DEFAULT_BOT_KEY,
  type LarkBotConfig,
} from './bot-config-store';
import { CardKitClient, type LarkReplyApi } from './cards/cardkit-client';
import { CardImageRenderer, type LarkImageApi } from './cards/card-image-renderer';
import {
  createImageBatchCancelledCard,
  createImageBatchEmptyCard,
  createImageBatchSubmittedCard,
  createImageCountErrorCard,
  createImageInputErrorCard,
  createImageInputOverloadedCard,
  createImagePendingCard,
  createImageSubmissionFailedCard,
  createBotUnavailableCard,
  createQueueFullCard,
} from './cards/layouts';
import { AppServerClient, type AppServerTransportOptions } from './codex/app-server-client';
import {
  AppServerControlPlane,
  adapterForAppServerProfile,
  type AppServerRequestClient,
} from './codex/app-server-control-plane';
import { DesktopIpcClient, DesktopIpcRequestError } from './codex/desktop-ipc-client';
import { DESKTOP_IPC_CONTRACT } from './codex/desktop-ipc-contract';
import { DesktopIpcSupervisor } from './codex/desktop-ipc-supervisor';
import type { DesktopIpcSupervisorState } from './codex/desktop-ipc-supervisor';
import { DesktopThreadStreamNormalizer } from './codex/desktop-thread-stream-normalizer';
import { CodexAppNavigationAdapter } from './codex/app-navigation-adapter';
import type { ServerNotification } from './codex/protocol';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { BridgeCommandService } from './command-service';
import { ConversationBindingServiceV3 } from './conversation-binding-service-v3';
import { DesktopApprovalService } from './desktop-approval-service';
import { BridgeConfig } from './domain';
import { ExternalBotDirectoryStore } from './external-bot-directory';
import { buildCollaborationContext } from './collaboration/collaboration-context';
import { HandoffCoordinator } from './collaboration/handoff-coordinator';
import { parseHandoffEnvelope } from './collaboration/handoff-directive';
import {
  evaluateGroupBotSenderMention,
  shouldSuppressExternalGroupUserMention,
} from './group-access-policy';
import {
  InMemoryOrchestrator,
  type DesktopDeliveryOutcome,
} from './in-memory-orchestrator';
import { CachedTenantTokenProvider, createLarkRuntimeClients } from './lark/client';
import { GroupBotDiscoveryService } from './lark/group-bot-discovery';
import { HandoffMessageEmitter, type LarkHandoffMessageApi } from './lark/handoff-message-emitter';
import {
  LarkMessageAcknowledgement,
  type LarkMessageAcknowledgementApi,
} from './lark/message-acknowledgement';
import { OutputFileUploader, type FileUploadApi } from './lark/output-file-uploader';
import { LarkEventServer, toast, type LarkUnavailableReason } from './lark/event-server';
import {
  isGroupManagementCommandText,
  isTextOnlyInboundMessage,
  type InboundMessage,
  type InboundReplyContext,
} from './lark/intake';
import {
  InboundImageStore,
  type LarkMessageResourceApi,
} from './lark/inbound-image-store';
import {
  InboundMessageAggregator,
  MAX_INBOUND_IMAGES,
} from './lark/inbound-message-aggregator';
import { LarkScopeConfigStore, type LarkScope } from './lark/scope-config-store';
import { BridgeLogger } from './logger';
import { runPreflight } from './preflight';
import { BridgeProcessLock } from './process-lock';
import { RateLimitCache } from './rate-limit-cache';
import { acquireConfigResetExclusion } from './config-reset';
import {
  RuntimeHealthPublisher,
  RuntimeHealthStore,
  resolveRuntimeHealthStatus,
  type DesktopRouteState,
  type RuntimeHealthSnapshot,
} from './runtime-health';
import type { LarkWebsocketConnectionSnapshot } from './lark/client';

export interface BridgeRuntime {
  readonly config: BridgeConfig;
  readonly failure: Promise<Error>;
  stop(): Promise<void>;
}

const BINDING_DESKTOP_SNAPSHOT_TIMEOUT_MS = 5_000;
const DESKTOP_ROUTE_RECOVERY_TIMEOUT_MS = 5_000;

interface BotRuntime {
  readonly botKey: string;
  readonly config: BridgeConfig;
  readonly bot: LarkBotConfig;
  readonly lark: ReturnType<typeof createLarkRuntimeClients>;
  readonly cardImages: CardImageRenderer;
  readonly cards: CardKitClient;
  readonly acknowledgements: LarkMessageAcknowledgement;
  readonly inboundImages: InboundImageStore;
  readonly outputFileUploader: OutputFileUploader;
  eventServer?: LarkEventServer;
}

type RuntimeUnavailableReason = LarkUnavailableReason | 'GROUP_NOT_BOUND';

/**
 * Starts the ephemeral Desktop-follower Bridge. The only business file loaded
 * here is bindings.json; an interrupted process never recovers or replays a
 * task, card update, approval, queue item, or user prompt.
 */
export async function startBridge(
  env: NodeJS.ProcessEnv = process.env,
  logger: BridgeLogger = new BridgeLogger(),
): Promise<BridgeRuntime> {
  const effectiveEnv = loadBridgeEnvironment(env);
  const parsedConfig = parseEnvironment(effectiveEnv);
  const resetExclusion = acquireConfigResetExclusion(parsedConfig.configHome ?? '');
  let preflight: ReturnType<typeof runPreflight>;
  let processLock: BridgeProcessLock;
  try {
    preflight = runPreflight(parsedConfig);
    logger.configure({
      configHome: preflight.configHome,
      logToFile: preflight.config.logToFile,
      logFilePath: preflight.config.logFilePath,
    });
    processLock = new BridgeProcessLock(preflight.configHome);
    processLock.acquire();
  } finally {
    resetExclusion.release();
  }
  // Keep one shared runtime view so first-private-message scope bootstrap is
  // immediately visible to command, approval and cancellation handlers.
  const config = { ...preflight.config } as BridgeConfig;

  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });
  const bindings = new BindingStore(preflight.configHome);
  const botStore = new BotConfigStore(preflight.configHome);
  const externalBotDirectory = new ExternalBotDirectoryStore(preflight.configHome);
  let runtimeContract: Awaited<ReturnType<typeof verifyCodexRuntimeContract>>;
  let protocolAdapter: ReturnType<typeof adapterForAppServerProfile>;
  try {
    bindings.load();
    botStore.load(config);
    externalBotDirectory.load();
    runtimeContract = await verifyCodexRuntimeContract(
      config,
      effectiveEnv,
      preflight.runtimeDirectory.temporaryDir,
    );
    protocolAdapter = adapterForAppServerProfile(runtimeContract.protocolProfile);
  } catch (error) {
    processLock.release();
    throw error;
  }
  const appServer = new AppServerClient({
    transport: appServerTransport(config, effectiveEnv),
    protocolProfile: runtimeContract.protocolProfile,
    clientInfo: {
      name: 'lark_codex_gateway',
      title: 'Lark Codex Gateway',
      version: '3.0.0',
    },
  });
  const appServerControlPlane = new AppServerControlPlane(appServer, protocolAdapter);
  const desktop = new DesktopIpcClient();
  await desktop.syncFollowedThreads(bindings.list().map((binding) => binding.threadId));
  const configuredBots = botStore.list();
  if (configuredBots.length === 0) {
    processLock.release();
    throw new Error('No Feishu bot is configured');
  }
  const enabledBots = configuredBots.filter((bot) => bot.enabled);
  const botConfigs = new Map<string, BridgeConfig>(
    configuredBots.map((bot) => [bot.botKey, { ...botConfigToBridgeConfig(config, bot) } as BridgeConfig]),
  );
  let orchestrator: InMemoryOrchestrator | undefined;
  let messageAggregator: InboundMessageAggregator | undefined;
  let inboundGeneration = 0;
  const healthStore = new RuntimeHealthStore(preflight.configHome);
  let runtimeStarted = false;
  let runtimeStopped = false;
  let appServerState: RuntimeHealthSnapshot['appServer']['state'] = 'starting';
  let desktopState: DesktopIpcSupervisorState = 'STOPPED';
  let desktopEpoch: number | null = null;
  let desktopRouteState: DesktopRouteState = 'unknown';
  let lastDesktopDeliveryErrorCode: string | null = null;
  const unavailableDesktopThreads = new Set<string>();
  let handoffCoordinator: HandoffCoordinator | undefined;
  let larkConnection: LarkWebsocketConnectionSnapshot = Object.freeze({
    state: 'idle',
    reconnectCount: 0,
    connectedAtMs: null,
  });
  const writeHealth = (): void => {
    const status = resolveRuntimeHealthStatus({
      runtimeStarted,
      runtimeStopped,
      appServerState,
      desktopState,
      desktopRouteState,
      larkState: larkConnection.state,
    });
    try {
      healthStore.write(Object.freeze({
        schemaVersion: 1,
        pid: process.pid,
        supervisorPid: process.ppid,
        updatedAt: new Date().toISOString(),
        status,
        appServer: Object.freeze({
          state: appServerState,
          protocolContractId: runtimeContract.protocolProfile.id,
          schemaDigest: runtimeContract.schemaDigest,
          artifactSha256: runtimeContract.runtimeArtifact.binarySha256,
        }),
        desktop: Object.freeze({
          state: desktopState,
          epoch: desktopEpoch,
          contractId: DESKTOP_IPC_CONTRACT.id,
          routeState: desktopRouteState,
          unavailableThreadCount: unavailableDesktopThreads.size,
          lastDeliveryErrorCode: lastDesktopDeliveryErrorCode,
        }),
        lark: larkConnection,
        tasks: orchestrator?.runtimeTaskHealth()
          ?? Object.freeze({ active: 0, queued: 0, pendingCardDeliveries: 0 }),
        collaboration: handoffCoordinator?.snapshot()
          ?? Object.freeze({ emitted: 0, accepted: 0, blocked: 0, duplicate: 0, loopBlocked: 0 }),
      }));
    } catch (error) {
      logger.error('runtime_health_write_failed', error);
    }
  };
  const healthPublisher = new RuntimeHealthPublisher(writeHealth);
  const publishHealth = (): void => healthPublisher.request();
  const updateDesktopDeliveryHealth = (outcome: DesktopDeliveryOutcome): void => {
    const fields = {
      operation: outcome.operation,
      threadId: outcome.threadId,
      chatId: outcome.chatId,
      messageId: outcome.messageId,
    };
    if (outcome.status === 'succeeded') {
      unavailableDesktopThreads.delete(outcome.threadId);
      desktopRouteState = unavailableDesktopThreads.size > 0 ? 'unavailable' : 'ready';
      if (unavailableDesktopThreads.size === 0) {
        lastDesktopDeliveryErrorCode = null;
      }
      logger.info('desktop_delivery_succeeded', fields);
      return;
    }

    const error = outcome.error;
    if (error instanceof DesktopIpcRequestError) {
      lastDesktopDeliveryErrorCode = error.remoteError ?? error.code;
      if (error.disposition === 'PROVABLY_UNSENT') {
        unavailableDesktopThreads.add(outcome.threadId);
      } else if (error.disposition === 'DEFINITIVE_FAILURE') {
        unavailableDesktopThreads.delete(outcome.threadId);
      }
      desktopRouteState = unavailableDesktopThreads.size > 0
        ? 'unavailable'
        : error.disposition === 'OUTCOME_UNKNOWN' ? 'unknown' : 'ready';
      logger.error('desktop_delivery_failed', error, {
        ...fields,
        disposition: error.disposition,
        remoteError: error.remoteError,
        routeState: desktopRouteState,
      });
      return;
    }

    unavailableDesktopThreads.add(outcome.threadId);
    desktopRouteState = 'unavailable';
    lastDesktopDeliveryErrorCode = 'DESKTOP_IPC_LOCAL_ERROR';
    logger.error('desktop_delivery_failed', error, {
      ...fields,
      disposition: 'PROVABLY_UNSENT',
      remoteError: null,
      routeState: desktopRouteState,
    });
  };
  healthPublisher.flush();
  const botRuntimes = new Map<string, BotRuntime>();
  const larkConnections = new Map<string, LarkWebsocketConnectionSnapshot>();
  const aggregateLarkConnection = (): LarkWebsocketConnectionSnapshot => aggregateLarkConnections(
    [...larkConnections.values()],
  );
  const configForBotKey = (botKey: string): BridgeConfig | undefined => botConfigs.get(botKey);
  const runtimeForBotKey = (botKey: string): BotRuntime => {
    const runtime = botRuntimes.get(botKey);
    if (!runtime) {
      throw new Error(`No enabled Feishu bot runtime for ${botKey}`);
    }
    return runtime;
  };
  const cardsForBotKey = (botKey: string): CardKitClient | undefined => botRuntimes.get(botKey)?.cards;
  const handoffEmitterForBotKey = (botKey: string): HandoffMessageEmitter | undefined => {
    const runtime = botRuntimes.get(botKey);
    return runtime
      ? new HandoffMessageEmitter(runtime.lark.api as unknown as LarkHandoffMessageApi)
      : undefined;
  };
  const approveNotificationImages = (notification: ServerNotification): void => {
    const paths = notificationLocalImagePaths(notification);
    if (paths.length === 0) {
      return;
    }
    for (const runtime of botRuntimes.values()) {
      runtime.cardImages.approve(paths);
    }
  };
  let desktopThreadFollowingWrite = Promise.resolve();
  const syncDesktopThreadFollowing = async (): Promise<void> => {
    const threadIds = new Set(bindings.list().map((binding) => binding.threadId));
    for (const threadId of orchestrator?.activeThreadIds() ?? []) {
      threadIds.add(threadId);
    }
    const write = desktopThreadFollowingWrite.then(() => desktop.syncFollowedThreads(threadIds));
    desktopThreadFollowingWrite = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      logger.error('desktop_thread_following_sync_failed', error);
    }
  };
  const normalizer = new DesktopThreadStreamNormalizer();
  for (const bot of configuredBots) {
    const scopedConfig = botConfigs.get(bot.botKey);
    if (!scopedConfig) {
      continue;
    }
    larkConnections.set(bot.botKey, Object.freeze({
      state: 'idle',
      reconnectCount: 0,
      connectedAtMs: null,
    }));
    const lark = createLarkRuntimeClients(scopedConfig, {
      logSink: (level) => logger.warn(`lark_sdk_${level}`, { botKey: bot.botKey }),
      onTerminalWebsocketError: resolveFailure,
      onWebsocketStateChanged: (snapshot) => {
        larkConnections.set(bot.botKey, snapshot);
        larkConnection = aggregateLarkConnection();
        logger.info('lark_websocket_state_changed', {
          botKey: bot.botKey,
          state: snapshot.state,
          reconnectCount: snapshot.reconnectCount,
        });
        if (snapshot.state === 'ready' && snapshot.reconnectCount > 0) {
          orchestrator?.resumeCardDelivery();
        }
        publishHealth();
      },
    });
    const cardImages = new CardImageRenderer(
      lark.api as unknown as LarkImageApi,
      [scopedConfig.codexCwd, resolveCodexVisualizationsRoot(effectiveEnv)],
    );
    const cards = new CardKitClient(
      new CachedTenantTokenProvider(scopedConfig.larkAppId, scopedConfig.larkAppSecret),
      lark.api as unknown as LarkReplyApi,
      fetch,
      10_000,
      (card) => cardImages.render(card),
    );
    botRuntimes.set(bot.botKey, {
      botKey: bot.botKey,
      config: scopedConfig,
      bot,
      lark,
      cardImages,
      cards,
      acknowledgements: new LarkMessageAcknowledgement(
        lark.api as unknown as LarkMessageAcknowledgementApi,
        logger,
      ),
      inboundImages: new InboundImageStore(
        lark.api as unknown as LarkMessageResourceApi,
        preflight.runtimeDirectory.temporaryDir,
      ),
      outputFileUploader: new OutputFileUploader(scopedConfig, lark.api as unknown as FileUploadApi),
    });
  }
  larkConnection = aggregateLarkConnection();
  const defaultRuntime = botRuntimes.get(DEFAULT_BOT_KEY)
    ?? enabledBots.map((bot) => botRuntimes.get(bot.botKey)).find(Boolean)
    ?? botRuntimes.values().next().value;
  if (!defaultRuntime) {
    processLock.release();
    throw new Error('No Feishu bot runtime could be created');
  }
  const rateLimits = new RateLimitCache(
    () => appServerControlPlane.request('account/rateLimits/read', {}),
    config.rateLimitQueryIntervalMs,
  );
  const navigation = new CodexAppNavigationAdapter();
  const groupBotDiscovery = new GroupBotDiscoveryService(externalBotDirectory, {
    localBots: () => botStore.list(),
    logger: {
      info: (event, fields) => logger.info(event, scalarLogFields(fields)),
      warn: (event, fields) => logger.warn(event, scalarLogFields(fields)),
    },
  });
  const refreshExternalGroupBots = async (
    runtime: BotRuntime,
    tenantKey: string,
    chatId: string,
    force = false,
  ): Promise<void> => {
    try {
      await groupBotDiscovery.refreshGroup({
        sourceBot: runtime.bot,
        tenantKey,
        chatId,
        force,
      });
    } catch (error) {
      logger.error('lark_group_bots_discovery_failed', error, {
        botKey: runtime.botKey,
        tenantKey,
        chatId,
      });
    }
  };
  const refreshKnownGroupBotDirectories = async (): Promise<void> => {
    const groupBindings = bindings.list().filter((binding) => binding.chatType === 'group');
    if (groupBindings.length === 0) {
      return;
    }
    let attempted = 0;
    for (const binding of groupBindings) {
      const runtime = botRuntimes.get(binding.botKey ?? DEFAULT_BOT_KEY);
      if (!runtime || !runtime.bot.enabled) {
        continue;
      }
      attempted += 1;
      await refreshExternalGroupBots(runtime, binding.tenantKey, binding.chatId, true);
    }
    logger.info('lark_group_bots_startup_discovery_completed', {
      groupBindingCount: groupBindings.length,
      attempted,
    });
  };
  handoffCoordinator = new HandoffCoordinator({
    bots: () => botStore.list(),
    bindingFor: (tenantKey, chatId, targetBotKey) => bindings.get(tenantKey, chatId, targetBotKey),
    emitterForSourceBot: handoffEmitterForBotKey,
    externalBotDirectoryForGroup: (sourceBotKey, tenantKey, chatId, selector) => (
      externalBotDirectory.resolveForGroup(sourceBotKey, tenantKey, chatId, selector)
    ),
    runnerReadinessForBinding: () => {
      if (process.platform === 'win32') {
        return { ready: false, reason: 'windows_desktop_attached_not_ready' };
      }
      if (desktopState !== 'READY') {
        return { ready: false, reason: 'desktop_ipc_not_ready' };
      }
      return { ready: true };
    },
  });
  orchestrator = new InMemoryOrchestrator(config, desktop, defaultRuntime.cards, {
    onCardError: (error) => logger.error('card_update_failed', error),
    cardClientForBotKey: cardsForBotKey,
    larkSecretForBotKey: (botKey) => configForBotKey(botKey)?.larkAppSecret,
    readRateLimits: () => rateLimits.get(),
    uploadOutputFilesForBotKey: (botKey, answer, rootMessageId, taskId) => (
      runtimeForBotKey(botKey).outputFileUploader.uploadMarkdownFiles(answer, rootMessageId, taskId)
    ),
    resolveBindingByThreadId: (threadId) => bindings.getUniqueByThreadId(threadId),
    isBindingCurrent: (candidate) => (
      bindings.get(candidate.tenantKey, candidate.chatId, candidate.botKey)?.threadId === candidate.threadId
    ),
    requestThreadSnapshot: (threadId) => desktop.requestThreadFollowingSnapshot(threadId),
    readThreadTitle: (threadId) => readThreadTitle(appServerControlPlane, threadId),
    readSkills: (cwd) => appServerControlPlane.request('skills/list', { cwds: [cwd] }),
    onActiveThreadsChanged: () => {
      void syncDesktopThreadFollowing();
    },
    onRuntimeHealthChanged: publishHealth,
    onDesktopDeliveryOutcome: (outcome) => {
      updateDesktopDeliveryHealth(outcome);
      publishHealth();
    },
    recoverDesktopThreadRoute: async (threadId) => {
      logger.info('desktop_route_recovery_started', { threadId });
      try {
        await navigation.openThread(threadId);
      } catch (error) {
        logger.error('desktop_route_recovery_open_failed', error, { threadId });
        return false;
      }
      const recovered = await desktop.waitForThreadFollowingSnapshot(
        threadId,
        DESKTOP_ROUTE_RECOVERY_TIMEOUT_MS,
      );
      logger.info('desktop_route_recovery_completed', { threadId, recovered });
      return recovered;
    },
    releaseInboundImages: (paths) => {
      defaultRuntime.cardImages.revoke(paths);
      void defaultRuntime.inboundImages.release(paths).catch((error: unknown) => {
        logger.error('lark_inbound_image_cleanup_failed', toError(error), { count: paths.length });
      });
    },
    releaseInboundImagesForBotKey: (botKey, paths) => {
      const runtime = botRuntimes.get(botKey);
      if (!runtime) {
        return;
      }
      runtime.cardImages.revoke(paths);
      void runtime.inboundImages.release(paths).catch((error: unknown) => {
        logger.error('lark_inbound_image_cleanup_failed', toError(error), {
          botKey,
          count: paths.length,
        });
      });
    },
    collaborationContextForBinding: (binding) => buildCollaborationContext({
      binding,
      currentBot: botStore.get(binding.botKey ?? DEFAULT_BOT_KEY),
      bots: botStore.list(),
      targetBindings: bindings.list().filter((candidate) => (
        candidate.tenantKey === binding.tenantKey && candidate.chatId === binding.chatId
      )),
      externalTargets: externalBotDirectory.listForGroup(
        binding.botKey ?? DEFAULT_BOT_KEY,
        binding.tenantKey,
        binding.chatId,
      ),
    }),
    handleTerminalHandoff: (context) => handoffCoordinator?.handleTerminalHandoff(context) ?? Promise.resolve(null),
  });
  const approvals = new DesktopApprovalService(config, desktop, defaultRuntime.cards, orchestrator, Date.now, {
    configForBotKey,
    cardsForBotKey,
  });
  const conversationBindingsByBot = new Map<string, ConversationBindingServiceV3>();
  const commandsByBot = new Map<string, BridgeCommandService>();
  const projectActiveDesktopTurn = async (binding: ChatThreadBinding): Promise<boolean> => {
    if (!orchestrator) {
      return false;
    }
    await syncDesktopThreadFollowing();
    const snapshotAvailable = await desktop.waitForThreadFollowingSnapshot(
      binding.threadId,
      BINDING_DESKTOP_SNAPSHOT_TIMEOUT_MS,
    );
    if (!snapshotAvailable || !normalizer.hasThreadSnapshot(binding.threadId)) {
      throw new Error('Desktop thread snapshot is unavailable for binding projection');
    }
    const notifications = normalizer.activeTurnSnapshot(binding.threadId);
    if (notifications.length === 0) {
      return false;
    }
    for (const notification of notifications) {
      approveNotificationImages(notification);
      orchestrator.handleNotification(notification);
    }
    return true;
  };
  const persistAllowedBindingChat = (binding: ChatThreadBinding): void => {
    const runtime = botRuntimes.get(binding.botKey ?? DEFAULT_BOT_KEY);
    if (!runtime) {
      return;
    }
    const currentConfig = runtime.config;
    const nextTenantKey = currentConfig.larkTenantKey || binding.tenantKey;
    const nextAllowedChats = currentConfig.allowedChats.includes(binding.chatId)
      ? currentConfig.allowedChats
      : Object.freeze([...currentConfig.allowedChats, binding.chatId]);
    if (nextTenantKey === currentConfig.larkTenantKey && nextAllowedChats === currentConfig.allowedChats) {
      return;
    }
    Object.assign(currentConfig, {
      larkTenantKey: nextTenantKey,
      allowedChats: nextAllowedChats,
    });
    botConfigs.set(runtime.botKey, currentConfig);
    persistBotScope(runtime.botKey, {
      tenantKey: nextTenantKey,
      allowedChats: nextAllowedChats.join(','),
      authorizedUsers: currentConfig.authorizedUsers.join(','),
      allowedApprovers: currentConfig.allowedApprovers.join(','),
    }, botStore, config, preflight.configHome);
    logger.info('binding_scope_chat_allowed', {
      botKey: runtime.botKey,
      chatId: binding.chatId,
    });
  };
  const handleBindingCreated = (binding: ChatThreadBinding): void => {
    persistAllowedBindingChat(binding);
    if (binding.chatType !== 'group') {
      return;
    }
    const runtime = botRuntimes.get(binding.botKey ?? DEFAULT_BOT_KEY);
    if (!runtime || !runtime.bot.enabled) {
      return;
    }
    void refreshExternalGroupBots(runtime, binding.tenantKey, binding.chatId, true);
  };
  for (const runtime of botRuntimes.values()) {
    conversationBindingsByBot.set(runtime.botKey, new ConversationBindingServiceV3(
      runtime.config,
      bindings,
      appServerControlPlane,
      runtime.cards,
      undefined,
      navigation,
      logger,
      undefined,
      () => rateLimits.get(),
      projectActiveDesktopTurn,
      handleBindingCreated,
      () => botStore.list(),
    ));
    commandsByBot.set(runtime.botKey, new BridgeCommandService(
      runtime.config,
      bindings,
      appServerControlPlane,
      runtime.cards,
      orchestrator,
      navigation,
      undefined,
      rateLimits,
      undefined,
      handleBindingCreated,
    ));
  }
  const conversationBindingsFor = (botKey: string): ConversationBindingServiceV3 => {
    const service = conversationBindingsByBot.get(botKey);
    if (!service) {
      throw new Error(`No binding service for bot ${botKey}`);
    }
    return service;
  };
  const commandsFor = (botKey: string): BridgeCommandService => {
    const service = commandsByBot.get(botKey);
    if (!service) {
      throw new Error(`No command service for bot ${botKey}`);
    }
    return service;
  };
  const desktopSupervisor = new DesktopIpcSupervisor(desktop, {
    onReady: (handshake) => {
      desktopState = 'READY';
      desktopEpoch = handshake.epoch;
      desktopRouteState = 'unknown';
      lastDesktopDeliveryErrorCode = null;
      unavailableDesktopThreads.clear();
      normalizer.beginEpoch(handshake.epoch);
      logger.info('desktop_ipc_ready', { epoch: handshake.epoch });
      publishHealth();
    },
    onDisconnected: async (epoch) => {
      inboundGeneration += 1;
      desktopState = 'RECONNECTING';
      desktopEpoch = epoch;
      desktopRouteState = 'unknown';
      lastDesktopDeliveryErrorCode = null;
      unavailableDesktopThreads.clear();
      normalizer.reset();
      approvals.abandonAll();
      orchestrator.abandonAll();
      messageAggregator?.close();
      logger.warn('desktop_ipc_abandoned_runtime', { epoch });
      publishHealth();
    },
    onReconnectError: (error) => logger.error('desktop_ipc_reconnect_failed', error),
  });
  const processInboundMessage = async (message: InboundMessage): Promise<boolean> => {
    const generation = inboundGeneration;
    const botKey = message.botKey ?? DEFAULT_BOT_KEY;
    const runtime = runtimeForBotKey(botKey);
    const conversationBindings = conversationBindingsFor(botKey);
    const commands = commandsFor(botKey);
    const cards = runtime.cards;
    const botSender = message.senderType === 'bot';
    const groupSlashCommand = (message.chatType ?? 'p2p') === 'group'
      && isTextOnlyInboundMessage(message)
      && message.text.startsWith('/');
    const groupManagementCommand = groupSlashCommand
      && !botSender
      && runtime.config.authorizedUsers.includes(message.senderOpenId)
      && isGroupManagementCommandText(message.text);
    if (!botSender && isTextOnlyInboundMessage(message)) {
      if (!groupSlashCommand && await commands.handle(message)) {
        await syncDesktopThreadFollowing();
        return true;
      }
      const routeToBindingCommands = !groupSlashCommand || groupManagementCommand;
      if (routeToBindingCommands && await conversationBindings.handleCommand(message)) {
        await syncDesktopThreadFollowing();
        return true;
      }
    }
    if (groupSlashCommand && !botSender) {
      return false;
    }
    const binding = conversationBindings.getBinding(message.tenantKey, message.chatId, botKey);
    if (!binding) {
      if ((message.chatType ?? 'p2p') === 'group') {
        await replyUnavailableMessage(runtime, message, 'GROUP_NOT_BOUND');
        return false;
      }
      await conversationBindings.ensureBoundOrPrompt(message);
      return false;
    }
    if (shouldSuppressExternalGroupUserMention(message, binding)) {
      logger.info('external_group_user_mention_suppressed', {
        botKey,
        chatId: message.chatId,
        messageId: message.messageId,
      });
      return false;
    }
    if (botSender) {
      const sourceBot = configuredBots.find((bot) => bot.botOpenId === message.senderOpenId);
      const decision = evaluateGroupBotSenderMention(
        message,
        binding,
        sourceBot,
        runtime.config.allowGroupBotMentions !== false,
      );
      if (!decision.accepted) {
        logger.info('group_bot_sender_mention_suppressed', {
          botKey,
          sourceBotKey: sourceBot?.botKey ?? null,
          reason: decision.reason,
          chatId: message.chatId,
          messageId: message.messageId,
        });
        return false;
      }
    }
    let taskMessage = message;
    if (botSender) {
      const parsedHandoff = parseHandoffEnvelope(message.text);
      if (!parsedHandoff) {
        logger.info('group_bot_sender_mention_suppressed', {
          botKey,
          reason: 'handoff_envelope_missing',
          chatId: message.chatId,
          messageId: message.messageId,
        });
        return false;
      }
      const chainDecision = handoffCoordinator?.acceptInboundHandoff(parsedHandoff.envelope, botKey)
        ?? { accepted: false as const, reason: 'handoff_not_ready' };
      if (!chainDecision.accepted) {
        logger.info('group_bot_sender_mention_suppressed', {
          botKey,
          reason: `handoff_${chainDecision.reason}`,
          chatId: message.chatId,
          messageId: message.messageId,
        });
        return false;
      }
      taskMessage = {
        ...message,
        text: parsedHandoff.taskText,
        handoffEnvelope: parsedHandoff.envelope,
      };
    }
    await syncDesktopThreadFollowing();
    if (generation !== inboundGeneration) {
      return false;
    }
    const imageReferences = taskMessage.imageReferences
      ?? (taskMessage.imageKey ? [{ messageId: taskMessage.messageId, imageKey: taskMessage.imageKey }] : []);
    if (imageReferences.length > MAX_INBOUND_IMAGES) {
      const cardId = await cards.createCard(createImageCountErrorCard(MAX_INBOUND_IMAGES));
      await cards.replyCard(taskMessage.rootMessageId, cardId, `image-count:${taskMessage.eventId}`);
      return false;
    }
    let preparedMessage = taskMessage;
    if (imageReferences.length > 0) {
      const paths: string[] = [];
      try {
        for (const reference of imageReferences) {
          paths.push(await runtime.inboundImages.download(reference.messageId, reference.imageKey));
          if (generation !== inboundGeneration) {
            await runtime.inboundImages.release(paths);
            return false;
          }
        }
        runtime.cardImages.approve(paths);
        preparedMessage = { ...message, localImagePaths: Object.freeze(paths) };
      } catch (error) {
        await runtime.inboundImages.release(paths);
        if (generation !== inboundGeneration) {
          return false;
        }
        logger.error('lark_inbound_image_prepare_failed', toError(error), {
          botKey,
          chatId: message.chatId,
          messageId: message.messageId,
        });
        const cardId = await cards.createCard(createImageInputErrorCard());
        await cards.replyCard(taskMessage.rootMessageId, cardId, `image-error:${taskMessage.eventId}`);
        return false;
      }
    }
    let outcome;
    try {
      outcome = await orchestrator.handleInbound(preparedMessage, binding);
    } catch (error) {
      runtime.cardImages.revoke(preparedMessage.localImagePaths ?? []);
      await runtime.inboundImages.release(preparedMessage.localImagePaths ?? []);
      throw error;
    }
    if (generation !== inboundGeneration || outcome === 'abandoned') {
      return false;
    }
    if (outcome === 'rejected_image_limit') {
      const cardId = await cards.createCard(createImageCountErrorCard(MAX_INBOUND_IMAGES));
      await cards.replyCard(taskMessage.rootMessageId, cardId, `image-count:${taskMessage.eventId}`);
      return false;
    }
    if (outcome === 'rejected_queue_full') {
      const cardId = await cards.createCard(createQueueFullCard(config.maxQueuedTasks));
      await cards.replyCard(
        taskMessage.rootMessageId,
        cardId,
        `queue-full:${taskMessage.eventId}`,
      );
      return false;
    }
    if (binding.activeSkill && outcome !== 'duplicate') {
      try {
        await commands.consumeActiveSkill(binding);
      } catch (error) {
        logger.error('active_skill_cleanup_failed', toError(error), {
          botKey,
          chatId: message.chatId,
          threadId: binding.threadId,
        });
      }
    }
    return true;
  };
  const replyImageState = async (
    message: InboundMessage,
    card: Readonly<Record<string, unknown>>,
    operation: string,
  ): Promise<string> => {
    const cards = runtimeForBotKey(message.botKey ?? DEFAULT_BOT_KEY).cards;
    const cardId = await cards.createCard(card);
    return cards.replyCard(message.rootMessageId, cardId, `${operation}:${message.eventId}`);
  };
  const replyUnavailableContext = async (
    runtime: BotRuntime,
    context: InboundReplyContext,
    reason: RuntimeUnavailableReason,
  ): Promise<void> => {
    const cardId = await runtime.cards.createCard(createBotUnavailableCard(unavailableCard(reason, runtime.bot)));
    await runtime.cards.replyCard(
      context.rootMessageId,
      cardId,
      `bot-unavailable:${runtime.botKey}:${reason}:${context.eventId}`,
    );
  };
  const replyUnavailableMessage = async (
    runtime: BotRuntime,
    message: InboundMessage,
    reason: RuntimeUnavailableReason,
  ): Promise<void> => {
    const cardId = await runtime.cards.createCard(createBotUnavailableCard(unavailableCard(reason, runtime.bot)));
    await runtime.cards.replyCard(
      message.rootMessageId,
      cardId,
      `bot-unavailable:${runtime.botKey}:${reason}:${message.eventId}`,
    );
  };
  messageAggregator = new InboundMessageAggregator(processInboundMessage, {
    onPending: (message, imageCount, actionToken) => replyImageState(
      message,
      createImagePendingCard(imageCount, actionToken),
      'image-pending',
    ),
    onCancelled: async (message) => {
      await replyImageState(message, createImageBatchCancelledCard(), 'image-cancelled');
    },
    onTooManyImages: async (message, maximumImages) => {
      await replyImageState(message, createImageCountErrorCard(maximumImages), 'image-count');
    },
    onEmptyBatch: async (message) => {
      await replyImageState(message, createImageBatchEmptyCard(), 'image-empty');
    },
    onOverloaded: async (message) => {
      await replyImageState(message, createImageInputOverloadedCard(), 'image-overloaded');
    },
    onSubmitted: async (_message, cardMessageId) => {
      if (cardMessageId) {
        await runtimeForBotKey(_message.botKey ?? DEFAULT_BOT_KEY).cards.patchMessage(
          cardMessageId,
          createImageBatchSubmittedCard(),
        );
      }
    },
    onActionDispatchFailed: async (
      message,
      imageCount,
      retryToken,
      error,
      taskDescription,
      originalCardMessageId,
    ) => {
      logger.error('lark_image_button_dispatch_failed', error, {
        chatId: message.chatId,
        messageId: message.messageId,
        restored: retryToken !== null,
      });
      const failureCard = createImageSubmissionFailedCard(
        imageCount,
        retryToken,
        taskDescription,
      );
      if (originalCardMessageId) {
        try {
          await runtimeForBotKey(message.botKey ?? DEFAULT_BOT_KEY).cards.patchMessage(originalCardMessageId, failureCard);
          return originalCardMessageId;
        } catch (patchError) {
          logger.error('lark_image_retry_card_patch_failed', toError(patchError), {
            botKey: message.botKey ?? DEFAULT_BOT_KEY,
            chatId: message.chatId,
            messageId: originalCardMessageId,
          });
        }
      }
      return replyImageState(
        message,
        failureCard,
        `image-button-failed:${retryToken ?? 'not-restored'}`,
      );
    },
    onBackgroundError: (message, error) => logger.error('lark_image_background_failed', error, {
      botKey: message.botKey ?? DEFAULT_BOT_KEY,
      chatId: message.chatId,
      messageId: message.messageId,
    }),
  });
  for (const runtime of botRuntimes.values()) {
    runtime.eventServer = new LarkEventServer(runtime.lark.websocket, runtime.config, {
      onMessage: async (message) => {
        logger.info('lark_message_accepted', {
          botKey: message.botKey ?? DEFAULT_BOT_KEY,
          tenantKey: message.tenantKey,
          chatId: message.chatId,
          chatType: message.chatType ?? 'unknown',
          messageId: message.messageId,
          eventId: message.eventId,
          messageType: message.messageType ?? 'text',
        });
        if (!runtime.bot.enabled) {
          await replyUnavailableMessage(runtime, message, 'BOT_DISABLED');
          return;
        }
        void runtime.acknowledgements.ack(message);
        if (message.chatType === 'group') {
          await refreshExternalGroupBots(runtime, message.tenantKey, message.chatId);
        }
        void messageAggregator.accept(message).catch((error: unknown) => {
          logger.error('lark_async_message_failed', toError(error), {
            botKey: message.botKey ?? DEFAULT_BOT_KEY,
            chatId: message.chatId,
            messageId: message.messageId,
          });
        });
      },
      onBotAdded: async (event) => {
        logger.info('lark_bot_membership_added', {
          botKey: event.botKey,
          tenantKey: event.tenantKey,
          chatId: event.chatId,
          eventId: event.eventId,
        });
        await refreshExternalGroupBots(runtimeForBotKey(event.botKey), event.tenantKey, event.chatId, true);
      },
      onBotDeleted: async (event) => {
        const removed = groupBotDiscovery.removeGroup(event.botKey, event.tenantKey, event.chatId);
        logger.info('lark_bot_membership_deleted', {
          botKey: event.botKey,
          tenantKey: event.tenantKey,
          chatId: event.chatId,
          eventId: event.eventId,
          removed,
        });
      },
      onUnavailableMessage: async (context, reason) => {
        logger.info('lark_message_unavailable', {
          botKey: runtime.botKey,
          reason,
          tenantKey: context.tenantKey,
          chatId: context.chatId,
          chatType: context.chatType ?? 'unknown',
          messageId: context.messageId,
          eventId: context.eventId,
        });
        await replyUnavailableContext(runtime, context, reason);
      },
      onCardAction: async (action) => {
        const actionRuntime = runtimeForBotKey(action.botKey);
        const actionConfig = configForBotKey(action.botKey) ?? actionRuntime.config;
        if (action.action === 'binding') {
          const response = await conversationBindingsFor(action.botKey).handleCardAction(action);
          await syncDesktopThreadFollowing();
          return response;
        }
        if (action.action === 'open') {
          return conversationBindingsFor(action.botKey).handleOpenAction(action);
        }
        if (action.action === 'model' || action.action === 'skill') {
          return commandsFor(action.botKey).handleCardAction(action);
        }
        if (action.action === 'image-run' || action.action === 'image-cancel') {
          if (!actionConfig.authorizedUsers.includes(action.operatorOpenId)) {
            return toast('你没有操作当前图片任务的权限', 'warning');
          }
          const result = await messageAggregator.handleImageBatchAction({
            botKey: action.botKey,
            tenantKey: action.tenantKey,
            chatId: action.chatId,
            senderOpenId: action.operatorOpenId,
            action: action.action,
            token: action.token,
            ...(action.taskDescription !== undefined
              ? { taskDescription: action.taskDescription }
              : {}),
          });
          if (result === 'submitted') {
            return toast('图片任务已提交', 'success');
          }
          if (result === 'cancelled') {
            void actionRuntime.cards.patchMessage(action.messageId, createImageBatchCancelledCard()).catch((error: unknown) => {
              logger.error('lark_image_action_card_patch_failed', toError(error), {
                botKey: action.botKey,
                chatId: action.chatId,
                messageId: action.messageId,
                action: action.action,
              });
            });
            return toast('待提交图片已取消', 'success');
          }
          return toast('图片操作已失效，请重新发送图片', 'warning');
        }
        if (action.action === 'cancel') {
          if (!actionConfig.authorizedUsers.includes(action.operatorOpenId)) {
            return toast('你没有取消任务的权限', 'warning');
          }
          const cancelled = await orchestrator.cancel(action);
          return toast(cancelled ? '已请求取消任务' : '任务已结束或操作已失效', cancelled ? 'success' : 'warning');
        }
        return approvals.handleAction(action);
      },
      onRejectedEvent: (reason) => logger.warn('lark_event_rejected', {
        botKey: runtime.botKey,
        reason,
      }),
      onHandlerError: (kind, error) => logger.error('lark_event_handler_failed', error, {
        botKey: runtime.botKey,
        kind,
      }),
      onSdkLog: (level) => logger.warn(`lark_sdk_${level}`, { botKey: runtime.botKey }),
      onScopeBound: (nextConfig) => {
        Object.assign(runtime.config, {
          larkTenantKey: nextConfig.larkTenantKey,
          allowedChats: nextConfig.allowedChats,
          authorizedUsers: nextConfig.authorizedUsers,
          allowedApprovers: nextConfig.allowedApprovers,
        });
        botConfigs.set(runtime.botKey, runtime.config);
      },
    }, scopeStoreForBot(runtime.botKey, botStore, config, preflight.configHome), {
      unavailableReason: runtime.bot.enabled ? undefined : 'BOT_DISABLED',
    });
  }
  const unsubscribeDesktop = desktop.onThreadStreamStateChanged((message, epoch) => {
    normalizer.beginEpoch(epoch);
    for (const notification of normalizer.handle(message)) {
      approveNotificationImages(notification);
      orchestrator.handleNotification(notification);
    }
  });
  const unsubscribeApproval = normalizer.onApprovalRequest((approval, epoch) => {
    void approvals.present(approval, epoch).catch((error: unknown) => {
      logger.error('desktop_approval_projection_failed', toError(error));
    });
  });

  let stopped = false;
  try {
    await appServer.start();
    appServerState = 'ready';
    publishHealth();
    await desktopSupervisor.start();
    for (const runtime of botRuntimes.values()) {
      await runtime.eventServer?.start();
    }
    runtimeStarted = true;
    healthPublisher.flush();
    logger.info('bridge_started', {
      executionMode: 'desktop_follower',
      codexVersion: runtimeContract.codexVersion,
      appServerProtocolProfile: runtimeContract.protocolProfile.id,
      appServerProtocolSupported: true,
      appServerSchemaDigest: runtimeContract.schemaDigest,
      codexRuntimeArtifactSha256: runtimeContract.runtimeArtifact.binarySha256,
      desktopIpcContract: DESKTOP_IPC_CONTRACT.id,
      larkBotCount: botRuntimes.size,
      runtimeInstance: randomUUID().slice(0, 8),
    });
    void refreshKnownGroupBotDirectories().catch((error: unknown) => {
      logger.error('lark_group_bots_startup_discovery_failed', toError(error));
    });
  } catch (error) {
    inboundGeneration += 1;
    runtimeStopped = true;
    appServerState = 'stopped';
    desktopState = 'STOPPED';
    desktopRouteState = 'unknown';
    lastDesktopDeliveryErrorCode = null;
    unavailableDesktopThreads.clear();
    await stopResources(
      [...botRuntimes.values()].flatMap((runtime) => runtime.eventServer ? [runtime.eventServer] : []),
      desktopSupervisor,
      appServer,
      unsubscribeDesktop,
      unsubscribeApproval,
      approvals,
      [...botRuntimes.values()].map((runtime) => runtime.inboundImages),
      messageAggregator,
      processLock,
    );
    healthPublisher.flush();
    throw error;
  }

  return Object.freeze({
    config,
    failure,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      inboundGeneration += 1;
      runtimeStopped = true;
      appServerState = 'stopped';
      desktopState = 'STOPPED';
      desktopRouteState = 'unknown';
      lastDesktopDeliveryErrorCode = null;
      unavailableDesktopThreads.clear();
      await stopResources(
        [...botRuntimes.values()].flatMap((runtime) => runtime.eventServer ? [runtime.eventServer] : []),
        desktopSupervisor,
        appServer,
        unsubscribeDesktop,
        unsubscribeApproval,
        approvals,
        [...botRuntimes.values()].map((runtime) => runtime.inboundImages),
        messageAggregator,
        processLock,
      );
      healthPublisher.flush();
      logger.info('bridge_stopped');
    },
  });
}

function notificationLocalImagePaths(notification: ServerNotification): readonly string[] {
  if (notification.method !== 'turn/started') {
    return [];
  }
  const params = asRecord(notification.params);
  const turn = asRecord(params?.turn);
  const input = Array.isArray(turn?.input) ? turn.input : [];
  return input.flatMap((candidate) => {
    const item = asRecord(candidate);
    return item?.type === 'localImage' && typeof item.path === 'string'
      ? [item.path]
      : [];
  });
}

/** Resolves the generated-image directory from the same environment used by Codex. */
export function resolveCodexVisualizationsRoot(env: NodeJS.ProcessEnv): string {
  const configuredCodexHome = env.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return resolve(configuredCodexHome, 'visualizations');
  }
  const configuredHome = env.HOME?.trim();
  return resolve(configuredHome || homedir(), '.codex', 'visualizations');
}

function appServerTransport(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv,
): AppServerTransportOptions {
  if (config.appServerMode === 'managed_proxy') {
    return {
      mode: 'managed_proxy',
      codexBin: config.codexBin,
      spawnCwd: config.codexCwd,
      env,
      ...(config.appServerSocketPath ? { socketPath: config.appServerSocketPath } : {}),
    };
  }
  return { mode: 'owned_stdio', codexBin: config.codexBin, spawnCwd: config.codexCwd, env };
}

async function readThreadTitle(
  appServer: AppServerRequestClient,
  threadId: string,
): Promise<string | null> {
  const response = asRecord(await appServer.request('thread/read', { threadId }));
  const thread = asRecord(response?.thread) ?? response;
  return textField(thread?.title)
    ?? textField(thread?.name)
    ?? textField(thread?.summary)
    ?? textField(thread?.preview);
}

function scopeStoreForBot(
  botKey: string,
  botStore: BotConfigStore,
  baseConfig: BridgeConfig,
  configHome: string,
): { readonly save: (scope: LarkScope) => void } {
  return Object.freeze({
    save: (scope) => persistBotScope(botKey, scope, botStore, baseConfig, configHome),
  });
}

function persistBotScope(
  botKey: string,
  scope: LarkScope,
  botStore: BotConfigStore,
  baseConfig: BridgeConfig,
  configHome: string,
): void {
  if (botKey === DEFAULT_BOT_KEY && !botStore.hasMaterializedFile()) {
    new LarkScopeConfigStore(configHome).save(scope);
    Object.assign(baseConfig, {
      larkTenantKey: scope.tenantKey,
      allowedChats: splitScopeList(scope.allowedChats),
      authorizedUsers: splitScopeList(scope.authorizedUsers ?? ''),
      allowedApprovers: splitScopeList(scope.allowedApprovers ?? ''),
    });
    return;
  }
  const existing = botStore.get(botKey);
  if (!existing) {
    return;
  }
  const next = botStore.update(botKey, {
    tenantKey: scope.tenantKey,
    allowedChats: splitScopeList(scope.allowedChats),
    authorizedUsers: splitScopeList(scope.authorizedUsers ?? ''),
    allowedApprovers: splitScopeList(scope.allowedApprovers ?? ''),
  });
  Object.assign(baseConfig, botKey === DEFAULT_BOT_KEY ? {
    larkTenantKey: next.tenantKey,
    allowedChats: next.allowedChats,
    authorizedUsers: next.authorizedUsers,
    allowedApprovers: next.allowedApprovers,
  } : {});
}

function splitScopeList(value: string): readonly string[] {
  return Object.freeze([...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]);
}

function aggregateLarkConnections(
  snapshots: readonly LarkWebsocketConnectionSnapshot[],
): LarkWebsocketConnectionSnapshot {
  if (snapshots.length === 0) {
    return Object.freeze({ state: 'closed', reconnectCount: 0, connectedAtMs: null });
  }
  const reconnectCount = snapshots.reduce((sum, snapshot) => sum + snapshot.reconnectCount, 0);
  const connectedAtMsValues = snapshots
    .map((snapshot) => snapshot.connectedAtMs)
    .filter((value): value is number => value !== null);
  const connectedAtMs = connectedAtMsValues.length === snapshots.length
    ? Math.min(...connectedAtMsValues)
    : null;
  if (snapshots.every((snapshot) => snapshot.state === 'ready')) {
    return Object.freeze({ state: 'ready', reconnectCount, connectedAtMs });
  }
  if (snapshots.some((snapshot) => snapshot.state === 'terminal')) {
    return Object.freeze({ state: 'terminal', reconnectCount, connectedAtMs: null });
  }
  if (snapshots.some((snapshot) => snapshot.state === 'reconnecting')) {
    return Object.freeze({ state: 'reconnecting', reconnectCount, connectedAtMs: null });
  }
  if (snapshots.some((snapshot) => snapshot.state === 'connecting')) {
    return Object.freeze({ state: 'connecting', reconnectCount, connectedAtMs: null });
  }
  if (snapshots.every((snapshot) => snapshot.state === 'closed')) {
    return Object.freeze({ state: 'closed', reconnectCount, connectedAtMs: null });
  }
  return Object.freeze({ state: 'idle', reconnectCount, connectedAtMs: null });
}

function unavailableCard(
  reason: RuntimeUnavailableReason,
  bot: LarkBotConfig,
): { readonly title: string; readonly reason: string; readonly nextStep?: string } {
  const displayName = bot.displayName ? `「${bot.displayName}」` : '当前机器人';
  if (reason === 'BOT_DISABLED') {
    return Object.freeze({
      title: '机器人当前不可用',
      reason: `${displayName} 已被 Bridge 管理员禁用，当前不会接收任务、命令或审批操作。`,
      nextStep: `请联系 owner/admin 执行 \`codex-feishu-bridge bot enable --bot-key ${bot.botKey}\` 后再试。`,
    });
  }
  if (reason === 'GROUP_NOT_BOUND') {
    return Object.freeze({
      title: '当前群未绑定会话',
      reason: `${displayName} 已收到 @，但当前群还没有绑定 ChatGPT 会话，因此不能接收任务。`,
      nextStep: '请让 owner/admin 在机器人管理面为当前群绑定会话后再发送普通消息。',
    });
  }
  return Object.freeze({
    title: '机器人当前不可用',
    reason: `${displayName} 当前不能接收任务。`,
  });
}

async function stopResources(
  eventServers: readonly LarkEventServer[],
  desktopSupervisor: DesktopIpcSupervisor,
  appServer: AppServerClient,
  unsubscribeDesktop: () => void,
  unsubscribeApproval: () => void,
  approvals: DesktopApprovalService,
  inboundImages: readonly InboundImageStore[],
  messageAggregator: InboundMessageAggregator,
  processLock: BridgeProcessLock,
): Promise<void> {
  const errors: Error[] = [];
  for (const eventServer of eventServers) {
    try {
      eventServer.stop();
    } catch (error) {
      errors.push(toError(error));
    }
  }
  unsubscribeDesktop();
  unsubscribeApproval();
  approvals.abandonAll();
  messageAggregator.close();
  for (const inboundImageStore of inboundImages) {
    try {
      await inboundImageStore.close();
    } catch (error) {
      errors.push(toError(error));
    }
  }
  try {
    await desktopSupervisor.stop();
  } catch (error) {
    errors.push(toError(error));
  }
  try {
    await appServer.stop();
  } catch (error) {
    errors.push(toError(error));
  }
  try {
    processLock.release();
  } catch (error) {
    errors.push(toError(error));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Bridge shutdown did not complete cleanly');
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Bridge cleanup failed');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function scalarLogFields(fields: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!fields) {
    return {};
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}
