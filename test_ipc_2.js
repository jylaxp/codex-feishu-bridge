const net = require('net');
const sockPath = '/Users/jiang/.codex/app-server-control/app-server-control.sock';
const client = net.createConnection(sockPath, () => {
    console.log('Connected');
    const obj = { type: 'request', requestId: '123', version: 1, method: 'initialize', params: { clientName: 'test' } };
    const jsonStr = JSON.stringify(obj);
    const buf = Buffer.from(jsonStr, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(buf.length, 0);
    client.write(header);
    client.write(buf);
});
client.on('data', (chunk) => {
    console.log('Received chunk of length', chunk.length);
    if (chunk.length > 4) {
        const len = chunk.readUInt32LE(0);
        console.log('Parsed len:', len);
        console.log('String:', chunk.slice(4).toString('utf8'));
    } else {
        console.log(chunk);
    }
});
client.on('error', (err) => console.error(err));
