import { LocalAppServerAdapter } from '../src/adapter';
import dotenv from 'dotenv';
import path from 'path';
import { execSync } from 'child_process';

dotenv.config({ path: path.join(__dirname, '../.env') });
const adapter = new LocalAppServerAdapter();

async function run() {
  await adapter.connect();
  const resp: any = await adapter.request('thread/start', {
    cwd: '/Users/jiang/work/project/ai',
    title: 'Testing Deep Link Open',
    threadSource: 'user'
  });
  const id = resp.thread.id;
  console.log('Created thread:', id);
  
  await adapter.request('turn/start', {
    threadId: id,
    input: [{
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }]
    }]
  });
  console.log('Started turn.');
  
  // wait 2s for db write
  await new Promise(r => setTimeout(r, 2000));
  
  execSync(`open "codex://chat/${id}"`);
  console.log('Sent open command.');
  
  process.exit(0);
}
run().catch(console.error);
