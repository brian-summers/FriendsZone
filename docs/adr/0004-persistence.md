# 0004. PostgreSQL with row-level security

**Status:** Proposed
**Date:** 2026-07-20

## Context

The foundation pass ships in-memory adapters so the architecture can be
exercised end to end before a database exists. That was the right call for a
first pass, but it is not a persistence strategy, and the choice of store
constrains what the security model can rely on.

Requirements the store must meet:

- Range queries over time intervals (`eventsInWindow` is the hot path).
- Relational integrity for the social graph — an orphaned friendship row is a
  potential authorization bug.
- Transactions across entities: accepting a hangout request creates events for
  several people, and a partial commit produces a phantom plan.
- Somewhere to put a defence-in-depth ownership check.

## Decision

**PostgreSQL**, accessed through the existing `SocialGraphPort` and
`CalendarPort` interfaces. Swapping the adapter should change one line in
`server.ts` and no route or policy code.

Specifics for whoever implements this:

1. **Row-level security as a backstop, not the primary control.** The policy
   engine stays authoritative; RLS exists so that a bug in a handler hits a wall
   in the database rather than leaking. Policies should enforce ownership only
   (`owner_id = current_setting('app.actor_id')`) — do **not** try to express
   the visibility lattice in SQL. That belongs in
   [`packages/policy`](../../packages/policy/), where it is readable and tested.
2. **`app.actor_id` set per transaction**, never per connection. Pooled
   connections leak session state between requests.
3. **GiST index on the event time range** (`tstzrange`), because
   `eventsInWindow` is the hot path and it is an overlap query.
4. **Half-open ranges** (`[start, end)`) to match `TimeRange` semantics exactly.
   A closed range would make back-to-back events overlap.
5. **Blocks are never hard-deleted** on account deletion — retain a one-way hash
   of the pair. See
   [data classification](../security/data-classification.md#retention) for the
   tension this resolves.
6. **Field-level encryption** for event titles, descriptions, and locations
   (🟠 Sensitive). Note this is incompatible with naive server-side search over
   those fields; decide search strategy before encrypting, not after.

Query builder: Drizzle preferred over an ORM, on the grounds that the projection
path benefits from queries a reviewer can read as SQL. Not yet decided — that is
a separate ADR when someone starts the work.

## Consequences

- Operational cost: a database to run, migrate, and back up.
- RLS adds a second place ownership is expressed. That is the point, but the two
  must not disagree, so any RLS policy needs a test asserting it matches the
  engine.
- Field-level encryption forecloses some future search designs. Decide first.
- The in-memory adapter stays for tests. It already implements real semantics
  (bidirectional blocks, conservative defaults) rather than returning `true`, so
  tests written against it remain meaningful.

## Alternatives considered

**SQLite.** Fine for single-node, and genuinely tempting for early development.
No RLS, weaker range-query support, and migrating later is exactly the kind of
work that never gets scheduled.

**A document store.** The social graph is relational; modelling friendships and
circles in documents means either duplication or application-side joins, and
both are where authorization bugs breed.

**Keep the in-memory adapter and add snapshots.** Data loss on restart, no
transactions, no concurrent access. Not a serious option beyond development.
