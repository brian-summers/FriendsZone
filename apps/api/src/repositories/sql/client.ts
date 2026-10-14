import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentScope } from '../scope.js';

/**
 * The whole database interface: two methods.
 *
 * Small on purpose. `pg` runs it in production and PGlite - real Postgres,
 * compiled to WebAssembly - runs it in tests, so **the adapter under test is
 * the adapter that ships**. Untested SQL is the failure mode this design is
 * most exposed to, and one interface closes it
 * (docs/adr/0026-sql-layer.md).
 */
export interface SqlClient {
  /**
   * Run one statement. Inside a request scope (`../scope.ts`) the actor is
   * applied to it, so RLS sees who is writing without any port having to
   * carry an actor (ADR 0031).
   */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * `actorId` becomes `app.actor_id` via `SET LOCAL`, which is scoped to the
   * transaction - never to the connection, because a pooled connection would
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
 * Idempotent - every statement is `if not exists` or `create or replace` - so
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
     * `npm prune --omit=dev` does not have it - correctly, because production
     * should be pointed at a real server. Say that, rather than letting a bare
     * "Cannot find package" stand as the explanation.
     */
    throw new Error(
      'DATABASE_URL uses pglite:// but @electric-sql/pglite is not installed. ' +
        'It is a dev dependency and is pruned from production images - use postgres:// instead.',
    );
  }

  // PGlite creates its data directory but not the parents of it, so a nested
  // path like `./.data/pg` fails on a fresh checkout. Make the whole path first.
  if (dataDir !== undefined) await mkdir(dataDir, { recursive: true });

  const db = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;

  type Runner = Pick<typeof db, 'query' | 'exec'>;
  const runOn =
    (target: Runner) =>
    async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
      // `exec` handles multi-statement scripts (the schema); `query` handles
      // parameters. PGlite will not take both at once.
      if (params === undefined) {
        const results = await target.exec(sql);
        const last = results[results.length - 1];
        return (last?.rows ?? []) as T[];
      }
      const result = await target.query<T>(sql, [...params]);
      return result.rows;
    };
  const run = runOn(db);

  /**
   * PGlite's own `transaction` rather than a hand-issued `begin`: it holds the
   * engine's lock for the whole callback, so two requests in flight cannot
   * interleave their statements inside one another's transaction - which on a
   * single connection is otherwise exactly what `Promise.all` would do.
   */
  const inTransaction = <T>(
    opts: SessionSettings | undefined,
    fn: (tx: SqlClient) => Promise<T>,
  ): Promise<T> =>
    db.transaction(async (tx) => {
      const txRun = runOn(tx);
      await applySessionSettings(txRun, opts);
      return fn({
        query: txRun,
        transaction: () => Promise.reject(new Error('nested transactions are not supported')),
        close: () => Promise.resolve(),
      });
    });

  const client: SqlClient = {
    query: (sql, params) => {
      const scope = currentScope();
      return scope === undefined ? run(sql, params) : inTransaction(scope, (tx) => tx.query(sql, params));
    },
    transaction: (fn, opts) => inTransaction(opts, fn),
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

  const inTransaction = async <T>(
    opts: SessionSettings | undefined,
    fn: (tx: SqlClient) => Promise<T>,
  ): Promise<T> => {
    const conn = await pool.connect();
    const run = async <R>(sql: string, params?: readonly unknown[]): Promise<R[]> => {
      const result = await conn.query(sql, params === undefined ? undefined : [...params]);
      return result.rows as R[];
    };
    const scoped: SqlClient = {
      query: run,
      transaction: () => Promise.reject(new Error('nested transactions are not supported')),
      close: () => Promise.resolve(),
    };

    let broken: Error | undefined;
    try {
      await run('begin');
      await applySessionSettings(run, opts);
      const result = await fn(scoped);
      await run('commit');
      return result;
    } catch (error) {
      try {
        await run('rollback');
      } catch (rollbackError) {
        // A connection that cannot roll back is in an unknown state. Destroy it
        // rather than return it to the pool, where the next request would
        // inherit whatever it was in the middle of.
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      conn.release(broken);
    }
  };

  const client: SqlClient = {
    /**
     * Inside a request scope, every statement runs in its own transaction with
     * the actor applied - `SET LOCAL` only exists inside one. That is three
     * extra round trips per statement, inside the VPC, and buys the property
     * that matters: no pooled connection ever carries one request's identity
     * into the next. Outside a scope (boot, the schema) there is no actor to
     * apply, so the statement runs bare and RLS sees nobody.
     */
    async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const scope = currentScope();
      if (scope !== undefined) return inTransaction(scope, (tx) => tx.query<T>(sql, params));
      const result = await pool.query(sql, params === undefined ? undefined : [...params]);
      return result.rows as T[];
    },
    transaction: (fn, opts) => inTransaction(opts, fn),
    async close() {
      await pool.end();
    },
  };

  return client;
}

interface SessionSettings {
  actorId?: string | null;
  crossOwner?: boolean;
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
  opts?: SessionSettings,
): Promise<void> {
  // One statement for both, to keep the per-statement overhead to one trip.
  await run('select set_config($1, $2, true), set_config($3, $4, true)', [
    'app.actor_id',
    opts?.actorId ?? '',
    'app.cross_owner',
    opts?.crossOwner === true ? 'on' : 'off',
  ]);
}
