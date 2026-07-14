export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Minimal structured logger which accepts only curated scalar fields. */
export class BridgeLogger {
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
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event: normalizeEventName(event),
      ...fields,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
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
  const errorWithCode = error as Error & { readonly code?: unknown };
  if (
    typeof errorWithCode.code === 'string'
    || typeof errorWithCode.code === 'number'
  ) {
    fields.errorCode = String(errorWithCode.code).slice(0, 100);
  }
  return fields;
}
