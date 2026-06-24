const net = require('net');
const path = require('path');
const os = require('os');
const socketPath = path.join(os.homedir(), 'Library/Application Support/codex/codex.sock');
const client = net.createConnection(socketPath, () => {
  client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'model/list', params: {} }) + '\n');
  client.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'models/list', params: {} }) + '\n');
  client.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'config/get', params: {} }) + '\n');
});
client.on('data', data => { console.log(data.toString()); });
setTimeout(() => client.destroy(), 2000);
