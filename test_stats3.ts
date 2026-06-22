import { LocalAppServerAdapter } from './src/adapter';

async function main() {
  const adapter = new LocalAppServerAdapter();
  await adapter.connect();
  const res = await adapter.request('account/rateLimits/read', {});
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}
main().catch(console.error);
