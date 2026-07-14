#!/usr/bin/env node

import { BridgeLogger } from './logger';
import { defaultConfigHome, inspectConfigReset, resetConfigHome } from './config-reset';
import { loadBridgeEnvironment } from './config-file';

type Command = 'run' | 'doctor' | 'validate-ui-sync' | 'config-reset' | 'help';

interface CliArguments {
  readonly command: Command;
  readonly threadId: string | undefined;
  readonly configHome: string | undefined;
  readonly confirm: boolean;
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
  readonly startBridge?: (env: NodeJS.ProcessEnv) => Promise<CliRuntime>;
  readonly createShutdownSignalWaiter?: () => ShutdownSignalWaiter;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  baseEnv: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.command === 'help') {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === 'doctor') {
    const { runDoctor } = await import('./doctor');
    process.stdout.write(`${JSON.stringify(await runDoctor(loadBridgeEnvironment(baseEnv)), null, 2)}\n`);
    return;
  }
  if (parsed.command === 'config-reset') {
    const configHome = parsed.configHome ?? defaultConfigHome();
    const report = parsed.confirm
      ? resetConfigHome(configHome, { confirm: true })
      : inspectConfigReset(configHome);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'validate-ui-sync') {
    const { runUiSyncValidator } = await import('./ui-sync-validator');
    const result = await runUiSyncValidator(loadBridgeEnvironment(baseEnv), parsed.threadId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const shutdown = dependencies.createShutdownSignalWaiter?.()
    ?? createShutdownSignalWaiter();
  try {
    const startBridge = dependencies.startBridge ?? (await import('./main')).startBridge;
    const runtime = await startBridge(loadBridgeEnvironment(baseEnv));
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Bridge CLI error');
}

function parseArguments(args: readonly string[]): CliArguments {
  let command: Command = 'run';
  let threadId: string | undefined;
  let configHome: string | undefined;
  let confirm = false;
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
      continue;
    }
    throw new Error(`Unknown CLI argument: ${argument ?? ''}`);
  }

  if (threadId && command !== 'validate-ui-sync') {
    throw new Error('--thread is only valid with validate-ui-sync');
  }
  if (configHome && command !== 'config-reset') {
    throw new Error('--config-home is only valid with config reset');
  }
  if (confirm && command !== 'config-reset') {
    throw new Error('--confirm is only valid with config reset');
  }
  return { command, threadId, configHome, confirm };
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
    || value === 'doctor'
    || value === 'validate-ui-sync'
    || value === 'config-reset'
    || value === 'help';
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
    '  codex-feishu-bridge run',
    '  codex-feishu-bridge doctor',
    '  codex-feishu-bridge validate-ui-sync [--thread THREAD_ID]',
    '  codex-feishu-bridge config reset [--config-home PATH] [--confirm]',
    '',
    'Configuration is loaded from ~/.codex-feishu-bridge/.env by default.',
    'Process/service-manager environment values override the .env file.',
    'validate-ui-sync without --thread lists recent workspace tasks.',
    'config reset is a dry run until --confirm; it retains only .env and starts empty bindings.',
    '',
  ].join('\n');
}

if (require.main === module) {
  const logger = new BridgeLogger();
  void runCli().catch((error: unknown) => {
    logger.error('bridge_cli_failed', error);
    process.exitCode = 1;
  });
}
