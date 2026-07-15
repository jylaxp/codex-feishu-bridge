import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BridgeLogger } from '../../src/app/logger';

test('writes opted-in operational logs only below the private config-home log directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-logger-'));
  try {
    const logger = new BridgeLogger();
    logger.configure({ configHome: home, logToFile: true, logFilePath: 'bridge.log' });
    logger.info('desktop ready', { epoch: 3 });
    const logPath = join(home, 'logs', 'bridge.log');
    assert.equal(existsSync(logPath), true);
    assert.match(readFileSync(logPath, 'utf8'), /desktop_ready/);
    assert.throws(
      () => logger.configure({ configHome: home, logToFile: true, logFilePath: '../outside.log' }),
      /must resolve beneath/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uses a single logs directory when the legacy path setting is omitted', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-logger-default-'));
  try {
    const logger = new BridgeLogger();
    logger.configure({ configHome: home, logToFile: true, logFilePath: null });
    logger.info('default path');
    assert.equal(existsSync(join(home, 'logs', 'bridge.log')), true);
    assert.equal(existsSync(join(home, 'logs', 'logs', 'bridge.log')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
