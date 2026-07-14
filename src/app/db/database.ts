import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema';

const BUSY_TIMEOUT_MS = 5_000;

/** Minimal synchronous database surface exposed to repositories. */
export interface DatabaseExecutor {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

/** Security and durability settings verified after opening the database. */
export interface DatabasePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly busyTimeoutMs: number;
  readonly foreignKeys: boolean;
  readonly trustedSchema: boolean;
}

export type BridgeDatabaseErrorCode =
  | 'DATABASE_ALREADY_OPEN'
  | 'DATABASE_NOT_OPEN'
  | 'DATABASE_TRANSACTION_NESTED'
  | 'DATABASE_ASYNC_TRANSACTION'
  | 'DATABASE_PRAGMA_INVALID'
  | 'DATABASE_SCHEMA_NEWER';

/** Stable database error which does not expose SQL or filesystem internals. */
export class BridgeDatabaseError extends Error {
  public constructor(
    public readonly code: BridgeDatabaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeDatabaseError';
  }
}

/**
 * Owns the Bridge's file-backed SQLite connection.
 *
 * Construction is deliberately side-effect free. Call {@link open} during
 * application bootstrap and {@link close} during graceful shutdown.
 */
export class BridgeDatabase implements DatabaseExecutor {
  private readonly databasePath: string;
  private database: DatabaseSync | undefined;
  private transactionActive = false;

  public constructor(databasePath: string) {
    this.databasePath = resolve(databasePath);
  }

  /** Absolute path of the database file. */
  public get path(): string {
    return this.databasePath;
  }

  /** Whether the underlying SQLite connection is currently open. */
  public get isOpen(): boolean {
    return this.database !== undefined;
  }

  /**
   * Opens, hardens, verifies, and migrates the database.
   *
   * @throws BridgeDatabaseError when called more than once or when the stored
   * schema is newer than this binary.
   */
  public open(): void {
    if (this.database !== undefined) {
      throw new BridgeDatabaseError('DATABASE_ALREADY_OPEN', 'Bridge database is already open');
    }

    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.databasePath, {
      open: false,
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      defensive: true,
    });

    try {
      database.open();
      this.database = database;
      database.enableDefensive(true);
      database.enableLoadExtension(false);
      this.configureConnection(database);
      chmodSync(this.databasePath, 0o600);
      this.migrate();
    } catch (error) {
      this.database = undefined;
      try {
        database.close();
      } catch {
        // Preserve the bootstrap error. The connection may not have opened.
      }
      throw error;
    }
  }

  /** Closes the database connection. Calling close on a closed instance is safe. */
  public close(): void {
    const database = this.database;
    if (database === undefined) {
      return;
    }
    if (this.transactionActive) {
      throw new BridgeDatabaseError(
        'DATABASE_TRANSACTION_NESTED',
        'Cannot close Bridge database while a transaction is active',
      );
    }
    this.database = undefined;
    database.close();
  }

  /** Executes trusted, static SQL. External values must use prepared statements. */
  public exec(sql: string): void {
    this.requireDatabase().exec(sql);
  }

  /** Prepares SQL for bound execution. */
  public prepare(sql: string): StatementSync {
    return this.requireDatabase().prepare(sql);
  }

  /**
   * Executes a synchronous unit of work under a reserved write lock.
   *
   * Network calls and asynchronous work are rejected so a transaction cannot
   * accidentally remain open across an event-loop turn.
   */
  public transaction<T>(work: (executor: DatabaseExecutor) => T): T {
    if (this.transactionActive) {
      throw new BridgeDatabaseError(
        'DATABASE_TRANSACTION_NESTED',
        'Nested Bridge database transactions are not supported',
      );
    }

    const database = this.requireDatabase();
    database.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    try {
      const result = work(this);
      if (isPromiseLike(result)) {
        throw new BridgeDatabaseError(
          'DATABASE_ASYNC_TRANSACTION',
          'Bridge database transactions must be synchronous',
        );
      }
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Bridge database transaction and rollback both failed',
        );
      }
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  /** Returns the durable schema version recorded by migrations. */
  public getSchemaVersion(): number {
    const row = this.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (row === undefined) {
      return 0;
    }
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BridgeDatabaseError(
        'DATABASE_SCHEMA_NEWER',
        'Bridge database contains an invalid schema version',
      );
    }
    return value;
  }

  /** Reads the connection settings used by health checks and tests. */
  public getPragmas(): DatabasePragmas {
    const database = this.requireDatabase();
    return {
      journalMode: readStringPragma(database, 'journal_mode'),
      synchronous: readNumberPragma(database, 'synchronous'),
      busyTimeoutMs: readNumberPragma(database, 'busy_timeout', 'timeout'),
      foreignKeys: readNumberPragma(database, 'foreign_keys') === 1,
      trustedSchema: readNumberPragma(database, 'trusted_schema') === 1,
    };
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) {
      throw new BridgeDatabaseError('DATABASE_NOT_OPEN', 'Bridge database is not open');
    }
    return this.database;
  }

  private configureConnection(database: DatabaseSync): void {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
    `);

    const pragmas = this.getPragmas();
    if (
      pragmas.journalMode.toLowerCase() !== 'wal'
      || pragmas.synchronous !== 2
      || pragmas.busyTimeoutMs !== BUSY_TIMEOUT_MS
      || !pragmas.foreignKeys
      || pragmas.trustedSchema
    ) {
      throw new BridgeDatabaseError(
        'DATABASE_PRAGMA_INVALID',
        'Bridge database security or durability settings could not be applied',
      );
    }
  }

  private migrate(): void {
    this.transaction((executor) => {
      executor.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
        ) STRICT;
      `);

      const currentVersion = this.getSchemaVersion();
      if (currentVersion > CURRENT_SCHEMA_VERSION) {
        throw new BridgeDatabaseError(
          'DATABASE_SCHEMA_NEWER',
          'Bridge database schema is newer than this application',
        );
      }

      const updateVersion = executor.prepare(`
        INSERT INTO meta (key, value, updated_at_ms)
        VALUES ('schema_version', ?, ?)
        ON CONFLICT (key) DO UPDATE SET
          value = excluded.value,
          updated_at_ms = excluded.updated_at_ms
      `);

      for (const migration of SCHEMA_MIGRATIONS) {
        if (migration.version <= currentVersion) {
          continue;
        }
        executor.exec(migration.sql);
        updateVersion.run(String(migration.version), Date.now());
      }
    });
  }
}

function readStringPragma(database: DatabaseSync, pragmaName: string): string {
  const row = database.prepare(`PRAGMA ${pragmaName}`).get();
  const value = row?.[pragmaName];
  if (typeof value !== 'string') {
    throw new BridgeDatabaseError(
      'DATABASE_PRAGMA_INVALID',
      `Bridge database did not return ${pragmaName}`,
    );
  }
  return value;
}

function readNumberPragma(
  database: DatabaseSync,
  pragmaName: string,
  resultColumn: string = pragmaName,
): number {
  const row = database.prepare(`PRAGMA ${pragmaName}`).get();
  const value = row?.[resultColumn];
  if (typeof value !== 'number') {
    throw new BridgeDatabaseError(
      'DATABASE_PRAGMA_INVALID',
      `Bridge database did not return ${pragmaName}`,
    );
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && 'then' in value && typeof value.then === 'function';
}
