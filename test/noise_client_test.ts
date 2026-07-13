/**
 * Noise Client Test — connects to Codex cloud relay.
 * Step 1: Raw WebSocket connection to see what the server expects.
 * Step 2: Noise IK handshake + protobuf framing.
 */
import WebSocket from 'ws';
import NoiseHandshake from 'noise-handshake';
import * as crypto from 'crypto';

const RELAY_URL = 'wss://chatgpt.com/backend-api/wham/remote/control/server';

// Read auth tokens from ~/.codex/auth.json
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
const accessToken = auth.tokens?.access_token;
const accountId = auth.tokens?.account_id;

async function main() {
  console.log('=== Codex Remote Control Relay Client Test ===\n');

  // Step 1: Raw WebSocket connection
  console.log(`1. Connecting to ${RELAY_URL}...`);

  const ws = new WebSocket(RELAY_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'x-codex-installation-id': '90dbfe2e-9ce9-460f-b805-c94878bd8554',
      'User-Agent': 'codex-bridge/2.0.0',
    },
  });

  let pongReceived = false;
  ws.on('ping', () => { pongReceived = true; });

  ws.on('open', () => {
    console.log('   ✅ WebSocket connected');
    console.log(`   Ping received: ${pongReceived}`);
  });

  ws.on('message', (data: Buffer) => {
    console.log(`   ← Message (${data.length} bytes): ${data.toString('hex').slice(0, 100)}...`);
    // Try to parse as protobuf
    try {
      // First byte might be a protobuf varint length prefix
      console.log(`   First bytes: ${Array.from(data.slice(0, 10)).map(b => b.toString(16)).join(' ')}`);
    } catch {}
  });

  ws.on('error', (err: Error) => {
    console.log(`   ❌ Error: ${err.message}`);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`   WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
  });

  // Wait a few seconds
  await new Promise(r => setTimeout(r, 5000));

  if (ws.readyState === WebSocket.OPEN) {
    console.log('\n2. WebSocket still open — server accepted connection');
    console.log('   Attempting Noise IK handshake...\n');

    // Try Noise IK initiator handshake
    try {
      const ik = new NoiseHandshake('IK', true); // IK pattern, initiator=true
      const localKeypair = ik.generateKeypair();

      // The remote static key would come from enrollment
      // For now, try with a dummy — the handshake will fail but we'll see the error format
      const remoteStaticKey = crypto.randomBytes(32);

      // Perform handshake
      const handshakeMsg = ik.initialMessage(remoteStaticKey);
      console.log(`   Sending Noise IK initial message (${handshakeMsg.length} bytes)...`);
      ws.send(Buffer.concat([
        encodeVarint(handshakeMsg.length),
        handshakeMsg,
      ]));

      // Wait for response
      await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.log(`   Noise handshake error: ${e.message}`);
    }
  }

  ws.close();
  console.log('\nDone.');
}

// Simple protobuf-style varint encoding
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

main().catch(e => console.error('Fatal:', e));
