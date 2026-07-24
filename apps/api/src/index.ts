import { loadConfig } from './config.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { createDemoSeed } from './seed.js';
import { createServer } from './server.js';

/**
 * Entry point.
 *
 * Still wired to the in-memory adapter: this boots and serves real requests
 * through the real policy engine, but nothing is persisted. Replacing
 * `createMemoryRepositories()` with a Postgres adapter is the next structural
 * step — see docs/adr/0004-persistence.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const repos = createMemoryRepositories(createDemoSeed());
  const app = await createServer({ config, repos });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  // Boot failures are fatal by design: a process that starts with invalid
  // configuration or no authenticator is more dangerous than one that is down.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
