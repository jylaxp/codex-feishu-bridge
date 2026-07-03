import net from 'net';
import os from 'os';
import path from 'path';

const tmpdir = os.tmpdir();
const sockFile = path.join(tmpdir, 'codex-ipc', 'ipc-501.sock');

const socket = net.createConnection(sockFile);
socket.on('connect', () => {
  console.log('Connected!');
  socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/list', params: {} }) + '\n');
});

socket.on('data', (data) => {
  console.log('Message:', data.toString());
  process.exit(0);
});

socket.on('error', (err) => {
  console.log('Error:', err.message);
  process.exit(1);
});
