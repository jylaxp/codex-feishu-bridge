#!/usr/bin/env node

import { BridgeLogger } from './logger';
import { parseEnvironment } from './config';
import {
  type BackgroundCommand,
  type BackgroundServiceOptions,
  type BackgroundServiceReport,
  runBackgroundCommand,
} from './background-service';
import { defaultConfigHome, inspectConfigReset, resetConfigHome } from './config-reset';
import { loadBridgeEnvironment } from './config-file';
import { initializeSetupFiles, runSetup, SetupOptions, SetupReport } from './setup';
import type { LocalVersionReport } from './local-version-command';
import type { BotCommandAction, BotCommandReport } from './bot-command';

type Command =
  | 'init'
  | 'run'
  | 'start'
  | 'restart'
  | 'stop'
  | 'status'
  | 'update'
  | 'doctor'
  | 'version'
  | 'compatibility'
  | 'validate-ui-sync'
  | 'config-reset'
  | 'bot'
  | 'setup'
  | 'rebind'
  | 'supervise'
  | 'help';

interface CliArguments {
  readonly command: Command;
  readonly threadId: string | undefined;
  readonly configHome: string | undefined;
  readonly confirm: boolean;
  readonly destructive: boolean;
  readonly rebind: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly approve: boolean;
  readonly botAction: BotCommandAction | undefined;
  readonly appId: string | undefined;
  readonly appSecret: string | undefined;
  readonly botKey: string | undefined;
}

export interface CliRuntime {
  readonly failure: Promise<Error>;
  stop(): Promise<void>;
}

export interface ShutdownSignalWaiter {
  readonly wait: Promise<void>;
  dispose(): void;
}

export interface CliDependencies {
  readonly logger?: BridgeLogger;
  readonly startBridge?: (env: NodeJS.ProcessEnv) => Promise<CliRuntime>;
  readonly createShutdownSignalWaiter?: () => ShutdownSignalWaiter;
  readonly runSetup?: (options: SetupOptions, env: NodeJS.ProcessEnv) => Promise<SetupReport>;
  readonly initializeSetupFiles?: (configHome: string | undefined, env: NodeJS.ProcessEnv) => SetupReport;
  readonly runBackgroundCommand?: (
    command: BackgroundCommand,
    options: BackgroundServiceOptions,
    env: NodeJS.ProcessEnv,
  ) => Promise<BackgroundServiceReport>;
  readonly runLocalVersionCommand?: (
    env: NodeJS.ProcessEnv,
    options: { readonly approve?: boolean },
  ) => Promise<LocalVersionReport>;
  readonly runBotCommand?: (
    options: {
      readonly action: BotCommandAction;
      readonly configHome?: string;
      readonly appId?: string;
      readonly appSecret?: string;
      readonly botKey?: string;
      readonly confirm?: boolean;
      readonly json?: boolean;
    },
    env: NodeJS.ProcessEnv,
  ) => Promise<BotCommandReport>;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  baseEnv: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<void> {
  const parsed = parseArguments(args);
  const runtimeEnv = parsed.configHome
    ? { ...baseEnv, BRIDGE_CONFIG_HOME: parsed.configHome }
    : baseEnv;
  configureCliLogger(dependencies.logger, runtimeEnv);
  if (parsed.command === 'help') {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === 'supervise') {
    const { runProcessSupervisor } = await import('./process-supervisor');
    await runProcessSupervisor();
    return;
  }

  if (parsed.command === 'init') {
    const initialize = dependencies.initializeSetupFiles ?? initializeSetupFiles;
    const report = initialize(parsed.configHome, runtimeEnv);
    process.stdout.write(`✅ 已初始化配置：${report.envPath}\n`);
    return;
  }

  if (parsed.command === 'doctor') {
    const { runDoctor } = await import('./doctor');
    process.stdout.write(`${JSON.stringify(await runDoctor(loadBridgeEnvironment(runtimeEnv)), null, 2)}\n`);
    return;
  }
  if (parsed.command === 'version' || parsed.command === 'compatibility') {
    const localVersion = await import('./local-version-command');
    const inspect = dependencies.runLocalVersionCommand ?? localVersion.runLocalVersionCommand;
    let report: LocalVersionReport;
    try {
      report = await inspect(runtimeEnv, {
        approve: parsed.command === 'compatibility' && parsed.approve,
      });
    } catch (error) {
      if (parsed.command !== 'compatibility') {
        throw error;
      }
      const failure = Object.freeze({
        conclusion: '不兼容' as const,
        compatible: false,
        status: 'inspection_failed' as const,
      });
      process.stdout.write(parsed.json
        ? `${JSON.stringify(failure, null, 2)}\n`
        : '不兼容\n状态: inspection_failed\n');
      return;
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(parsed.command === 'version'
        ? localVersion.formatLocalVersion(report)
        : localVersion.formatCompatibility(report));
    }
    return;
  }
  if (parsed.command === 'config-reset') {
    const configHome = parsed.configHome ?? defaultConfigHome();
    const report = parsed.confirm
      ? resetConfigHome(configHome, { confirm: true, destructive: parsed.destructive })
      : inspectConfigReset(configHome);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'bot') {
    const botCommand = await import('./bot-command');
    const run = dependencies.runBotCommand ?? botCommand.runBotCommand;
    await run({
      action: parsed.botAction ?? 'list',
      configHome: parsed.configHome,
      appId: parsed.appId,
      appSecret: parsed.appSecret,
      botKey: parsed.botKey,
      confirm: parsed.confirm,
      json: parsed.json,
    }, runtimeEnv);
    return;
  }
  if (parsed.command === 'setup' || parsed.command === 'rebind') {
    const setup = dependencies.runSetup ?? runSetup;
    await setup({
      configHome: parsed.configHome,
      rebind: parsed.command === 'rebind' || parsed.rebind,
    }, runtimeEnv);
    return;
  }
  if (
    parsed.command === 'start'
    || parsed.command === 'restart'
    || parsed.command === 'stop'
    || parsed.command === 'status'
    || parsed.command === 'update'
  ) {
    if (parsed.command === 'start' || parsed.command === 'restart') {
      const setup = dependencies.runSetup ?? runSetup;
      await setup({ configHome: parsed.configHome, rebind: false }, runtimeEnv);
    }
    const background = dependencies.runBackgroundCommand ?? runBackgroundCommand;
    await background(parsed.command, {
      configHome: parsed.configHome,
      forceUpdate: parsed.force,
      jsonOutput: parsed.json,
    }, runtimeEnv);
    return;
  }
  if (parsed.command === 'validate-ui-sync') {
    const { runUiSyncValidator } = await import('./ui-sync-validator');
    const result = await runUiSyncValidator(loadBridgeEnvironment(runtimeEnv), parsed.threadId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (!dependencies.startBridge) {
    const setup = dependencies.runSetup ?? runSetup;
    await setup({ configHome: parsed.configHome, rebind: false }, runtimeEnv);
  }
  const shutdown = dependencies.createShutdownSignalWaiter?.()
    ?? createShutdownSignalWaiter();
  try {
    const startBridge = dependencies.startBridge ?? (await import('./main')).startBridge;
    const runtime = await startBridge(loadBridgeEnvironment(runtimeEnv));
    const outcome = await Promise.race([
      shutdown.wait.then(() => ({ type: 'shutdown' as const })),
      runtime.failure.then((error) => ({ type: 'failure' as const, error })),
    ]);
    try {
      await runtime.stop();
    } catch (error) {
      if (outcome.type === 'failure') {
        throw new AggregateError(
          [outcome.error, toError(error)],
          'Bridge runtime and shutdown both failed',
        );
      }
      throw error;
    }
    if (outcome.type === 'failure') {
      throw outcome.error;
    }
  } finally {
    shutdown.dispose();
  }
}

function configureCliLogger(logger: BridgeLogger | undefined, env: NodeJS.ProcessEnv): void {
  if (!logger) {
    return;
  }
  try {
    const config = parseEnvironment(loadBridgeEnvironment(env));
    logger.configure({
      configHome: config.configHome ?? defaultConfigHome(),
      logToFile: config.logToFile,
      logFilePath: config.logFilePath,
    });
  } catch {
    // The logger is fail-closed until a complete, valid logging configuration is loaded.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Bridge CLI error');
}

function parseArguments(args: readonly string[]): CliArguments {
  let command: Command = 'run';
  let threadId: string | undefined;
  let configHome: string | undefined;
  let confirm = false;
  let destructive = false;
  let rebind = false;
  let force = false;
  let json = false;
  let approve = false;
  let botAction: BotCommandAction | undefined;
  let appId: string | undefined;
  let appSecret: string | undefined;
  let botKey: string | undefined;
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--thread') {
      threadId = requireOptionValue(args, index, '--thread');
      index += 1;
      continue;
    }
    if (argument === '--config-home') {
      configHome = requireOptionValue(args, index, '--config-home');
      index += 1;
      continue;
    }
    if (argument === '--confirm') {
      confirm = true;
      continue;
    }
    if (argument === '--destructive') {
      destructive = true;
      continue;
    }
    if (argument === '--rebind') {
      rebind = true;
      continue;
    }
    if (argument === '--force' || argument === '-f') {
      force = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--approve') {
      approve = true;
      continue;
    }
    if (argument === '--app-id') {
      appId = requireOptionValue(args, index, '--app-id');
      index += 1;
      continue;
    }
    if (argument === '--app-secret') {
      appSecret = requireOptionValue(args, index, '--app-secret');
      index += 1;
      continue;
    }
    if (argument === '--bot-key') {
      botKey = requireOptionValue(args, index, '--bot-key');
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      command = 'help';
      commandSeen = true;
      continue;
    }
    if (!commandSeen && argument === 'config' && args[index + 1] === 'reset') {
      command = 'config-reset';
      commandSeen = true;
      index += 1;
      continue;
    }
    if (!commandSeen && isCommand(argument)) {
      command = argument;
      commandSeen = true;
      if (command === 'bot') {
        const next = args[index + 1];
        if (next && !next.startsWith('--')) {
          botAction = parseBotAction(next);
          index += 1;
        } else {
          botAction = 'list';
        }
      }
      continue;
    }
    throw new Error(`Unknown CLI argument: ${argument ?? ''}`);
  }

  if (threadId && command !== 'validate-ui-sync') {
    throw new Error('--thread is only valid with validate-ui-sync');
  }
  if (
    configHome
    && command !== 'config-reset'
    && command !== 'setup'
    && command !== 'rebind'
    && command !== 'init'
    && command !== 'run'
    && command !== 'start'
    && command !== 'restart'
    && command !== 'stop'
    && command !== 'status'
    && command !== 'update'
    && command !== 'version'
    && command !== 'compatibility'
    && command !== 'bot'
  ) {
    throw new Error('--config-home is not valid with this command');
  }
  if (confirm && command !== 'config-reset' && command !== 'bot') {
    throw new Error('--confirm is only valid with config reset or bot remove');
  }
  if (destructive && command !== 'config-reset') {
    throw new Error('--destructive is only valid with config reset');
  }
  if (rebind && command !== 'setup') {
    throw new Error('--rebind is only valid with setup');
  }
  if (force && command !== 'update') {
    throw new Error('--force is only valid with update');
  }
  if (json && command !== 'status' && command !== 'version' && command !== 'compatibility' && command !== 'bot') {
    throw new Error('--json is only valid with status, version, compatibility, or bot');
  }
  if (approve && command !== 'compatibility') {
    throw new Error('--approve is only valid with compatibility');
  }
  if ((appId || appSecret) && command !== 'bot') {
    throw new Error('--app-id and --app-secret are only valid with bot import');
  }
  if (botKey && command !== 'bot') {
    throw new Error('--bot-key is only valid with bot management commands');
  }
  if (command === 'bot') {
    const action = botAction ?? 'list';
    if ((appId || appSecret) && action !== 'import') {
      throw new Error('--app-id and --app-secret are only valid with bot import');
    }
    if (
      botKey
      && action !== 'rebind'
      && action !== 'enable'
      && action !== 'disable'
      && action !== 'remove'
    ) {
      throw new Error('--bot-key is only valid with bot rebind, enable, disable, or remove');
    }
  }
  return {
    command,
    threadId,
    configHome,
    confirm,
    destructive,
    rebind,
    force,
    json,
    approve,
    botAction,
    appId,
    appSecret,
    botKey,
  };
}

function requireOptionValue(
  args: readonly string[],
  optionIndex: number,
  optionName: string,
): string {
  const value = args[optionIndex + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function isCommand(value: string | undefined): value is Command {
  return value === 'run'
    || value === 'init'
    || value === 'start'
    || value === 'restart'
    || value === 'stop'
    || value === 'status'
    || value === 'update'
    || value === 'doctor'
    || value === 'version'
    || value === 'compatibility'
    || value === 'validate-ui-sync'
    || value === 'config-reset'
    || value === 'bot'
    || value === 'setup'
    || value === 'rebind'
    || value === 'supervise'
    || value === 'help';
}

function parseBotAction(value: string | undefined): BotCommandAction {
  if (value === undefined) {
    return 'list';
  }
  if (
    value === 'add'
    || value === 'import'
    || value === 'migrate-default'
    || value === 'rebind'
    || value === 'enable'
    || value === 'disable'
    || value === 'remove'
    || value === 'list'
    || value === 'doctor'
  ) {
    return value;
  }
  throw new Error(`Unknown bot command: ${value}`);
}

function createShutdownSignalWaiter(): ShutdownSignalWaiter {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = (): void => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
  return {
    wait,
    dispose: () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
    },
  };
}

function helpText(): string {
  return [
    'Codex Feishu Bridge 2',
    '',
    'Usage:',
    '  codex-feishu-bridge init [--config-home PATH]',
    '  codex-feishu-bridge setup [--rebind] [--config-home PATH]',
    '  codex-feishu-bridge rebind [--config-home PATH]',
    '  codex-feishu-bridge run [--config-home PATH]',
    '  codex-feishu-bridge start [--config-home PATH]',
    '  codex-feishu-bridge restart [--config-home PATH]',
    '  codex-feishu-bridge stop [--config-home PATH]',
    '  codex-feishu-bridge status [--json] [--config-home PATH]',
    '  codex-feishu-bridge update [--force] [--config-home PATH]',
    '  codex-feishu-bridge doctor',
    '  codex-feishu-bridge version [--json] [--config-home PATH]',
    '  codex-feishu-bridge compatibility [--json] [--approve] [--config-home PATH]',
    '  codex-feishu-bridge bot add [--config-home PATH]',
    '  codex-feishu-bridge bot import --app-id APP_ID --app-secret SECRET [--config-home PATH]',
    '  codex-feishu-bridge bot migrate-default [--config-home PATH]',
    '  codex-feishu-bridge bot rebind --bot-key BOT_KEY [--config-home PATH]',
    '  codex-feishu-bridge bot enable --bot-key BOT_KEY [--config-home PATH]',
    '  codex-feishu-bridge bot disable --bot-key BOT_KEY [--config-home PATH]',
    '  codex-feishu-bridge bot remove --bot-key BOT_KEY --confirm [--config-home PATH]',
    '  codex-feishu-bridge bot list [--json] [--config-home PATH]',
    '  codex-feishu-bridge validate-ui-sync [--thread THREAD_ID]',
    '  codex-feishu-bridge config reset [--config-home PATH] [--confirm] [--destructive]',
    '',
    'Alias: cfb is equivalent to codex-feishu-bridge.',
    'Configuration is loaded from ~/.codex-feishu-bridge/.env by default.',
    'Process/service-manager environment values override the .env file.',
    'setup creates the private .env and scans a Feishu QR code when app credentials are missing.',
    'run/start/restart also invoke setup automatically when credentials are missing.',
    'rebind forces a new Feishu QR-code app registration and replaces LARK_APP_ID/LARK_APP_SECRET.',
    'start/restart/stop/status manage the PID file and logs under ~/.codex-feishu-bridge/.',
    'version detects local ChatGPT/Codex versions and refreshes protocol-versions.json.',
    'compatibility reports 兼容/不兼容; --approve explicitly adds a compatible exact version.',
    'bot add scans one QR code, fetches the robot identity, and generates the internal botKey.',
    'bot migrate-default materializes the existing .env robot as the reserved default bot.',
    'validate-ui-sync without --thread lists recent workspace tasks.',
    'config reset is a dry run until --confirm; --destructive is required to clear an already-current binding.',
    '',
  ].join('\n');
}

if (require.main === module) {
  const logger = new BridgeLogger();
  void runCli(undefined, process.env, { logger }).catch((error: unknown) => {
    logger.error('bridge_cli_failed', error);
    process.exitCode = 1;
  });
}
