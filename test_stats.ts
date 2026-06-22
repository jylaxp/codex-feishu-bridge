import { LocalAppServerAdapter } from './src/adapter';

async function main() {
  const adapter = new LocalAppServerAdapter();
  await adapter.connect();
  console.log('Connected to codex app server');
  try {
    const listRes = await adapter.request('thread/list', { limit: 10, archived: false });
    const threads = listRes?.threads || [];
    if (threads.length > 0) {
      const threadId = threads[0].id;
      console.log('Fetching turns for thread:', threadId);
      const turnsRes = await adapter.request('thread/turns/list', { threadId });
      const turns = turnsRes?.turns || [];
      if (turns.length > 0) {
        const lastTurn = turns[turns.length - 1];
        console.log('Latest Turn Stats:', JSON.stringify(lastTurn.stats || lastTurn, null, 2));
      } else {
        console.log('No turns found in thread.');
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}

main().catch(console.error);
