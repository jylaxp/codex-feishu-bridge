import { randomUUID } from 'node:crypto';

import { BindingStore } from './binding-store';
import { CardKitClient, type LarkReplyApi } from './cards/cardkit-client';
import { CardImageRenderer, type LarkImageApi } from './cards/card-image-renderer';
import { createQueueFullCard } from './cards/layouts';
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
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { BridgeCommandService } from './command-service';
import { ConversationBindingServiceV3 } from './conversation-binding-service-v3';
import { DesktopApprovalService } from './desktop-approval-service';
import { BridgeConfig } from './domain';
import {
  InMemoryOrchestrator,
  type DesktopDeliveryOutcome,
} from './in-memory-orchestrator';
import { CachedTenantTokenProvider, createLarkRuntimeClients } from './lark/client';
import {
  LarkMessageAcknowledgement,
  type LarkMessageAcknowledgementApi,
} from './lark/message-acknowledgement';
import { OutputFileUploader, type FileUploadApi } from './lark/output-file-uploader';
import { LarkEventServer, toast } from './lark/event-server';
import type { InboundTextMessage } from './lark/intake';
import { LarkScopeConfigStore } from './lark/scope-config-store';
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
  let runtimeContract: Awaited<ReturnType<typeof verifyCodexRuntimeContract>>;
  let protocolAdapter: ReturnType<typeof adapterForAppServerProfile>;
  try {
    bindings.load();
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
  let orchestrator: InMemoryOrchestrator | undefined;
  const healthStore = new RuntimeHealthStore(preflight.configHome);
  let runtimeStarted = false;
  let runtimeStopped = false;
  let appServerState: RuntimeHealthSnapshot['appServer']['state'] = 'starting';
  let desktopState: DesktopIpcSupervisorState = 'STOPPED';
  let desktopEpoch: number | null = null;
  let desktopRouteState: DesktopRouteState = 'unknown';
  let lastDesktopDeliveryErrorCode: string | null = null;
  const unavailableDesktopThreads = new Set<string>();
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
  const lark = createLarkRuntimeClients(config, {
    logSink: (level) => logger.warn(`lark_sdk_${level}`),
    onTerminalWebsocketError: resolveFailure,
    onWebsocketStateChanged: (snapshot) => {
      larkConnection = snapshot;
      logger.info('lark_websocket_state_changed', {
        state: snapshot.state,
        reconnectCount: snapshot.reconnectCount,
      });
      if (snapshot.state === 'ready' && snapshot.reconnectCount > 0) {
        orchestrator?.resumeCardDelivery();
      }
      publishHealth();
    },
  });
  const cardImages = new CardImageRenderer(lark.api as unknown as LarkImageApi);
  const cards = new CardKitClient(
    new CachedTenantTokenProvider(config.larkAppId, config.larkAppSecret),
    lark.api as unknown as LarkReplyApi,
    fetch,
    10_000,
    (card) => cardImages.render(card),
  );
  const acknowledgements = new LarkMessageAcknowledgement(
    lark.api as unknown as LarkMessageAcknowledgementApi,
    logger,
  );
  const rateLimits = new RateLimitCache(
    () => appServerControlPlane.request('account/rateLimits/read', {}),
    config.rateLimitQueryIntervalMs,
  );
  const outputFileUploader = new OutputFileUploader(config, lark.api as unknown as FileUploadApi);
  const larkScopeConfig = new LarkScopeConfigStore(preflight.configHome);
  const navigation = new CodexAppNavigationAdapter();
  orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    onCardError: (error) => logger.error('card_update_failed', error),
    readRateLimits: () => rateLimits.get(),
    uploadOutputFiles: (answer, rootMessageId, taskId) => (
      outputFileUploader.uploadMarkdownFiles(answer, rootMessageId, taskId)
    ),
    resolveBindingByThreadId: (threadId) => bindings.getUniqueByThreadId(threadId),
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
  });
  const approvals = new DesktopApprovalService(config, desktop, cards, orchestrator);
  const conversationBindings = new ConversationBindingServiceV3(
    config,
    bindings,
    appServerControlPlane,
    cards,
    undefined,
    navigation,
    logger,
    undefined,
    () => rateLimits.get(),
    async (binding) => {
      const notifications = normalizer.activeTurnSnapshot(binding.threadId);
      if (notifications.length === 0) {
        return false;
      }
      for (const notification of notifications) {
        orchestrator.handleNotification(notification);
      }
      return true;
    },
  );
  const commands = new BridgeCommandService(
    config,
    bindings,
    appServerControlPlane,
    cards,
    orchestrator,
    navigation,
    undefined,
    rateLimits,
  );
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
      desktopState = 'RECONNECTING';
      desktopEpoch = epoch;
      desktopRouteState = 'unknown';
      lastDesktopDeliveryErrorCode = null;
      unavailableDesktopThreads.clear();
      normalizer.reset();
      approvals.abandonAll();
      orchestrator.abandonAll();
      logger.warn('desktop_ipc_abandoned_runtime', { epoch });
      publishHealth();
    },
    onReconnectError: (error) => logger.error('desktop_ipc_reconnect_failed', error),
  });
  const processInboundMessage = async (message: InboundTextMessage): Promise<void> => {
    if (await commands.handle(message)) {
      await syncDesktopThreadFollowing();
      return;
    }
    if (await conversationBindings.handleCommand(message)) {
      await syncDesktopThreadFollowing();
      return;
    }
    const binding = conversationBindings.getBinding(message.tenantKey, message.chatId);
    if (!binding) {
      await conversationBindings.ensureBoundOrPrompt(message);
      return;
    }
    await syncDesktopThreadFollowing();
    const outcome = await orchestrator.handleInbound(message, binding);
    if (outcome === 'rejected_queue_full') {
      const cardId = await cards.createCard(createQueueFullCard(config.maxQueuedTasks));
      await cards.replyCard(
        message.rootMessageId,
        cardId,
        `queue-full:${message.eventId}`,
      );
      return;
    }
    if (binding.activeSkill && outcome !== 'duplicate') {
      await commands.consumeActiveSkill(binding);
    }
  };
  const eventServer = new LarkEventServer(lark.websocket, config, {
    onMessage: async (message) => {
      logger.info('lark_text_message_accepted', {
        tenantKey: message.tenantKey,
        chatId: message.chatId,
        messageId: message.messageId,
        eventId: message.eventId,
      });
      void acknowledgements.ack(message);
      void processInboundMessage(message).catch((error: unknown) => {
        logger.error('lark_async_message_failed', toError(error), {
          chatId: message.chatId,
          messageId: message.messageId,
        });
      });
    },
    onCardAction: async (action) => {
      if (action.action === 'binding') {
        const response = await conversationBindings.handleCardAction(action);
        await syncDesktopThreadFollowing();
        return response;
      }
      if (action.action === 'open') {
        return conversationBindings.handleOpenAction(action);
      }
      if (action.action === 'model' || action.action === 'skill') {
        return commands.handleCardAction(action);
      }
      if (action.action === 'cancel') {
        if (!config.authorizedUsers.includes(action.operatorOpenId)) {
          return toast('你没有取消任务的权限', 'warning');
        }
        const cancelled = await orchestrator.cancel(action);
        return toast(cancelled ? '已请求取消任务' : '任务已结束或操作已失效', cancelled ? 'success' : 'warning');
      }
      return approvals.handleAction(action);
    },
    onRejectedEvent: (reason) => logger.warn('lark_event_rejected', { reason }),
    onHandlerError: (kind, error) => logger.error('lark_event_handler_failed', error, { kind }),
    onSdkLog: (level) => logger.warn(`lark_sdk_${level}`),
    onScopeBound: (nextConfig) => {
      Object.assign(config, {
        larkTenantKey: nextConfig.larkTenantKey,
        allowedChats: nextConfig.allowedChats,
        authorizedUsers: nextConfig.authorizedUsers,
        allowedApprovers: nextConfig.allowedApprovers,
      });
    },
  }, larkScopeConfig);
  const unsubscribeDesktop = desktop.onThreadStreamStateChanged((message, epoch) => {
    normalizer.beginEpoch(epoch);
    for (const notification of normalizer.handle(message)) {
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
    await eventServer.start();
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
      runtimeInstance: randomUUID().slice(0, 8),
    });
  } catch (error) {
    runtimeStopped = true;
    appServerState = 'stopped';
    desktopState = 'STOPPED';
    desktopRouteState = 'unknown';
    lastDesktopDeliveryErrorCode = null;
    unavailableDesktopThreads.clear();
    await stopResources(
      eventServer,
      desktopSupervisor,
      appServer,
      unsubscribeDesktop,
      unsubscribeApproval,
      approvals,
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
      runtimeStopped = true;
      appServerState = 'stopped';
      desktopState = 'STOPPED';
      desktopRouteState = 'unknown';
      lastDesktopDeliveryErrorCode = null;
      unavailableDesktopThreads.clear();
      await stopResources(
        eventServer,
        desktopSupervisor,
        appServer,
        unsubscribeDesktop,
        unsubscribeApproval,
        approvals,
        processLock,
      );
      healthPublisher.flush();
      logger.info('bridge_stopped');
    },
  });
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

async function stopResources(
  eventServer: LarkEventServer,
  desktopSupervisor: DesktopIpcSupervisor,
  appServer: AppServerClient,
  unsubscribeDesktop: () => void,
  unsubscribeApproval: () => void,
  approvals: DesktopApprovalService,
  processLock: BridgeProcessLock,
): Promise<void> {
  const errors: Error[] = [];
  try {
    eventServer.stop();
  } catch (error) {
    errors.push(toError(error));
  }
  unsubscribeDesktop();
  unsubscribeApproval();
  approvals.abandonAll();
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
