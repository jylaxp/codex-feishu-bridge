import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DesktopIpcSupervisor,
  type DesktopIpcLifecycleClient,
} from '../../src/app/codex/desktop-ipc-supervisor';
import type { DesktopIpcHandshake } from '../../src/app/codex/desktop-ipc-client';

class FakeDesktopIpcClient implements DesktopIpcLifecycleClient {
  public starts = 0;
  public stops = 0;
  private readonly listeners = new Set<(epoch: number) => void>();

  public async start(): Promise<DesktopIpcHandshake> {
    this.starts += 1;
    return {
      clientId: 'bridge-client',
      epoch: this.starts,
      socketPath: '/private/tmp/codex-ipc/ipc-501.sock',
      transport: 'unix_socket',
    };
  }

  public async stop(): Promise<void> {
    this.stops += 1;
  }

  public onConnectionLost(listener: (epoch: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emitConnectionLost(epoch: number): void {
    for (const listener of this.listeners) {
      listener(epoch);
    }
  }
}

test('abandons current work and reconnects only after a connection loss', async () => {
  const client = new FakeDesktopIpcClient();
  const disconnectedEpochs: number[] = [];
  const readyEpochs: number[] = [];
  const supervisor = new DesktopIpcSupervisor(client, {
    reconnectInitialDelayMs: 1,
    reconnectMaximumDelayMs: 2,
    onDisconnected: async (epoch) => {
      disconnectedEpochs.push(epoch);
    },
    onReady: (handshake) => readyEpochs.push(handshake.epoch),
  });

  await supervisor.start();
  client.emitConnectionLost(1);
  await waitFor(() => client.starts === 2);

  assert.deepEqual(disconnectedEpochs, [1]);
  assert.deepEqual(readyEpochs, [1, 2]);
  assert.equal(supervisor.state, 'READY');
  await supervisor.stop();
  assert.equal(client.stops, 1);
});

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 100;
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('condition did not become true'));
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
}
