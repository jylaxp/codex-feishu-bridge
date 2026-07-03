import net from 'net';
import WebSocket from 'ws';
import os from 'os';
import path from 'path';

const tmpdir = os.tmpdir();
const sockFile = path.join(tmpdir, 'codex-ipc', 'ipc-501.sock');

console.log('Testing socket:', sockFile);

const ws = new WebSocket('ws://localhost/', {
  createConnection: () => net.createConnection(sockFile)
});

ws.on('open', () => {
  console.log('Connected!');
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/list', params: {} }));
});

ws.on('message', (data) => {
  console.log('Message:', data.toString());
  process.exit(0);
});

ws.on('error', (err) => {
  console.log('Error:', err.message);
  process.exit(1);
});
