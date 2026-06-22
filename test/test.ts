import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import * as ws from 'ws';
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

  const dummyServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end();
  });

  const wss = new ws.WebSocketServer({ noServer: true });

  dummyServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  });

  wss.on('connection', (webSocket) => {
    webSocket.on('message', (message) => {
      try {
        const req = JSON.parse(message.toString());
        if (req.method === 'initialize') {
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              userAgent: 'mock-codex/1.0.0',
              codexHome: '/Users/dummy/.codex',
              platformFamily: 'unix',
              platformOs: 'macos'
            }
          }));
        } else if (req.method === 'thread/list') {
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              data: [
                { id: 'thread-123', name: 'Test Session', preview: 'Last message' }
              ]
            }
          }));
        } else if (req.method === 'thread/resume') {
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              thread: {
                id: req.params.threadId,
                name: 'Mock Thread',
                turns: []
              }
            }
          }));
        } else if (req.method === 'turn/start') {
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              turn: {
                id: 'turn-456'
              }
            }
          }));

          // Simulate notifications
          setTimeout(() => {
            webSocket.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId: req.params.threadId, turnId: 'turn-456' }
            }));
          }, 20);

          setTimeout(() => {
            webSocket.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'agent/stdout',
              params: { threadId: req.params.threadId, turnId: 'turn-456', chunk: 'Mock log line 1' }
            }));
          }, 40);

          setTimeout(() => {
            webSocket.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { threadId: req.params.threadId, turnId: 'turn-456' }
            }));
          }, 60);
        }
      } catch (e) {
        console.error('Mock WS server parse error:', e);
      }
    });
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
    // Test 1.5: Spawning App Server with invalid binary (ENOENT)
    // -------------------------------------------------------------
    console.log('\n[Test 1.5] Testing spawn failure with invalid binary (ENOENT)...');
    
    process.env.CODEX_BIN = 'non-existent-codex-binary';
    const adapter1_5 = new LocalAppServerAdapter({ socketPath: nonExistentSocket });
    let errorThrown = false;
    try {
      await adapter1_5.connect();
    } catch (e: any) {
      errorThrown = true;
      console.log('Successfully caught expected spawn error:', e.message || e);
      assert.ok(e.code === 'ENOENT' || (e.message && e.message.includes('ENOENT')), 'Should fail with ENOENT');
    } finally {
      delete process.env.CODEX_BIN;
      adapter1_5.disconnect();
    }
    assert.ok(errorThrown, 'Should throw error when binary is missing');
    console.log('✅ Test 1.5 Passed.');

    // -------------------------------------------------------------
    // Test 2: Connecting directly to App Server via WebSocket when socket exists
    // -------------------------------------------------------------
    console.log('\n[Test 2] Testing direct WebSocket connection (socket exists)...');
    
    const adapter2 = new LocalAppServerAdapter({ socketPath: dummySocketPath });
    let connected = false;

    await adapter2.connect();
    connected = true;
    
    // Give it a brief moment
    await new Promise(r => setTimeout(r, 100));

    assert.ok(connected, 'Should connect successfully to the mock WebSocket server');
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
