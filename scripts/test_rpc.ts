import { LocalAppServerAdapter } from '../src/adapter';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const adapter = new LocalAppServerAdapter();

async function run() {
  await adapter.connect();
  const startRes = await adapter.request('thread/start', { threadSource: 'user', cwd: '/Users/jiang/work/project/ai' });
  const threadId = startRes.thread?.id || startRes.threadId;
  console.log('Created thread:', threadId, 'with cwd in startRes:', startRes.thread?.cwd || startRes.cwd);
  
  try {
    const cwdRes = await adapter.request('thread/cwd/set', { threadId, cwd: '/Users/jiang/work/project/ai' });
    console.log('Set cwd response:', cwdRes);
  } catch (e: any) {
    console.log('Failed to set cwd:', e.message || e);
  }
  
  const threads = await adapter.listThreads();
  const t = threads.find((x: any) => x.id === threadId);
  console.log('Thread from list:', t);
  
  process.exit(0);
}
run().catch(console.error);
