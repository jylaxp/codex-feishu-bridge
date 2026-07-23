import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { BindingStore } from './binding-store';
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
import { isTextOnlyInboundMessage, type InboundMessage } from './lark/intake';
import {
  InboundImageStore,
  type LarkMessageResourceApi,
} from './lark/inbound-image-store';
import {
  InboundMessageAggregator,
  MAX_INBOUND_IMAGES,
} from './lark/inbound-message-aggregator';
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

const BINDING_DESKTOP_SNAPSHOT_TIMEOUT_MS = 5_000;

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
  const cardImages = new CardImageRenderer(
    lark.api as unknown as LarkImageApi,
    [config.codexCwd, resolveCodexVisualizationsRoot(effectiveEnv)],
  );
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
  const inboundImages = new InboundImageStore(
    lark.api as unknown as LarkMessageResourceApi,
    preflight.runtimeDirectory.temporaryDir,
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
    isBindingCurrent: (candidate) => (
      bindings.get(candidate.tenantKey, candidate.chatId)?.threadId === candidate.threadId
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
    releaseInboundImages: (paths) => {
      cardImages.revoke(paths);
      void inboundImages.release(paths).catch((error: unknown) => {
        logger.error('lark_inbound_image_cleanup_failed', toError(error), { count: paths.length });
      });
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
        cardImages.approve(notificationLocalImagePaths(notification));
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
    if (isTextOnlyInboundMessage(message)) {
      if (await commands.handle(message)) {
        await syncDesktopThreadFollowing();
        return true;
      }
      if (await conversationBindings.handleCommand(message)) {
        await syncDesktopThreadFollowing();
        return true;
      }
    }
    const binding = conversationBindings.getBinding(message.tenantKey, message.chatId);
    if (!binding) {
      await conversationBindings.ensureBoundOrPrompt(message);
      return false;
    }
    await syncDesktopThreadFollowing();
    if (generation !== inboundGeneration) {
      return false;
    }
    const imageReferences = message.imageReferences
      ?? (message.imageKey ? [{ messageId: message.messageId, imageKey: message.imageKey }] : []);
    if (imageReferences.length > MAX_INBOUND_IMAGES) {
      const cardId = await cards.createCard(createImageCountErrorCard(MAX_INBOUND_IMAGES));
      await cards.replyCard(message.rootMessageId, cardId, `image-count:${message.eventId}`);
      return false;
    }
    let preparedMessage = message;
    if (imageReferences.length > 0) {
      const paths: string[] = [];
      try {
        for (const reference of imageReferences) {
          paths.push(await inboundImages.download(reference.messageId, reference.imageKey));
          if (generation !== inboundGeneration) {
            await inboundImages.release(paths);
            return false;
          }
        }
        cardImages.approve(paths);
        preparedMessage = { ...message, localImagePaths: Object.freeze(paths) };
      } catch (error) {
        await inboundImages.release(paths);
        if (generation !== inboundGeneration) {
          return false;
        }
        logger.error('lark_inbound_image_prepare_failed', toError(error), {
          chatId: message.chatId,
          messageId: message.messageId,
        });
        const cardId = await cards.createCard(createImageInputErrorCard());
        await cards.replyCard(message.rootMessageId, cardId, `image-error:${message.eventId}`);
        return false;
      }
    }
    let outcome;
    try {
      outcome = await orchestrator.handleInbound(preparedMessage, binding);
    } catch (error) {
      cardImages.revoke(preparedMessage.localImagePaths ?? []);
      await inboundImages.release(preparedMessage.localImagePaths ?? []);
      throw error;
    }
    if (generation !== inboundGeneration || outcome === 'abandoned') {
      return false;
    }
    if (outcome === 'rejected_image_limit') {
      const cardId = await cards.createCard(createImageCountErrorCard(MAX_INBOUND_IMAGES));
      await cards.replyCard(message.rootMessageId, cardId, `image-count:${message.eventId}`);
      return false;
    }
    if (outcome === 'rejected_queue_full') {
      const cardId = await cards.createCard(createQueueFullCard(config.maxQueuedTasks));
      await cards.replyCard(
        message.rootMessageId,
        cardId,
        `queue-full:${message.eventId}`,
      );
      return false;
    }
    if (binding.activeSkill && outcome !== 'duplicate') {
      try {
        await commands.consumeActiveSkill(binding);
      } catch (error) {
        logger.error('active_skill_cleanup_failed', toError(error), {
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
    const cardId = await cards.createCard(card);
    return cards.replyCard(message.rootMessageId, cardId, `${operation}:${message.eventId}`);
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
        await cards.patchMessage(cardMessageId, createImageBatchSubmittedCard());
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
          await cards.patchMessage(originalCardMessageId, failureCard);
          return originalCardMessageId;
        } catch (patchError) {
          logger.error('lark_image_retry_card_patch_failed', toError(patchError), {
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
      chatId: message.chatId,
      messageId: message.messageId,
    }),
  });
  const eventServer = new LarkEventServer(lark.websocket, config, {
    onMessage: async (message) => {
      logger.info('lark_message_accepted', {
        tenantKey: message.tenantKey,
        chatId: message.chatId,
        messageId: message.messageId,
        eventId: message.eventId,
        messageType: message.messageType ?? 'text',
      });
      void acknowledgements.ack(message);
      void messageAggregator.accept(message).catch((error: unknown) => {
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
      if (action.action === 'image-run' || action.action === 'image-cancel') {
        if (!config.authorizedUsers.includes(action.operatorOpenId)) {
          return toast('你没有操作当前图片任务的权限', 'warning');
        }
        const result = await messageAggregator.handleImageBatchAction({
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
          void cards.patchMessage(action.messageId, createImageBatchCancelledCard()).catch((error: unknown) => {
            logger.error('lark_image_action_card_patch_failed', toError(error), {
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
      cardImages.approve(notificationLocalImagePaths(notification));
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
    inboundGeneration += 1;
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
      inboundImages,
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
        eventServer,
        desktopSupervisor,
        appServer,
        unsubscribeDesktop,
        unsubscribeApproval,
        approvals,
        inboundImages,
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

async function stopResources(
  eventServer: LarkEventServer,
  desktopSupervisor: DesktopIpcSupervisor,
  appServer: AppServerClient,
  unsubscribeDesktop: () => void,
  unsubscribeApproval: () => void,
  approvals: DesktopApprovalService,
  inboundImages: InboundImageStore,
  messageAggregator: InboundMessageAggregator,
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
  messageAggregator.close();
  try {
    await inboundImages.close();
  } catch (error) {
    errors.push(toError(error));
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
