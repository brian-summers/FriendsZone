import { loadConfig } from './config.js';
import { createMemoryRepositories } from './repositories/memory.js';
import {
  applySchema,
  createPgClient,
  createPgliteClient,
  type SqlClient,
} from './repositories/sql/client.js';
import { createSqlRepositories } from './repositories/sql/postgres.js';
import { createDemoSeed } from './seed.js';
import { createServer } from './server.js';

/**
 * Entry point.
 *
 * PostgreSQL with row-level security (docs/adr/0004-persistence.md), reached
 * through raw SQL behind a two-method client (docs/adr/0026-sql-layer.md). The
 * in-memory adapters remain for tests and for a throwaway demo run.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  /**
   * The store is chosen by `DATABASE_URL`, and production refuses `memory:`.
   *
   * The demo seed is only ever loaded into a *fresh in-memory* run. Seeding a
   * real database would overwrite live data with fixtures on every start, which
   * is a spectacular way to lose a production system.
   */
  const url = config.DATABASE_URL;
  let db: SqlClient | null = null;

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    db = await createPgClient(url);
  } else if (url.startsWith('pglite://')) {
    db = await createPgliteClient(url.slice('pglite://'.length) || undefined);
  }

  if (db !== null) await applySchema(db);
  const repos = db === null ? createMemoryRepositories(createDemoSeed()) : createSqlRepositories(db);

  const app = await createServer({ config, repos });

  if (db !== null) {
    const shutdown = async (): Promise<void> => {
      await app.close();
      await db.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  // Boot failures are fatal by design: a process that starts with invalid
  // configuration or no authenticator is more dangerous than one that is down.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
