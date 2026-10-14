import { afterEach, describe, expect, it } from 'vitest';
import { applySchema, createPgliteClient, type SqlClient } from './client.js';
import { assertRestrictedRole, credentialsFrom, provisionRequestRole, scramVerifier } from './roles.js';

const credentials = { user: 'friendszone_app', password: 'p'.repeat(24) };

describe('the request role (ADR 0033)', () => {
  let db: SqlClient | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  /** PGlite's default role is a superuser, standing in for the schema owner. */
  async function provisioned(): Promise<SqlClient> {
    db = await createPgliteClient();
    await applySchema(db);
    await provisionRequestRole(db, credentials);
    return db;
  }

  it('is created without any attribute that would let it step around RLS', async () => {
    const owner = await provisioned();
    const [role] = await owner.query<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
         from pg_roles where rolname = 'friendszone_app'`,
    );
    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
    });
  });

  it('can be provisioned on every boot', async () => {
    const owner = await provisioned();
    await expect(provisionRequestRole(owner, credentials)).resolves.toBeUndefined();
  });

  it('passes the boot check, and reads through its grant', async () => {
    const owner = await provisioned();
    await owner.query('set role friendszone_app');
    await expect(assertRestrictedRole(owner)).resolves.toBeUndefined();
    // `users` has no RLS, so this is the grant alone.
    await expect(owner.query('select count(*) from users')).resolves.toHaveLength(1);
  });

  it('cannot change the schema or turn RLS off', async () => {
    const owner = await provisioned();
    await owner.query('set role friendszone_app');
    await expect(owner.query('create table smuggled (id int)')).rejects.toThrow(/permission denied/);
    await expect(owner.query('alter table events disable row level security')).rejects.toThrow(
      /must be owner/,
    );
    await expect(owner.query('drop table events')).rejects.toThrow(/must be owner/);
  });

  it('refuses a superuser at boot', async () => {
    db = await createPgliteClient();
    await expect(assertRestrictedRole(db)).rejects.toThrow(/is a superuser/);
  });

  it('refuses a BYPASSRLS role at boot', async () => {
    const owner = await provisioned();
    await owner.query('create role bypasser bypassrls');
    await owner.query('set role bypasser');
    await expect(assertRestrictedRole(owner)).rejects.toThrow(/has BYPASSRLS/);
  });

  it('refuses a role that owns the schema at boot, even one RLS binds', async () => {
    db = await createPgliteClient();
    await db.query('create role schema_owner nosuperuser nobypassrls');
    await db.query('grant create, usage on schema public to schema_owner');
    await db.query('set role schema_owner');
    await applySchema(db);
    await expect(assertRestrictedRole(db)).rejects.toThrow(/owns objects in the schema/);
  });
});

describe('scramVerifier', () => {
  it('has the shape Postgres stores, and salts every call', () => {
    const a = scramVerifier('correct-horse-battery');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(scramVerifier('correct-horse-battery')).not.toBe(a);
  });

  it('is deterministic for a given salt', () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramVerifier('correct-horse-battery', salt)).toBe(scramVerifier('correct-horse-battery', salt));
  });

  it('refuses a password SASLprep would change', () => {
    expect(() => scramVerifier('pässword-pässword')).toThrow(/printable ASCII/);
    expect(() => scramVerifier('has a space in it')).toThrow(/printable ASCII/);
  });
});

describe('credentialsFrom', () => {
  it('reads the user and password', () => {
    expect(credentialsFrom(`postgresql://friendszone_app:${'a'.repeat(32)}@db:5432/friendszone`)).toEqual({
      user: 'friendszone_app',
      password: 'a'.repeat(32),
    });
  });

  it('refuses a role name it would have to quote', () => {
    expect(() => credentialsFrom(`postgres://App%22Role:${'a'.repeat(32)}@db/x`)).toThrow(/lowercase role/);
  });

  it('refuses a short password', () => {
    expect(() => credentialsFrom('postgres://friendszone_app:short@db/x')).toThrow(/16 characters/);
  });
});
