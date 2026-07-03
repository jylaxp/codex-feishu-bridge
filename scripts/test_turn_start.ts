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
    title: 'Test Turn Start',
    threadSource: 'user'
  });
  const id = resp.thread.id;
  console.log('Created thread:', id);
  
  await new Promise(r => setTimeout(r, 1000));
  const dbPath = path.join(process.env.HOME || '', '.codex', 'state_5.sqlite');
  
  execSync(`sqlite3 "${dbPath}" "UPDATE threads SET preview = 'Manually Set', has_user_event = 1 WHERE id = '${id}';"`);
  console.log('Updated DB to has_user_event=1');
  
  await adapter.request('turn/start', {
    threadId: id,
    input: [{
      role: 'user',
      content: [{ type: 'text', text: 'this is a test message' }]
    }]
  });
  console.log('Sent turn/start');
  
  await new Promise(r => setTimeout(r, 4000));
  const hasEvent = execSync(`sqlite3 "${dbPath}" "SELECT has_user_event FROM threads WHERE id = '${id}';"`).toString().trim();
  console.log('After turn/start, has_user_event is:', hasEvent);
  
  process.exit(0);
}
run().catch(console.error);
