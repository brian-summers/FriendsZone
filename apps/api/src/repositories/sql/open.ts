import type { Config } from '../../config.js';
import { applySchema, createPgClient, createPgliteClient, type SqlClient } from './client.js';
import { assertRestrictedRole, credentialsFrom, provisionRequestRole } from './roles.js';

/**
 * Connect the store `config` names, apply the schema, and return the client
 * requests will use - or `null` for `memory://`.
 *
 * With `DATABASE_APP_URL` this is two connections in sequence, never at once:
 * the owner migrates and provisions the request role and is closed before the
 * first request arrives, so no pooled connection serving traffic is the owner
 * (docs/adr/0033-restricted-request-role.md).
 */
export async function openDatabase(
  config: Pick<Config, 'DATABASE_URL' | 'DATABASE_APP_URL'>,
): Promise<SqlClient | null> {
  const url = config.DATABASE_URL;

  if (url.startsWith('pglite://')) {
    if (config.DATABASE_APP_URL !== undefined) {
      // PGlite is one in-process connection; there is no second login to make.
      throw new Error('DATABASE_APP_URL needs a postgres:// DATABASE_URL, not pglite://');
    }
    const db = await createPgliteClient(url.slice('pglite://'.length) || undefined);
    await applySchema(db);
    return db;
  }

  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) return null;

  if (config.DATABASE_APP_URL === undefined) {
    const db = await createPgClient(url);
    await applySchema(db);
    return db;
  }

  const credentials = credentialsFrom(config.DATABASE_APP_URL);
  if (credentials.user === decodeURIComponent(new URL(url).username)) {
    throw new Error('DATABASE_APP_URL names the schema owner; it must be a separate role (ADR 0033)');
  }
  const owner = await createPgClient(url);
  try {
    await applySchema(owner);
    await provisionRequestRole(owner, credentials);
  } finally {
    await owner.close();
  }

  const db = await createPgClient(config.DATABASE_APP_URL);
  try {
    await assertRestrictedRole(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
