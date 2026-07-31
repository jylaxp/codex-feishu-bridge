import { LocalAppServerAdapter } from '../src/adapter';
import { loadBridgeEnvironment } from '../src/app/config-file';

Object.assign(process.env, loadBridgeEnvironment(process.env));

const adapter = new LocalAppServerAdapter();

async function run() {
  await adapter.init();
  const threads = await adapter.request('thread/list', { archived: false, limit: 10, sortKey: 'updated_at' });
  
  const native = threads.data.find((t: any) => t.cwd === '/Users/jiang/work/project/ai' && t.name !== '测试会话' && t.name !== '测试 hello');
  const bridge = threads.data.find((t: any) => t.cwd === '/Users/jiang/work/project/ai' && t.name === '测试会话');
  
  console.log('--- NATIVE THREAD ---');
  console.log(JSON.stringify(native, null, 2));
  console.log('--- BRIDGE THREAD ---');
  console.log(JSON.stringify(bridge, null, 2));
  
  process.exit(0);
}
run().catch(console.error);
