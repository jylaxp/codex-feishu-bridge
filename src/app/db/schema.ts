/**
 * Current Bridge database schema version.
 *
 * Migrations are append-only. Existing migration SQL must never be edited after
 * release because a database can be upgraded through more than one version.
 */
export const CURRENT_SCHEMA_VERSION = 5;

/** A single, ordered database schema migration. */
export interface SchemaMigration {
  readonly version: number;
  readonly sql: string;
}

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inbox_event (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  event_id TEXT,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  sender_open_id TEXT,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('RECEIVED', 'ACCEPTED', 'PROCESSED', 'REJECTED')
  ),
  error_code TEXT,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= received_at_ms),
  UNIQUE (tenant_key, message_id),
  UNIQUE (tenant_key, event_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_inbox_event_status_received
  ON inbox_event (status, received_at_ms);

CREATE TABLE IF NOT EXISTS thread_binding (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  thread_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (tenant_key, chat_id, root_message_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_binding_thread_id
  ON thread_binding (thread_id)
  WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  source_inbox_id TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'RECEIVED', 'CARD_CREATING', 'STARTING', 'RUNNING',
      'AWAITING_APPROVAL', 'COMPLETING', 'SUCCEEDED', 'FAILED',
      'INTERRUPTED', 'QUEUED', 'DISPATCH_UNKNOWN', 'RECOVERING',
      'NEEDS_REVIEW', 'DELIVERY_DELAYED'
    )
  ),
  turn_id TEXT,
  card_id TEXT,
  card_message_id TEXT,
  card_sequence INTEGER NOT NULL DEFAULT 0 CHECK (card_sequence >= 0),
  projection_revision INTEGER NOT NULL DEFAULT 0 CHECK (projection_revision >= 0),
  final_text TEXT,
  error_code TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  FOREIGN KEY (binding_id) REFERENCES thread_binding (id) ON DELETE RESTRICT,
  FOREIGN KEY (source_inbox_id) REFERENCES inbox_event (id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_turn_id
  ON task (turn_id)
  WHERE turn_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_single_active_turn
  ON task ((1))
  WHERE status IN (
    'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETING',
    'DISPATCH_UNKNOWN', 'RECOVERING'
  );

CREATE INDEX IF NOT EXISTS idx_task_status_created
  ON task (status, created_at_ms);

CREATE TABLE IF NOT EXISTS task_item (
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  phase TEXT,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
  content_text TEXT,
  terminal_payload_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (task_id, item_id),
  FOREIGN KEY (task_id) REFERENCES task (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_task_item_task_updated
  ON task_item (task_id, updated_at_ms);

CREATE TABLE IF NOT EXISTS rpc_intent (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  task_id TEXT,
  method TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 0),
  rpc_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('PREPARED', 'SENT', 'RESOLVED', 'FAILED', 'UNKNOWN')
  ),
  error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  FOREIGN KEY (task_id) REFERENCES task (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_rpc_intent_task_state
  ON rpc_intent (task_id, state, created_at_ms);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 0),
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  item_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'DECIDED', 'EXPIRED', 'STALE', 'CANCELLED')
  ),
  available_decisions_json TEXT NOT NULL,
  action_token_hash TEXT NOT NULL UNIQUE,
  decision TEXT,
  decided_by_open_id TEXT,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  decided_at_ms INTEGER CHECK (decided_at_ms IS NULL OR decided_at_ms >= created_at_ms),
  UNIQUE (connection_epoch, request_id, method),
  FOREIGN KEY (task_id) REFERENCES task (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_approval_pending_expiry
  ON approval (status, expires_at_ms);

CREATE TABLE IF NOT EXISTS card_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  card_sequence INTEGER NOT NULL CHECK (card_sequence >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('PENDING', 'IN_FLIGHT', 'RETRY', 'DELIVERED', 'SUPERSEDED', 'FAILED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
  lease_owner TEXT,
  lease_until_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= created_at_ms),
  UNIQUE (task_id, projection_revision, operation),
  FOREIGN KEY (task_id) REFERENCES task (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_card_outbox_claim
  ON card_outbox (state, next_attempt_at_ms, lease_until_ms, created_at_ms);
`;

const DECISION_BOUND_APPROVAL_AND_QUERY_INDEXES_SQL = `
ALTER TABLE approval
  ADD COLUMN action_token_hashes_json TEXT NOT NULL DEFAULT '{}';

-- A v1 token was not bound to a decision. Fail closed during upgrade instead
-- of allowing an old pending approval to inherit broader v2 semantics.
UPDATE approval
SET status = 'STALE'
WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_task_binding_status_created
  ON task (binding_id, status, created_at_ms, id);

CREATE INDEX IF NOT EXISTS idx_task_queued_order
  ON task (created_at_ms, id)
  WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS idx_task_item_ordered
  ON task_item (task_id, created_at_ms, item_id);
`;

const CANCELLATION_TOKEN_AND_RECOVERY_INDEXES_SQL = `
ALTER TABLE task
  ADD COLUMN cancel_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_cancel_token_hash
  ON task (cancel_token_hash)
  WHERE cancel_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_recovery_status_updated
  ON task (status, updated_at_ms, id)
  WHERE status IN (
    'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETING',
    'DISPATCH_UNKNOWN', 'RECOVERING'
  );
`;

const DURABLE_STEER_PAYLOAD_SQL = `
ALTER TABLE inbox_event
  ADD COLUMN payload_text TEXT;

CREATE INDEX IF NOT EXISTS idx_rpc_intent_method_state_created
  ON rpc_intent (method, state, created_at_ms, id);
`;

const EXPLICIT_CHAT_THREAD_BINDING_SQL = `
DROP INDEX IF EXISTS uq_thread_binding_thread_id;

CREATE INDEX IF NOT EXISTS idx_thread_binding_thread_id
  ON thread_binding (thread_id)
  WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_thread_binding (
  tenant_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  workspace_path TEXT,
  bound_by_open_id TEXT,
  thread_title TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (thread_id IS NULL AND workspace_path IS NULL AND bound_by_open_id IS NULL)
    OR
    (thread_id IS NOT NULL AND workspace_path IS NOT NULL AND bound_by_open_id IS NOT NULL)
  ),
  PRIMARY KEY (tenant_key, chat_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_chat_thread_binding_thread_id
  ON chat_thread_binding (thread_id)
  WHERE thread_id IS NOT NULL;
`;

/** Ordered schema migrations applied by {@link BridgeDatabase}. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
  Object.freeze({ version: 1, sql: INITIAL_SCHEMA_SQL }),
  Object.freeze({ version: 2, sql: DECISION_BOUND_APPROVAL_AND_QUERY_INDEXES_SQL }),
  Object.freeze({ version: 3, sql: CANCELLATION_TOKEN_AND_RECOVERY_INDEXES_SQL }),
  Object.freeze({ version: 4, sql: DURABLE_STEER_PAYLOAD_SQL }),
  Object.freeze({ version: 5, sql: EXPLICIT_CHAT_THREAD_BINDING_SQL }),
]);
