# 0033. Requests run as a restricted login role; the owner only migrates

**Status:** Accepted
**Date:** 2026-10-14
**Amends:** [ADR 0031](0031-rls-request-scope.md), which wired the actor into
every statement but left production connecting as a role RLS does not bind

## Context

ADR 0031 made the row-level security policies mean what they say, for any role
they bind. Production's connection was not one: the API connected as the Aurora
master user, which has `BYPASSRLS`, so the policies were tested and inert. ADR
0031 named the fix and deferred it: request traffic needs a login role that
owns nothing and cannot bypass RLS.

Two things make that more than a configuration change.

**The API migrates itself.** `applySchema` runs on every boot, and DDL needs
the owner. So the owner credential cannot simply be swapped for a restricted
one; the process needs both, in sequence.

**App Runner has no route out of the VPC.** The service's egress is the VPC
connector, the VPC has no NAT by design ([ADR 0027](0027-deploy-on-aws.md)),
and the only security-group rule out of the connector is to Aurora. Whatever
authenticates the new role must work without calling an AWS API at runtime.

## Decision

### Two URLs, one boot sequence

`DATABASE_URL` keeps its meaning: the schema owner. A new `DATABASE_APP_URL`
names the request role. With both set, boot (`repositories/sql/open.ts`):

1. connects as the owner, applies the schema, and provisions the request role
   (`repositories/sql/roles.ts`): creates it if missing, sets its password,
   and grants `usage` on the schema and `select, insert, update, delete` on
   every table - nothing else;
2. closes the owner connection;
3. connects as the request role and checks it: not a superuser, no
   `BYPASSRLS`, owns nothing in the schema. Any of those stops the boot;
4. serves requests on that connection only.

No pooled connection that serves a request is the owner. The grants run on
every boot, after the schema, so a table added to `schema.sql` is granted on
the same boot that creates it.

**`DATABASE_URL` is not renamed** so that rollback still works. An image from
before this change ignores `DATABASE_APP_URL` and connects as the owner, as it
always did. Renaming the owner variable would have made the previous image boot
as the request role, fail to apply the schema, and turn a rollback into an
outage.

**Production refuses to start without `DATABASE_APP_URL`** when the store is
Postgres, which matches how `config.ts` treats the other controls: one that can
be left off in production eventually is.

### A password, verified client-side, rather than IAM authentication

The cluster has IAM database authentication enabled, and ADR 0031 suggested it
for this role. It is not used, for one verifiable reason and one weaker one:

- A token is signed locally, but signing needs the instance role's
  credentials. Whether App Runner supplies them to a service whose egress is a
  VPC with no NAT could not be confirmed without deploying, and the failure
  would take production down. Secret injection is the path this service
  already depends on.
- The owner credential stays in the process either way, because the process
  migrates. IAM auth would remove a stored password for the *weaker* of the two
  roles, while the stronger one stays a stored password.

The password is a generated secret (`AppDatabasePassword`), composed into
`DATABASE_APP_URL` the same way `DATABASE_URL` is composed from the cluster
secret, and injected by App Runner. The API sets the role's password on every
boot, so rotating it is: update the secret, redeploy. That needs no rotation
Lambda, which this VPC cannot reach anyway.

`ALTER ROLE ... PASSWORD` takes no bind parameters, so whatever is sent is the
literal text of a statement, and statement logging is one parameter-group
change from writing it to CloudWatch. The API therefore computes the
SCRAM-SHA-256 verifier itself and sends that. A verifier in a log is not a
credential.

### Attributes are set once and checked on every boot

The Aurora master is not a superuser, and since Postgres 16 a non-superuser may
not even *name* `SUPERUSER` or `REPLICATION` in `ALTER ROLE`. So the attributes
are written once, in `CREATE ROLE`, and every later boot sets only the password.
What keeps the role narrow is the boot check, run *as* the role: widen it by
hand and the next boot refuses to serve.

## Consequences

- Row-level security binds production's request traffic once this ships. A
  handler that writes another person's row without `asCrossOwner` is refused by
  the database, not only by the memory adapter in tests.
- The request role cannot change the schema or turn RLS off, so a SQL injection
  can no longer do either; it is left with what the role's grants and the
  policies allow.
- The owner credential is still in the process environment, and the owner
  connection exists for the length of a boot. Separating migration into its own
  job would remove both. App Runner has no pre-deploy hook, so that waits for
  the move off App Runner ([road to GA](../product/road-to-ga.md)).
- The request role has `DELETE` on every table, including ones the product
  never deletes from (`blocks` is the one that matters). Per-table grants would
  tighten that; they are not done here, because a grant list that drifts from
  the code fails as an outage, and the coverage for it is the suite below.
- `rls-binding.test.ts` now builds exactly this posture: the owner migrates
  and provisions, and the whole API runs as the provisioned role. A missing
  grant fails it (narrowing the grant to `select` turns registration into a
  500). `roles.test.ts` covers the role's attributes, its inability to alter
  the schema, and the boot check against a superuser, a `BYPASSRLS` role and a
  schema owner.
- Verified against Postgres 17 with an owner configured like Aurora's master
  (non-superuser, `CREATEROLE`, `BYPASSRLS`): an existing schema created by the
  old boot, then two boots of the new one, each followed by the scripted smoke
  test. Both passed, and both refusals fired.

## Alternatives considered

**`SET LOCAL ROLE` inside each scoped transaction, on the owner's connection.**
No new secret and no CDK change. Rejected: the session can `RESET ROLE`, so it
binds application bugs but not an injection, and the boot check could not
honestly say the connection is restricted.

**IAM database authentication for the request role.** Rejected for now, for
the reasons above. Worth revisiting once the service has a route to STS, or
once migration is a separate job and the process holds no stored password at
all.

**Rename `DATABASE_URL` to the request role and add `DATABASE_OWNER_URL`.**
Clearer names. Rejected because it breaks rollback to every earlier image.

**A one-off migration step outside the API.** The right shape, and the one this
should end at. App Runner offers no hook to run it before a deploy, so it would
be a manual step in the playbook, which is where steps get skipped.
