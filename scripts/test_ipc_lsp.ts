import net from 'net';
import os from 'os';
import path from 'path';

const tmpdir = os.tmpdir();
const sockFile = path.join(tmpdir, 'codex-ipc', 'ipc-501.sock');

const socket = net.createConnection(sockFile);
socket.on('connect', () => {
  console.log('Connected!');
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/list', params: {} });
  const payload = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
  socket.write(payload);
});

socket.on('data', (data) => {
  console.log('Data:', data.toString());
  process.exit(0);
});
