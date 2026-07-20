import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ROTATED_LOGS = 3;

export interface BridgeLoggerOptions {
  readonly configHome: string;
  readonly logToFile: boolean;
  readonly logFilePath: string | null;
}

export interface BridgeLogOutput {
  write(value: string): unknown;
}

/** Minimal structured logger which accepts only curated scalar fields. */
export class BridgeLogger {
  private enabled = false;
  private filePath: string | undefined;

  public constructor(private readonly output: BridgeLogOutput = process.stdout) {}

  /** Enables or disables all runtime logs after trusted preflight resolves config home. */
  public configure(options: BridgeLoggerOptions): void {
    this.enabled = false;
    this.filePath = undefined;
    if (!options.logToFile) {
      return;
    }
    const requested = options.logFilePath ?? 'bridge.log';
    const absolute = isAbsolute(requested);
    const resolved = absolute ? normalize(requested) : normalize(join(options.configHome, 'logs', requested));
    const permittedRoot = normalize(join(options.configHome, 'logs'));
    if (!absolute && !isWithin(resolved, permittedRoot)) {
      throw new RangeError('LOG_FILE_PATH must resolve beneath Bridge config-home logs');
    }
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    this.filePath = resolved;
    this.enabled = true;
  }
  public info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  public warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  public error(event: string, error: unknown, fields: LogFields = {}): void {
    const safeError = errorIdentity(error);
    this.write('error', event, { ...fields, ...safeError });
  }

  private write(level: string, event: string, fields: LogFields): void {
    if (!this.enabled) {
      return;
    }
    try {
      const record = {
        timestamp: new Date().toISOString(),
        level,
        event: normalizeEventName(event),
        ...fields,
      };
      const line = `${JSON.stringify(record)}\n`;
      if (!this.filePath) {
        this.output.write(line);
        return;
      }
      rotateIfNeeded(this.filePath, Buffer.byteLength(line, 'utf8'));
      appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging is diagnostic only. Disable the failed destination so storage or
      // output errors can never interrupt message delivery or shutdown handling.
      this.enabled = false;
      this.filePath = undefined;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function rotateIfNeeded(filePath: string, incomingBytes: number): void {
  if (!existsSync(filePath) || statSync(filePath).size + incomingBytes <= MAX_LOG_BYTES) {
    return;
  }
  for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (existsSync(source)) {
      renameSync(source, target);
    }
  }
  renameSync(filePath, `${filePath}.1`);
}

function normalizeEventName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  return normalized || 'bridge_event';
}

function errorIdentity(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorType: 'UnknownError' };
  }
  const fields: Record<string, string> = { errorType: error.name || 'Error' };
  // CardKit returns the actionable failure reason only in Error.message. Keeping a
  // bounded, single-line copy is necessary to distinguish sequence, payload, and
  // transport failures without ever serializing a request body or token.
  if (error.message) {
    fields.errorMessage = error.message.replace(/\s+/g, ' ').slice(0, 500);
  }
  const errorWithCode = error as Error & { readonly code?: unknown };
  if (
    typeof errorWithCode.code === 'string'
    || typeof errorWithCode.code === 'number'
  ) {
    fields.errorCode = String(errorWithCode.code).slice(0, 100);
  }
  return fields;
}
