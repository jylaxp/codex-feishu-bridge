import { randomUUID } from 'node:crypto';

import { ApprovalService } from './approval-service';
import { AsyncWorkTracker } from './async-work-tracker';
import { ConversationBindingService } from './conversation-binding-service';
import { hydrateTaskCardActions } from './cards/action-hydrator';
import { CardKitClient, LarkReplyApi } from './cards/cardkit-client';
import { CardOutboxWorker } from './cards/outbox-worker';
import { DurableCardProjector } from './cards/projector';
import { AppServerClient, AppServerTransportOptions } from './codex/app-server-client';
import { SUPPORTED_APP_SERVER_VERSION } from './codex/contract';
import { AppServerEventCoordinator } from './codex/event-coordinator';
import { ServerNotification } from './codex/protocol';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { parseEnvironment } from './config';
import { BridgeDatabase } from './db/database';
import { BridgeRepositories } from './db/repositories';
import { BridgeConfig } from './domain';
import { CachedTenantTokenProvider, createLarkRuntimeClients } from './lark/client';
import { LarkEventServer } from './lark/event-server';
import { BridgeLogger } from './logger';
import { runPreflight } from './preflight';
import { BridgeProcessLock } from './process-lock';
import { AppServerSupervisor, RecoveryService } from './recovery-service';
import { TaskOrchestrator } from './task-orchestrator';

export interface BridgeRuntime {
  readonly config: BridgeConfig;
  readonly failure: Promise<Error>;
  stop(): Promise<void>;
}

/** Builds and starts the clean-slate Feishu -> App Server -> CardKit runtime. */
export async function startBridge(
  env: NodeJS.ProcessEnv = process.env,
  logger: BridgeLogger = new BridgeLogger(),
): Promise<BridgeRuntime> {
  const preflight = runPreflight(parseEnvironment(env));
  const config = preflight.config;
  const processLock = new BridgeProcessLock(preflight.dataDirectory.rootDir);
  processLock.acquire();
  const database = new BridgeDatabase(preflight.dataDirectory.databasePath);
  try {
    await verifyCodexRuntimeContract(config, env, preflight.dataDirectory.temporaryDir);
    database.open();
    return await startOpenedBridge(config, env, logger, database, processLock);
  } catch (error) {
    const cleanupErrors: Error[] = [toError(error)];
    captureCleanupError(cleanupErrors, () => database.close());
    captureCleanupError(cleanupErrors, () => processLock.release());
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Bridge startup and cleanup both failed');
    }
    throw error;
  }
}

async function startOpenedBridge(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv,
  logger: BridgeLogger,
  database: BridgeDatabase,
  processLock: BridgeProcessLock,
): Promise<BridgeRuntime> {
  let resolveRuntimeFailure!: (error: Error) => void;
  const runtimeFailure = new Promise<Error>((resolve) => {
    resolveRuntimeFailure = resolve;
  });
  const lark = createLarkRuntimeClients(config, {
    logSink: (level) => {
      if (level === 'error') {
        logger.error('lark_sdk_error', new Error('LarkSdkError'));
        return;
      }
      logger.warn('lark_sdk_warning');
    },
    onTerminalWebsocketError: (error) => {
      logger.error('lark_websocket_terminated', error);
      resolveRuntimeFailure(error);
    },
  });
  const tokenProvider = new CachedTenantTokenProvider(
    config.larkAppId,
    config.larkAppSecret,
  );
  const cardKit = new CardKitClient(
    tokenProvider,
    lark.api as unknown as LarkReplyApi,
  );
  const appServer = new AppServerClient({
    transport: appServerTransport(config, env),
    clientInfo: {
      name: 'lark_codex_gateway',
      title: 'Lark Codex Gateway',
      version: '2.0.0',
    },
    expectedServerVersion: SUPPORTED_APP_SERVER_VERSION,
  });
  const conversationBindings = new ConversationBindingService(
    database,
    config,
    appServer,
    cardKit,
  );
  const repositories = new BridgeRepositories(database);
  const runtimeInstanceId = randomUUID();
  let coordinatorReference: AppServerEventCoordinator | undefined;
  const projector = new DurableCardProjector(
    database,
    config,
    config.cardUpdateIntervalMs,
    Date.now,
    (error) => logger.error('card_projection_failed', error),
    (taskId) => coordinatorReference?.getTaskProjectionSnapshot(taskId),
  );
  const outboxWorker = new CardOutboxWorker({
    outbox: repositories.cardOutbox,
    tasks: repositories.tasks,
    cardKit,
    prepareCard: (task, card) => hydrateTaskCardActions(
      card,
      config.larkAppSecret,
      task.id,
    ),
  }, {
    workerId: `card-worker-${randomUUID()}`,
    onError: (error) => logger.error('card_outbox_failed', error),
    onDeliveryFailed: (failure) => logger.error(
      'card_delivery_failed',
      new Error('CardKit delivery reached a terminal failure'),
      {
        outboxId: failure.outboxId,
        taskId: failure.taskId,
        deliveryErrorCode: failure.errorCode,
      },
    ),
  });
  const coordinator = new AppServerEventCoordinator({
    tasks: repositories.tasks,
    bindings: repositories.threadBindings,
    taskItems: repositories.taskItems,
    scheduleProjection: (taskId, immediate) => projector.request(taskId, immediate),
  });
  coordinatorReference = coordinator;
  const orchestrator = new TaskOrchestrator(
    database,
    config,
    appServer,
    cardKit,
    projector,
    { runtimeInstanceId, turnEvents: coordinator },
  );
  const approvals = new ApprovalService(
    database,
    config,
    appServer,
    cardKit,
    orchestrator,
    projector,
    { runtimeInstanceId },
  );
  const recovery = new RecoveryService(database, config, appServer, projector, {
    onSlotAvailable: () => orchestrator.startNextQueued(),
    onPendingCancellation: (taskId) => orchestrator.recoverPendingCancellation(taskId),
    onRecoveryComplete: () => approvals.drainDeferredRequests(),
    onRecoverUnsentDispatch: (taskId, method) => (
      orchestrator.recoverUnsentDispatch(taskId, method)
    ),
    onRecoverUnsentSteer: (inboxId) => orchestrator.recoverUnsentSteer(inboxId),
    runtimeInstanceId,
  });
  const supervisor = new AppServerSupervisor(appServer, recovery, {
    onError: (error) => logger.error('app_server_reconnect_failed', error),
  });
  const larkWork = new AsyncWorkTracker(16);
  const appServerWork = new AsyncWorkTracker();
  const eventServer = new LarkEventServer(lark.websocket, config, {
    onMessage: (message) => larkWork.track(async () => {
      if (await conversationBindings.handleCommand(message)) {
        logger.info('conversation_binding_command_processed', {
          chatId: message.chatId,
          command: message.text,
        });
        return;
      }
      const outcome = await orchestrator.handleInbound(message);
      if (outcome.type === 'unbound') {
        await conversationBindings.ensureBoundOrPrompt(message);
        logger.info('lark_message_waiting_for_conversation_binding', {
          chatId: message.chatId,
        });
      }
      logger.info('lark_message_processed', { outcome: outcome.type });
    }),
    onCardAction: (action) => larkWork.track(() => (
      action.action === 'binding'
        ? conversationBindings.handleCardAction({
            tenantKey: action.tenantKey,
            chatId: action.chatId,
            messageId: action.messageId,
            operatorOpenId: action.operatorOpenId,
            action: 'binding',
            token: action.token,
          })
        : approvals.handleCardAction(action)
    )),
    onRejectedEvent: (reason) => logger.warn('lark_event_rejected', { reason }),
    onHandlerError: (kind, error) => logger.error('lark_event_handler_failed', error, { kind }),
  });

  const unsubscribeNotification = appServer.onNotification((notification) => {
    handleNotification(
      notification,
      coordinator,
      orchestrator,
      appServerWork,
      logger,
    );
  });
  const unsubscribeRequest = appServer.onServerRequest((request, epoch) => {
    void appServerWork.track(
      () => approvals.handleServerRequest(request, epoch),
    ).catch((error: unknown) => {
      logger.error('approval_request_failed', error);
    });
  });
  const unsubscribeDiagnostics = appServer.subscribe((event) => {
    if (event.type === 'protocolError') {
      logger.warn('app_server_protocol_error', { reason: event.diagnostic.reason });
    } else if (event.type === 'stderr') {
      logger.warn('app_server_stderr', { bytes: Buffer.byteLength(event.text, 'utf8') });
    }
  });

  let started = false;
  try {
    await supervisor.start();
    outboxWorker.start();
    await eventServer.start();
    started = true;
    logger.info('bridge_started', {
      appServerMode: config.appServerMode,
      schemaVersion: database.getSchemaVersion(),
    });
  } catch (error) {
    try {
      await stopRuntime({
        eventServer,
        larkWork,
        supervisor,
        unsubscribeNotification,
        unsubscribeRequest,
        unsubscribeDiagnostics,
        appServerWork,
        projector,
        outboxWorker,
        database,
        processLock,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [toError(error), toError(cleanupError)],
        'Bridge startup and cleanup both failed',
      );
    }
    throw error;
  }

  return Object.freeze({
    config,
    failure: runtimeFailure,
    stop: async () => {
      if (!started) {
        return;
      }
      started = false;
      await stopRuntime({
        eventServer,
        larkWork,
        supervisor,
        unsubscribeNotification,
        unsubscribeRequest,
        unsubscribeDiagnostics,
        appServerWork,
        projector,
        outboxWorker,
        database,
        processLock,
      });
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
  return {
    mode: 'owned_stdio',
    codexBin: config.codexBin,
    spawnCwd: config.codexCwd,
    env,
  };
}

function handleNotification(
  notification: ServerNotification,
  coordinator: AppServerEventCoordinator,
  orchestrator: TaskOrchestrator,
  appServerWork: AsyncWorkTracker,
  logger: BridgeLogger,
): void {
  try {
    const outcome = coordinator.handle(notification);
    if (outcome === 'TERMINAL') {
      void appServerWork.track(
        () => orchestrator.startNextQueued(),
      ).catch((error: unknown) => {
        logger.error('queued_task_start_failed', error);
      });
    }
  } catch (error) {
    logger.error('app_server_event_reduction_failed', error, {
      method: notification.method,
    });
  }
}

interface RuntimeResources {
  readonly eventServer: LarkEventServer;
  readonly larkWork: AsyncWorkTracker;
  readonly supervisor: AppServerSupervisor;
  readonly unsubscribeNotification: () => void;
  readonly unsubscribeRequest: () => void;
  readonly unsubscribeDiagnostics: () => void;
  readonly appServerWork: AsyncWorkTracker;
  readonly projector: DurableCardProjector;
  readonly outboxWorker: CardOutboxWorker;
  readonly database: BridgeDatabase;
  readonly processLock: BridgeProcessLock;
}

async function stopRuntime(resources: RuntimeResources): Promise<void> {
  const errors: Error[] = [];
  captureCleanupError(errors, () => resources.eventServer.stop());
  resources.larkWork.close();
  await captureAsyncCleanupError(errors, () => resources.larkWork.drain());

  await captureAsyncCleanupError(errors, () => resources.supervisor.stop());
  captureCleanupError(errors, resources.unsubscribeNotification);
  captureCleanupError(errors, resources.unsubscribeRequest);
  captureCleanupError(errors, resources.unsubscribeDiagnostics);
  resources.appServerWork.close();
  await captureAsyncCleanupError(errors, () => resources.appServerWork.drain());

  await captureAsyncCleanupError(errors, () => resources.outboxWorker.stop());
  await captureAsyncCleanupError(errors, () => resources.projector.drain());
  captureCleanupError(errors, () => resources.projector.stop());
  await captureAsyncCleanupError(errors, async () => {
    while (await resources.outboxWorker.drainOnce()) {
      // Drain every delivery which is due now; delayed retries remain durable.
    }
  });
  captureCleanupError(errors, () => resources.database.close());
  captureCleanupError(errors, () => resources.processLock.release());

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Bridge shutdown did not complete cleanly');
  }
}

function captureCleanupError(errors: Error[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(toError(error));
  }
}

async function captureAsyncCleanupError(
  errors: Error[],
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(toError(error));
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Bridge shutdown error');
}
