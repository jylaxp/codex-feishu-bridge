import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BridgeLogger } from '../../src/app/logger';

test('LOG_TO_FILE=false disables every structured log level', () => {
  const output: string[] = [];
  const logger = new BridgeLogger({
    write: (value) => {
      output.push(String(value));
      return true;
    },
  });

  logger.configure({
    configHome: '/unused',
    logToFile: false,
    logFilePath: 'bridge.log',
  });
  logger.info('info_event');
  logger.warn('warn_event');
  logger.error('error_event', new Error('failure'));

  assert.deepEqual(output, []);
});

test('an unconfigured logger is disabled by default', () => {
  const output: string[] = [];
  const logger = new BridgeLogger({
    write: (value) => output.push(String(value)),
  });

  logger.error('unconfigured_error', new Error('must remain silent'));

  assert.deepEqual(output, []);
});

test('LOG_TO_FILE=true writes structured logs only to the configured file', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-logger-'));
  const output: string[] = [];
  try {
    const logger = new BridgeLogger({
      write: (value) => {
        output.push(String(value));
        return true;
      },
    });
    logger.configure({
      configHome: root,
      logToFile: true,
      logFilePath: 'bridge.log',
    });

    logger.info('enabled_event', { count: 1 });

    assert.deepEqual(output, []);
    assert.match(readFileSync(join(root, 'logs', 'bridge.log'), 'utf8'), /"event":"enabled_event"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed reconfiguration disables the logger and clears its previous destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-logger-failure-'));
  const logPath = join(root, 'logs', 'bridge.log');
  try {
    const logger = new BridgeLogger();
    logger.configure({ configHome: root, logToFile: true, logFilePath: 'bridge.log' });
    logger.info('before_failure');

    assert.throws(
      () => logger.configure({
        configHome: root,
        logToFile: true,
        logFilePath: '../outside.log',
      }),
      /must resolve beneath Bridge config-home logs/,
    );
    logger.info('after_failure');

    const contents = readFileSync(logPath, 'utf8');
    assert.match(contents, /before_failure/);
    assert.doesNotMatch(contents, /after_failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a log destination failure disables logging without escaping to business code', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-logger-write-failure-'));
  try {
    const logger = new BridgeLogger();
    logger.configure({ configHome: root, logToFile: true, logFilePath: 'bridge.log' });
    mkdirSync(join(root, 'logs', 'bridge.log'));

    assert.doesNotThrow(() => logger.info('write_failure'));
    assert.doesNotThrow(() => logger.error('after_write_failure', new Error('still silent')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
