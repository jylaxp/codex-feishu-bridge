import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { LocalAppServerAdapter } from '../src/adapter';

process.env.NODE_ENV = 'test';

// Add our mock bin directory to the front of PATH
const binPath = path.join(__dirname, 'bin');
process.env.PATH = `${binPath}:${process.env.PATH}`;

async function runTests() {
  console.log('--- Running Codex Bridge Adapter Tests ---');

  const dummySocketPath = path.join(__dirname, 'dummy-socket.sock');
  
  // Start a dummy unix socket server to simulate a live Codex instance
  if (fs.existsSync(dummySocketPath)) {
    fs.unlinkSync(dummySocketPath);
  }
  const dummyServer = net.createServer((socket) => {
    socket.on('data', () => {});
  });
  await new Promise<void>((resolve) => {
    dummyServer.listen(dummySocketPath, () => resolve());
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Spawning App Server when socket file does NOT exist
    // -------------------------------------------------------------
    console.log('\n[Test 1] Testing standalone App Server startup (socket does not exist)...');
    
    const nonExistentSocket = path.join(__dirname, 'non-existent-socket.sock');
    if (fs.existsSync(nonExistentSocket)) {
      fs.unlinkSync(nonExistentSocket);
    }

    const adapter1 = new LocalAppServerAdapter({ socketPath: nonExistentSocket });
    let spawnedArgs1 = '';

    adapter1.onNotification((msg) => {
      if (msg.method === 'agent/stderr' && msg.params?.chunk?.includes('MOCK_CODEX_ARGS:')) {
        spawnedArgs1 = msg.params.chunk;
      }
    });

    await adapter1.connect();
    
    // Give it a brief moment to run and output stderr
    await new Promise(r => setTimeout(r, 200));

    console.log('Spawned arguments observed:', spawnedArgs1);
    assert.ok(spawnedArgs1.includes('app-server --listen stdio://'), 'Should spawn standalone stdio app-server');
    adapter1.disconnect();
    console.log('✅ Test 1 Passed.');

    // -------------------------------------------------------------
    // Test 2: Spawning App Server proxy when socket file DOES exist
    // -------------------------------------------------------------
    console.log('\n[Test 2] Testing proxy connection (socket exists)...');
    
    const adapter2 = new LocalAppServerAdapter({ socketPath: dummySocketPath });
    let spawnedArgs2 = '';

    adapter2.onNotification((msg) => {
      if (msg.method === 'agent/stderr' && msg.params?.chunk?.includes('MOCK_CODEX_ARGS:')) {
        spawnedArgs2 = msg.params.chunk;
      }
    });

    await adapter2.connect();
    
    // Give it a brief moment
    await new Promise(r => setTimeout(r, 200));

    console.log('Spawned arguments observed:', spawnedArgs2);
    assert.ok(spawnedArgs2.includes('app-server proxy --sock'), 'Should spawn proxy command');
    assert.ok(spawnedArgs2.includes(dummySocketPath), 'Should pass correct socket path');
    adapter2.disconnect();
    console.log('✅ Test 2 Passed.');

    // -------------------------------------------------------------
    // Test 3: List Threads JSON-RPC communication
    // -------------------------------------------------------------
    console.log('\n[Test 3] Testing listThreads()...');
    
    const adapter3 = new LocalAppServerAdapter({ socketPath: dummySocketPath });
    await adapter3.connect();

    const threads = await adapter3.listThreads();
    console.log('Threads retrieved:', JSON.stringify(threads));
    assert.strictEqual(threads.length, 1);
    assert.strictEqual(threads[0].id, 'thread-123');
    assert.strictEqual(threads[0].name, 'Test Session');
    
    console.log('✅ Test 3 Passed.');

    // -------------------------------------------------------------
    // Test 4: Start Turn & Stream Notifications
    // -------------------------------------------------------------
    console.log('\n[Test 4] Testing startRemoteControlTurn() & notifications...');

    let turnStartedSeen = false;
    let logLineSeen = false;
    let turnCompletedSeen = false;

    adapter3.onNotification((msg) => {
      if (msg.method === 'turn/started') {
        assert.strictEqual(msg.params?.turnId, 'turn-456');
        turnStartedSeen = true;
      } else if (msg.method === 'agent/stdout') {
        assert.strictEqual(msg.params?.chunk, 'Mock log line 1');
        logLineSeen = true;
      } else if (msg.method === 'turn/completed') {
        assert.strictEqual(msg.params?.turnId, 'turn-456');
        turnCompletedSeen = true;
      }
    });

    const turnId = await adapter3.startRemoteControlTurn({
      threadId: 'thread-123',
      cwd: '/dummy/cwd',
      prompt: 'hello codex'
    });

    console.log('Turn ID started:', turnId);
    assert.strictEqual(turnId, 'turn-456');

    // Wait for the simulated async notifications from the mock script
    await new Promise(r => setTimeout(r, 300));

    console.log('Notifications observed:');
    console.log('  - turn/started:', turnStartedSeen);
    console.log('  - agent/stdout (log):', logLineSeen);
    console.log('  - turn/completed:', turnCompletedSeen);

    assert.ok(turnStartedSeen, 'Should receive turn/started notification');
    assert.ok(logLineSeen, 'Should receive log line notification');
    assert.ok(turnCompletedSeen, 'Should receive turn/completed notification');

    adapter3.disconnect();
    console.log('✅ Test 4 Passed.');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');

  } catch (err) {
    console.error('\n❌ Test Failure:', err);
    process.exit(1);
  } finally {
    // Cleanup dummy socket server and file
    await new Promise<void>((resolve) => {
      dummyServer.close(() => resolve());
    });
    if (fs.existsSync(dummySocketPath)) {
      fs.unlinkSync(dummySocketPath);
    }
  }
}

runTests();
