import * as http from 'http';
import * as fs from 'fs';

const logFile = '/tmp/chatgpt-injector.log';
fs.writeFileSync(logFile, `[CodexInjector] Injector script loaded in PID ${process.pid}!\n`);
fs.appendFileSync(logFile, `[CodexInjector] Argv: ${JSON.stringify(process.argv)}\n`);
fs.appendFileSync(logFile, `[CodexInjector] ExecPath: ${process.execPath}\n`);
fs.appendFileSync(logFile, `[CodexInjector] process.type: ${(process as any).type}\n`);

const Module = require('module');
const originalLoad = Module._load;
let injectorStarted = false;

Module._load = function(request: string, parent: any, isMain: boolean) {
    const exports = originalLoad.apply(this, arguments as any);
    
    if (request === 'electron' && !injectorStarted && (process as any).type === 'browser') {
        injectorStarted = true;
        fs.appendFileSync(logFile, `[CodexInjector] Captured electron module from Module._load!\n`);
        
        setImmediate(() => {
            startInjector(exports);
        });
    }
    
    return exports;
};

function startInjector(electron: any) {
    if (electron && electron.app) {
        fs.appendFileSync(logFile, '[CodexInjector] Successfully attached to Electron main process.\n');

        electron.app.on('ready', () => {
            fs.appendFileSync(logFile, '[CodexInjector] App is ready, starting HTTP API...\n');
            const server = http.createServer((req, res) => {
                // Simple CORS headers
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                if (req.method === 'POST' && req.url === '/refresh') {
                    try {
                        const activeWebContents = electron.webContents.getAllWebContents();
                        let triggeredCount = 0;
                        
                        activeWebContents.forEach((wc: any) => {
                            wc.send("codex_desktop:message-for-view", {
                                type: "ipc-broadcast",
                                method: "query-cache-invalidate",
                                sourceClientId: "desktop",
                                version: 1,
                                params: { queryKey: ["threads"] }
                            });
                            wc.send("codex_desktop:message-for-view", {
                                type: "ipc-broadcast",
                                method: "query-cache-invalidate",
                                sourceClientId: "desktop",
                                version: 1,
                                params: { queryKey: ["thread"] }
                            });
                            triggeredCount++;
                        });

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, triggeredWebContents: triggeredCount }));
                    } catch (err: any) {
                        fs.appendFileSync(logFile, `[CodexInjector] Error during refresh: ${err.message}\n`);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message }));
                    }
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
                }
            });

            const PORT = 45678;
            server.listen(PORT, '127.0.0.1', () => {
                fs.appendFileSync(logFile, `[CodexInjector] HTTP API listening on http://127.0.0.1:${PORT}\n`);
            });
        });
    } else {
        fs.appendFileSync(logFile, '[CodexInjector] Electron object is missing app. Exiting.\n');
    }
}
