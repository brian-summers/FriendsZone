# 0026. Raw SQL behind a two-method client, tested against real Postgres

**Status:** Accepted
**Date:** 2026-08-02
**Answers:** the question [ADR 0004](0004-persistence.md) deferred - *"Query
builder: Drizzle preferred over an ORM. Not yet decided - that is a separate ADR
when someone starts the work."* Someone has started the work.

## Context

ADR 0004 chose PostgreSQL with row-level security and left the access layer
open. Three things have changed since it was written, and each bears on the
choice:

1. The repository ports are already the abstraction. Twelve interfaces, sixty-odd
   methods, all returning domain types. Whatever sits underneath only has to
   turn rows into those types.
2. **Zod already owns the boundary.** Every entity is validated by a schema on
   the way in. An ORM's type mapping would be a second, weaker description of
   shapes that `packages/contracts` already defines exactly once - the thing
   [ADR 0003](0003-contracts-first.md) exists to prevent.
3. The projection path reads *whole entities* and hands them to a pure kernel. It
   never filters on a title or sorts by a description. The queries are simple;
   what is complicated is the authorization, and that lives somewhere else
   entirely.

## Decision

### Raw parameterised SQL, behind a two-method client

No ORM, no query builder. A `SqlClient` with `query` and `transaction`, and SQL
written out.

ADR 0004's own argument decides this: *"the projection path benefits from
queries a reviewer can read as SQL."* A query builder makes SQL that a reviewer
reads as TypeScript and then has to imagine as SQL. For queries this
straightforward, the builder is a dependency, a codegen step, and a translation
layer between a reviewer and the thing being reviewed.

Parameterised **always**. There is no string interpolation of values anywhere in
the adapter, and the one place identifiers are interpolated - table names in the
generic helpers - takes them from a closed set defined in the same file, never
from input.

### Relational where it matters, `jsonb` for the payload

Columns exist for exactly what is **queried, indexed, or enforced on**:

| Table | Real columns | Why |
|---|---|---|
| `events` | `owner_id`, `span tstzrange` | `eventsInWindow` is an overlap query |
| `friendships`, `blocks` | both user ids, canonically ordered | ADR 0004: "an orphaned friendship row is a potential authorization bug" |
| `circle_members` | `circle_id`, `user_id` | membership is a join, not a blob |
| `reports` | `reporter_id`, `subject_user_id`, `status` | the queue filters on all three |

Everything else travels in a `doc jsonb` column. This is not laziness: a
fully-normalised column per field would be a *third* description of every entity
(Zod schema, TypeScript type, DDL), and the two that already exist are generated
from one source. `jsonb` keeps that property, and the columns that do exist are
precisely the ones a reviewer needs to check an index or an RLS policy against.

It also keeps field-level encryption tractable - encrypting one `doc` is a
smaller change than encrypting eleven columns, and ADR 0004 already flags that
decision as one to make before, not after.

### RLS is a backstop, and cross-owner writes are explicit

Per ADR 0004: policies express **ownership only**, never the visibility lattice,
which stays in `packages/policy` where it is readable and tested. `app.actor_id`
is set with `SET LOCAL` inside a transaction - never per connection, because
pooled connections leak session state between requests.

ADR 0004 did not anticipate something that now exists: **sanctioned cross-owner
writes.** Accepting a hangout writes an event to *both* participants' calendars
([ADR 0010](0010-hangout-resolution.md)); so does booking a handoff
([ADR 0019](0019-the-handoff.md)). A naive `owner_id = current_setting('app.actor_id')`
policy would block exactly the writes the product is built around.

The resolution is to make the exception explicit rather than to weaken the
policy: a transaction that legitimately writes for another owner sets
`app.cross_owner = 'on'`, and the policy admits it. That turns "this code writes
to someone else's calendar" into a grep-able, reviewable act instead of an
implicit capability every query carries. The set of places that do it is small
and is the same set ADR 0010 already named.

**RLS is not the control.** A superuser bypasses it; a misconfigured role
bypasses it. It is the wall a handler bug hits, and the policy kernel is still
the thing that decides.

### Tested against real Postgres, in process

The suite runs against **PGlite** - Postgres 18 compiled to WebAssembly - so the
schema, the GiST index, the constraints, and the RLS policies are exercised by
the actual engine on every `npm test`, with no server to install.

Production uses `pg`. Both sit behind the same `SqlClient`, so the adapter under
test is the adapter that ships. Untested SQL is the failure mode this design is
most exposed to, and this closes it.

## Consequences

- Two runtime dependencies (`pg`, and `@electric-sql/pglite` as a dev
  dependency) where there were none. That is the price of a database and it was
  always going to be paid.
- Every port method now has a SQL and an in-memory implementation. The in-memory
  one stays: it is what 492 existing tests use, and it is faster than any
  database for the cases that are about behaviour rather than storage.
- Two implementations can drift. A shared conformance suite runs the same
  behavioural assertions against both, which is the only thing that keeps them
  honest.
- Migrations are plain `.sql` files applied in order, tracked in a table. No
  migration framework, for the same reason as no query builder.

## Alternatives considered

**Drizzle.** ADR 0004's stated preference, and a good tool. It buys typed query
construction that Zod-validated domain types already largely provide, at the
cost of a dependency, a codegen step, and SQL a reviewer reads at one remove.
Revisit if the queries stop being simple.

**Prisma or another full ORM.** ADR 0004 rejected an ORM already; a second
schema language describing entities that `packages/contracts` defines once is
the specific thing to avoid.

**A container-based Postgres for tests.** Truthful to production and needs Docker
running for `npm test`, which makes the test suite conditional on an
environment. PGlite is the same engine with none of that.

**Fully normalised columns for every field.** More conventional. It is a third
description of every entity, drifts from the Zod schemas silently, and buys
query flexibility this access pattern does not use.
