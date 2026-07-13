/**
 * Minimal Noise IK client for Codex remote control relay.
 * Attempts WebSocket connection + Noise IK handshake.
 */
const WebSocket = require('ws');
const NoiseHandshake = require('noise-handshake');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RELAY_URL = 'wss://chatgpt.com/backend-api/wham/remote/control/server';

// Load auth
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
const accessToken = auth.tokens?.access_token;
const accountId = auth.tokens?.account_id;
const installId = '90dbfe2e-9ce9-460f-b805-c94878bd8554';

// Generate our Noise keypair
const sodium = require('sodium-native');
const ourSecretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
const ourPublicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
sodium.randombytes_buf(ourSecretKey);
sodium.crypto_scalarmult_base(ourPublicKey, ourSecretKey);

console.log('Our public key:', ourPublicKey.toString('hex').slice(0, 32) + '...');

async function tryConnect(headers, label) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===`);
    const ws = new WebSocket(RELAY_URL, {
      headers,
      // Accept binary frames
      maxPayload: 1024 * 1024,
    });

    let msgCount = 0;

    ws.on('open', () => {
      console.log('✅ WebSocket connected!');
      console.log('Starting Noise IK handshake...');

      try {
        // Create IK initiator
        const ik = new NoiseHandshake('IK', true);
        // Use a dummy remote static key (32 bytes) — real one would come from enrollment
        const dummyRemoteKey = crypto.randomBytes(32);
        ik.initialise(Buffer.alloc(0), dummyRemoteKey);

        // Send initial handshake message
        const initMsg = ik.send(Buffer.alloc(0));
        console.log(`Sending Noise IK initial message (${initMsg.length} bytes)`);

        // Frame with 4-byte big-endian length prefix (protobuf-style)
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(initMsg.length, 0);
        ws.send(Buffer.concat([lenBuf, initMsg]));

        // Also send raw (unframed)
        ws.send(initMsg);
      } catch(e) {
        console.log('Handshake error:', e.message);
      }
    });

    ws.on('message', (data) => {
      msgCount++;
      console.log(`← Message #${msgCount}: ${data.length} bytes`);
      console.log(`  First 40 bytes: ${data.slice(0, 40).toString('hex')}`);

      // Try length-prefixed
      if (data.length >= 4) {
        const len = data.readUInt32BE(0);
        console.log(`  Length field: ${len} (0x${len.toString(16)})`);
        if (len > 0 && len < data.length) {
          console.log(`  Body (${len}b): ${data.slice(4, Math.min(4+len, 100)).toString('hex')}`);
        }
      }

      // Try as raw text
      try {
        const text = data.toString('utf8').slice(0, 100);
        if (/^[\x20-\x7e]+$/.test(text)) {
          console.log(`  Text: ${text}`);
        }
      } catch {}
    });

    ws.on('error', (err) => {
      console.log(`❌ ${err.message}`);
      resolve();
    });

    ws.on('unexpected-response', (req, res) => {
      console.log(`HTTP ${res.statusCode}`);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        console.log(`Body: ${body.slice(0, 300)}`);
        resolve();
      });
    });

    ws.on('close', (code, reason) => {
      console.log(`Closed: ${code} ${reason?.toString() || ''}`);
      resolve();
    });

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('(still open after 8s)');
        ws.close();
      }
      resolve();
    }, 8000);
  });
}

(async () => {
  // Try various header combinations
  await tryConnect({
    'x-codex-installation-id': installId,
  }, 'only x-codex-installation-id');

  await tryConnect({
    'x-codex-installation-id': installId,
    'Authorization': `Bearer ${accessToken}`,
  }, '+ Bearer token');

  await tryConnect({
    'x-codex-installation-id': installId,
    'x-codex-account-id': accountId,
    'x-codex-client-name': 'bridge-test',
    'x-codex-server-name': 'jiangMBP.local',
    'x-codex-environment-id': 'env_e_6a072fd2b910832ebdc289ae088cd748',
  }, 'all codex headers');

  await tryConnect({
    'x-codex-installation-id': installId,
    'Authorization': `Bearer ${accessToken}`,
    'x-codex-account-id': accountId,
    'Sec-WebSocket-Protocol': 'noise-hybrid-ik-v1',
  }, 'noise WS subprotocol');

  await tryConnect({
    'x-codex-installation-id': installId,
    'Authorization': `Bearer ${accessToken}`,
    'x-codex-account-id': accountId,
    'Sec-WebSocket-Protocol': 'codex-remote-control-v1',
  }, 'codex WS subprotocol');

  console.log('\n=== All tests complete ===');
  process.exit(0);
})();
