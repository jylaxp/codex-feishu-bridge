import { LocalAppServerAdapter } from './src/adapter';

async function main() {
    const adapter = new LocalAppServerAdapter();
    await adapter.connect();
    
    try {
        console.log("Calling thread/list...");
        const res = await adapter.request('thread/list', {});
        console.log("thread/list succeeded!", Object.keys(res));
    } catch (e: any) {
        console.error("thread/list failed:", e.message);
    }
    
    process.exit(0);
}
main().catch(console.error);
