import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The whole database interface: two methods.
 *
 * Small on purpose. `pg` runs it in production and PGlite — real Postgres,
 * compiled to WebAssembly — runs it in tests, so **the adapter under test is
 * the adapter that ships**. Untested SQL is the failure mode this design is
 * most exposed to, and one interface closes it
 * (docs/adr/0026-sql-layer.md).
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * `actorId` becomes `app.actor_id` via `SET LOCAL`, which is scoped to the
   * transaction — never to the connection, because a pooled connection would
   * carry one request's identity into the next.
   *
   * `crossOwner` admits the sanctioned writes that touch another person's rows
   * (accepting a hangout, booking a handoff). It defaults to off, so a caller
   * that needs it has to say so, in a diff a reviewer can see.
   */
  transaction<T>(
    fn: (tx: SqlClient) => Promise<T>,
    opts?: { actorId?: string | null; crossOwner?: boolean },
  ): Promise<T>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Apply the schema.
 *
 * Idempotent — every statement is `if not exists` or `create or replace` — so
 * this runs on every boot rather than needing a migration runner for a schema
 * that has never yet been migrated. The moment a column has to *change*, this
 * becomes an ordered set of files and a `schema_migrations` table, and not
 * before: a migration framework for one file is ceremony.
 */
export async function applySchema(client: SqlClient): Promise<void> {
  // `dist` sits beside `src`, so resolve relative to this module and fall back
  // to the source tree when running from TypeScript directly.
  const candidates = [join(here, 'schema.sql'), join(here, '../../../src/repositories/sql/schema.sql')];

  let sql: string | null = null;
  for (const path of candidates) {
    try {
      sql = await readFile(path, 'utf8');
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (sql === null) throw new Error('schema.sql not found');

  await client.query(sql);
}

/**
 * Wrap a PGlite instance.
 *
 * Used by tests and by `DATABASE_URL=memory://`, which is genuinely useful for
 * a local run: a real Postgres engine with nothing to install.
 */
export async function createPgliteClient(dataDir?: string): Promise<SqlClient> {
  // Imported lazily so production never loads a ~3 MB WASM blob it will not use.
  let PGlite: typeof import('@electric-sql/pglite').PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    /**
     * PGlite is a *dev* dependency, so a production image built with
     * `npm prune --omit=dev` does not have it — correctly, because production
     * should be pointed at a real server. Say that, rather than letting a bare
     * "Cannot find package" stand as the explanation.
     */
    throw new Error(
      'DATABASE_URL uses pglite:// but @electric-sql/pglite is not installed. ' +
        'It is a dev dependency and is pruned from production images — use postgres:// instead.',
    );
  }

  // PGlite creates its data directory but not the parents of it, so a nested
  // path like `./.data/pg` fails on a fresh checkout. Make the whole path first.
  if (dataDir !== undefined) await mkdir(dataDir, { recursive: true });

  const db = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;

  const run = async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
    // `exec` handles multi-statement scripts (the schema); `query` handles
    // parameters. PGlite will not take both at once.
    if (params === undefined) {
      const results = await db.exec(sql);
      const last = results[results.length - 1];
      return (last?.rows ?? []) as T[];
    }
    const result = await db.query<T>(sql, [...params]);
    return result.rows;
  };

  const client: SqlClient = {
    query: run,
    async transaction(fn, opts) {
      await run('begin');
      try {
        await applySessionSettings(run, opts);
        const result = await fn(client);
        await run('commit');
        return result;
      } catch (error) {
        await run('rollback');
        throw error;
      }
    },
    async close() {
      await db.close();
    },
  };

  return client;
}

/** Wrap a `pg` pool. The production path. */
export async function createPgClient(connectionString: string): Promise<SqlClient> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString });

  const client: SqlClient = {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await pool.query(sql, params === undefined ? undefined : [...params]);
      return result.rows as T[];
    },
    async transaction(fn, opts) {
      const conn = await pool.connect();
      const run = async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        const result = await conn.query(sql, params === undefined ? undefined : [...params]);
        return result.rows as T[];
      };

      const scoped: SqlClient = { query: run, transaction: client.transaction, close: client.close };
      try {
        await run('begin');
        await applySessionSettings(run, opts);
        const result = await fn(scoped);
        await run('commit');
        return result;
      } catch (error) {
        await run('rollback');
        throw error;
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  return client;
}

/**
 * `SET LOCAL` the RLS inputs for this transaction.
 *
 * Parameterised via `set_config` rather than interpolated: `SET LOCAL` does not
 * take bind parameters, and building that string by hand would be the one place
 * in the adapter where a value reaches SQL unescaped.
 */
async function applySessionSettings(
  run: (sql: string, params?: readonly unknown[]) => Promise<unknown>,
  opts?: { actorId?: string | null; crossOwner?: boolean },
): Promise<void> {
  await run('select set_config($1, $2, true)', ['app.actor_id', opts?.actorId ?? '']);
  await run('select set_config($1, $2, true)', [
    'app.cross_owner',
    opts?.crossOwner === true ? 'on' : 'off',
  ]);
}
