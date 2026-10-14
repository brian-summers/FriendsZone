import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { SqlClient } from './client.js';

/**
 * The login role request traffic uses, kept apart from the role that owns the
 * schema (docs/adr/0033-restricted-request-role.md).
 *
 * Row-level security binds neither a superuser nor a `BYPASSRLS` role, and the
 * Aurora master user is the second. While requests connected as the master,
 * every policy in schema.sql was tested and inert (ADR 0031). So the owner
 * applies the schema at boot, creates this role and grants it data access and
 * nothing else, and then the process serves requests as this role.
 */

/** A role name we are prepared to splice into DDL, which takes no parameters. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** What `scramVerifier` produces: base64, `$`, `:` and the mechanism name. */
const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

export interface RoleCredentials {
  readonly user: string;
  readonly password: string;
}

/** The user and password from a `postgres://` URL, validated for DDL. */
export function credentialsFrom(url: string): RoleCredentials {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!ROLE_NAME.test(user)) {
    throw new Error('DATABASE_APP_URL must name a lowercase role (letters, digits, underscore)');
  }
  if (password.length < 16) {
    throw new Error('DATABASE_APP_URL must carry a password of at least 16 characters');
  }
  return { user, password };
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form Postgres stores.
 *
 * Computed here so the plaintext never reaches the server. `ALTER ROLE ...
 * PASSWORD` takes no bind parameters, so whatever is sent is the literal text
 * of the statement, and statement logging is one parameter-group change away
 * from writing it to CloudWatch. A verifier in the log is not a credential.
 *
 * Postgres normalises passwords with SASLprep, which is the identity on
 * printable ASCII; outside that range this would compute a different key than
 * the server checks, so it refuses rather than producing a role nobody can log
 * in as.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('the request role password must be printable ASCII without spaces');
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Create the request role if it is missing, set its password, and grant it
 * exactly what the API does with data. Run by the schema owner, after
 * `applySchema`, on every boot - so a table added to the schema is granted on
 * the same boot that creates it.
 *
 * Deliberately absent: `CREATE` on the schema, ownership of anything, and every
 * role attribute but `LOGIN`. The role can read and write rows, and RLS
 * decides which.
 */
export async function provisionRequestRole(owner: SqlClient, credentials: RoleCredentials): Promise<void> {
  const { user, password } = credentials;
  if (!ROLE_NAME.test(user)) throw new Error('refusing to provision a role with an unsafe name');
  const verifier = scramVerifier(password);
  if (!VERIFIER.test(verifier)) throw new Error('unexpected verifier shape');
  const role = `"${user}"`;

  // Two instances booting together both find the role missing; the loser's
  // `create` raises `duplicate_object`, which is the outcome it wanted anyway.
  await owner.query(`
    do $$ begin
      create role ${role} with login nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
    exception when duplicate_object then null;
    end $$;
  `);
  // Only the password is restated on later boots. The Aurora master is not a
  // superuser, and since Postgres 16 a non-superuser may not even *name* the
  // SUPERUSER or REPLICATION attribute in `alter role`. So the attributes are
  // set once at creation and then *checked*, from the request connection
  // itself, by `assertRestrictedRole` - a role widened by hand stops the boot.
  await owner.query(`alter role ${role} with login password '${verifier}'`);
  await owner.query(`
    grant usage on schema public to ${role};
    grant select, insert, update, delete on all tables in schema public to ${role};
  `);
}

/**
 * Refuse to serve requests on a connection that row-level security would not
 * bind.
 *
 * The policies are a backstop only if the role they are checked against cannot
 * step around them. That is three properties of the role, and each one has been
 * the wrong default somewhere: a superuser bypasses RLS, `BYPASSRLS` bypasses
 * it (the Aurora master user has it, which is how production served requests
 * for months without the policies ever applying), and a table owner can `ALTER
 * TABLE ... DISABLE ROW LEVEL SECURITY`. A boot that fails here is a deploy
 * that never took traffic, which is the cheap place to learn it.
 */
export async function assertRestrictedRole(db: SqlClient): Promise<void> {
  const [role] = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(`
    select r.rolsuper, r.rolbypassrls,
           (select count(*)::int from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relowner = r.oid) as owned
      from pg_roles r
     where r.rolname = current_user
  `);
  if (role === undefined) throw new Error('could not read the connection role');
  const problems = [
    role.rolsuper ? 'is a superuser' : null,
    role.rolbypassrls ? 'has BYPASSRLS' : null,
    role.owned > 0 ? 'owns objects in the schema' : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to serve requests: the request role ${problems.join(', ')}, so row-level security would not bind it (ADR 0033)`,
    );
  }
}
