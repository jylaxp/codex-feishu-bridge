const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const WebSocket = require('ws');

const socketPath = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');

async function main() {
  console.log('Connecting to socket:', socketPath);
  const ws = new WebSocket('ws://codex-app-server/', {
    perMessageDeflate: false,
    createConnection: () => {
      return net.createConnection(socketPath);
    }
  });

  ws.on('open', async () => {
    console.log('Connected! Sending initialize...');
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'test', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      }
    };
    ws.send(JSON.stringify(initReq));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Received message, id/method:', msg.id || msg.method);

    if (msg.id === 1) {
      // Initialize response received, now list threads
      const listReq = {
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/list',
        params: { limit: 100, archived: false }
      };
      console.log('Sending thread/list...');
      ws.send(JSON.stringify(listReq));
    } else if (msg.id === 2) {
      console.log('Received thread/list response!');
      fs.writeFileSync('threads_output.json', JSON.stringify(msg.result, null, 2));
      console.log('Saved to threads_output.json');
      ws.close();
    }
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err);
  });
}

main().catch(console.error);
