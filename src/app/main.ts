import { randomUUID } from 'node:crypto';

import { BindingStore } from './binding-store';
import { CardKitClient, type LarkReplyApi } from './cards/cardkit-client';
import { AppServerClient, type AppServerTransportOptions } from './codex/app-server-client';
import { SUPPORTED_APP_SERVER_VERSION } from './codex/contract';
import { DesktopIpcClient } from './codex/desktop-ipc-client';
import { DesktopIpcSupervisor } from './codex/desktop-ipc-supervisor';
import { DesktopThreadStreamNormalizer } from './codex/desktop-thread-stream-normalizer';
import { CodexAppNavigationAdapter } from './codex/app-navigation-adapter';
import { verifyCodexRuntimeContract } from './codex/runtime-contract';
import { parseEnvironment } from './config';
import { loadBridgeEnvironment } from './config-file';
import { ConversationBindingServiceV3 } from './conversation-binding-service-v3';
import { DesktopApprovalService } from './desktop-approval-service';
import { BridgeConfig } from './domain';
import { InMemoryOrchestrator } from './in-memory-orchestrator';
import { CachedTenantTokenProvider, createLarkRuntimeClients } from './lark/client';
import { LarkEventServer, toast } from './lark/event-server';
import { BridgeLogger } from './logger';
import { runPreflight } from './preflight';
import { BridgeProcessLock } from './process-lock';

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
  const preflight = runPreflight(parseEnvironment(effectiveEnv));
  const config = preflight.config;
  const processLock = new BridgeProcessLock(preflight.configHome);
  processLock.acquire();

  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });
  const bindings = new BindingStore(preflight.configHome);
  const appServer = new AppServerClient({
    transport: appServerTransport(config, effectiveEnv),
    clientInfo: {
      name: 'lark_codex_gateway',
      title: 'Lark Codex Gateway',
      version: '3.0.0',
    },
    expectedServerVersion: SUPPORTED_APP_SERVER_VERSION,
  });
  const desktop = new DesktopIpcClient();
  const normalizer = new DesktopThreadStreamNormalizer();
  const lark = createLarkRuntimeClients(config, {
    logSink: (level) => logger.warn(`lark_sdk_${level}`),
    onTerminalWebsocketError: resolveFailure,
  });
  const cards = new CardKitClient(
    new CachedTenantTokenProvider(config.larkAppId, config.larkAppSecret),
    lark.api as unknown as LarkReplyApi,
  );
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    onCardError: (error) => logger.error('card_update_failed', error),
    readRateLimits: () => appServer.request('account/rateLimits/read', {}),
  });
  const approvals = new DesktopApprovalService(config, desktop, cards, orchestrator);
  const conversationBindings = new ConversationBindingServiceV3(
    config,
    bindings,
    appServer,
    cards,
    undefined,
    new CodexAppNavigationAdapter(),
  );
  const desktopSupervisor = new DesktopIpcSupervisor(desktop, {
    onReady: (handshake) => {
      normalizer.beginEpoch(handshake.epoch);
      logger.info('desktop_ipc_ready', { epoch: handshake.epoch });
    },
    onDisconnected: async (epoch) => {
      normalizer.reset();
      approvals.abandonAll();
      orchestrator.abandonAll();
      logger.warn('desktop_ipc_abandoned_runtime', { epoch });
    },
    onReconnectError: (error) => logger.error('desktop_ipc_reconnect_failed', error),
  });
  const eventServer = new LarkEventServer(lark.websocket, config, {
    onMessage: async (message) => {
      if (await conversationBindings.handleCommand(message)) {
        return;
      }
      const binding = conversationBindings.getBinding(message.tenantKey, message.chatId);
      if (!binding) {
        await conversationBindings.ensureBoundOrPrompt(message);
        return;
      }
      await orchestrator.handleInbound(message, binding);
    },
    onCardAction: async (action) => {
      if (action.action === 'binding') {
        return conversationBindings.handleCardAction(action);
      }
      if (action.action === 'open') {
        return conversationBindings.handleOpenAction(action);
      }
      if (action.action === 'cancel') {
        const cancelled = await orchestrator.cancel(action);
        return toast(cancelled ? '已请求取消任务' : '任务已结束或操作已失效', cancelled ? 'success' : 'warning');
      }
      return approvals.handleAction(action);
    },
    onRejectedEvent: (reason) => logger.warn('lark_event_rejected', { reason }),
    onHandlerError: (kind, error) => logger.error('lark_event_handler_failed', error, { kind }),
  });
  const unsubscribeDesktop = desktop.onThreadStreamStateChanged((message) => {
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
    bindings.load();
    await verifyCodexRuntimeContract(config, effectiveEnv, preflight.dataDirectory.temporaryDir);
    await desktopSupervisor.start();
    await appServer.start();
    await eventServer.start();
    logger.info('bridge_started', {
      executionMode: 'desktop_follower',
      runtimeInstance: randomUUID().slice(0, 8),
    });
  } catch (error) {
    await stopResources(
      eventServer,
      desktopSupervisor,
      appServer,
      unsubscribeDesktop,
      unsubscribeApproval,
      approvals,
      processLock,
    );
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
      await stopResources(
        eventServer,
        desktopSupervisor,
        appServer,
        unsubscribeDesktop,
        unsubscribeApproval,
        approvals,
        processLock,
      );
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
