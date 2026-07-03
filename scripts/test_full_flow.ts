import { LocalAppServerAdapter } from '../src/adapter';
import dotenv from 'dotenv';
import path from 'path';
import { execSync } from 'child_process';

dotenv.config({ path: path.join(__dirname, '../.env') });
const adapter = new LocalAppServerAdapter();

const dbPath = path.join(process.env.HOME || '', '.codex', 'state_5.sqlite');

async function run() {
  await adapter.connect();
  const resp: any = await adapter.request('thread/start', {
    cwd: '/Users/jiang/work/project/ai',
    title: 'Testing Feishu Flow',
    threadSource: 'user'
  });
  const id = resp.thread.id;
  console.log('Created thread:', id);
  
  await new Promise(r => setTimeout(r, 1000));
  
  execSync(`sqlite3 "${dbPath}" "UPDATE threads SET preview = 'New Session from Feishu', has_user_event = 1 WHERE id = '${id}';"`);
  console.log('Updated DB preview.');
  
  execSync(`open "codex://chat/${id}"`);
  console.log('Sent open command.');
  
  process.exit(0);
}
run().catch(console.error);
