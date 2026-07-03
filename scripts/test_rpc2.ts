import { LocalAppServerAdapter } from '../src/adapter';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const adapter = new LocalAppServerAdapter();

async function run() {
  await adapter.connect();
  const threads = await adapter.request('thread/list', { archived: false, limit: null, sortKey: 'updated_at' });
  const t = threads.data.find((x: any) => x.name === '测试会话');
  console.log('Test session:', t);
  process.exit(0);
}
run().catch(console.error);
