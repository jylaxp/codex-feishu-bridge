import { LocalAppServerAdapter } from './src/adapter';

async function main() {
  const adapter = new LocalAppServerAdapter();
  await adapter.connect();
  const res = await adapter.request('thread/list', { limit: 10 });
  const threads = res?.threads || [];
  if (threads.length > 0) {
    const threadId = threads[0].id;
    const turnsRes = await adapter.request('thread/turns/list', { threadId });
    const turns = turnsRes?.turns || [];
    if (turns.length > 0) {
      console.log('Turn stats:', turns[turns.length - 1].stats);
    }
  } else {
    console.log('No threads.');
  }
  process.exit(0);
}
main().catch(console.error);
