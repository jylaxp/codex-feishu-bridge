import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { digestJsonSchemaDirectory } from '../../src/app/codex/runtime-contract';
import { BridgeDatabase } from '../../src/app/db/database';
import { BridgeRepositories } from '../../src/app/db/repositories';
import { runDoctor } from '../../src/app/doctor';

function writeSchema(root: string, content: string): void {
  fs.mkdirSync(path.join(root, 'v2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'v2', 'schema.json'), content);
}

void test('schema digest ignores JSON object key order while preserving array order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-doctor-test-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const changed = path.join(root, 'changed');
  try {
    writeSchema(
      first,
      '{"definitions":{"beta":{"type":"string"},"alpha":{"type":"number"}},'
        + '"required":["b","a"]}',
    );
    writeSchema(
      second,
      '{"required":["b","a"],"definitions":{"alpha":{"type":"number"},'
        + '"beta":{"type":"string"}}}',
    );
    writeSchema(
      changed,
      '{"required":["a","b"],"definitions":{"alpha":{"type":"number"},'
        + '"beta":{"type":"string"}}}',
    );

    assert.strictEqual(
      digestJsonSchemaDirectory(first),
      digestJsonSchemaDirectory(second),
    );
    assert.notStrictEqual(
      digestJsonSchemaDirectory(first),
      digestJsonSchemaDirectory(changed),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test('doctor reports the durable failed CardKit outbox count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-doctor-report-'));
  const workspace = path.join(root, 'workspace');
  const dataDirectory = path.join(root, 'data');
  const codexBinary = path.join(root, 'codex');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(codexBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const database = new BridgeDatabase(path.join(dataDirectory, 'bridge.db'));
  try {
    database.open();
    const repositories = new BridgeRepositories(database);
    const inbox = repositories.inbox.record({
      tenantKey: 'tenant-test',
      eventId: 'event-test',
      messageId: 'message-test',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      payloadDigest: 'digest-test',
      receivedAtMs: 1,
    }).record;
    const binding = repositories.threadBindings.getOrCreate({
      tenantKey: 'tenant-test',
      chatId: 'chat-test',
      rootMessageId: 'root-test',
      projectId: 'project-test',
      workspacePath: workspace,
      threadId: 'thread-test',
      nowMs: 2,
    });
    const task = repositories.tasks.create({
      bindingId: binding.id,
      sourceInboxId: inbox.id,
      prompt: 'test doctor metrics',
      nowMs: 3,
    });
    const outbox = repositories.cardOutbox.enqueue({
      taskId: task.id,
      operation: 'UPDATE_CARD',
      projectionRevision: 1,
      cardSequence: 0,
      idempotencyKey: 'doctor-failed-outbox',
      payloadJson: '{}',
      nowMs: 4,
    });
    repositories.cardOutbox.claimDue('doctor-worker', 4, 100, 1);
    repositories.cardOutbox.markFailed(
      outbox.id,
      'doctor-worker',
      'CARDKIT_API_FATAL',
      5,
    );
    database.close();

    const report = await runDoctor({
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret-test',
      LARK_TENANT_KEY: 'tenant-test',
      ALLOWED_CHATS: 'chat-test',
      AUTHORIZED_USERS: 'user-test',
      ALLOWED_APPROVERS: 'approver-test',
      CODEX_BIN: codexBinary,
      CODEX_CWD: workspace,
      ALLOWED_WORKSPACE_ROOTS: workspace,
      BRIDGE_DATA_DIR: dataDirectory,
    }, {
      verifyRuntimeContract: async () => ({
        codexVersion: 'codex-cli test',
        schemaDigest: 'schema-test',
      }),
    });

    assert.strictEqual(report.failedOutboxCount, 1);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
