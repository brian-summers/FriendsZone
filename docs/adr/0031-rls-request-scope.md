# 0031. RLS sees the actor through a request scope; reads are open, writes are owned

**Status:** Accepted
**Date:** 2026-10-13
**Amends:** [ADR 0026](0026-sql-layer.md), which designed the policies and the
`SET LOCAL` mechanism but never connected the two

## Context

ADR 0026 put row-level security on the five owned tables (`events`,
`sharing_defaults`, `quiet_hours`, `circles`, `listings`), keyed on
`app.actor_id`, which the SQL client was to set with `SET LOCAL` inside a
transaction. The client had a `transaction(fn, { actorId })` method for it.

**Nothing ever called it.** No port takes an actor, so the adapter had no actor
to pass, and every statement ran with `app.actor_id` unset. `app_actor_id()`
was therefore `NULL` on every query, and every policy evaluated to false.

Nobody noticed because nothing that ran the SQL could. The route suites run on
the in-memory adapter. The adapter's own conformance suite runs on PGlite as
its default role, which is a superuser, and a superuser bypasses RLS. The two
RLS tests that did run as a restricted role issued raw SQL with the setting
applied by hand, so they proved the *policies* and not the *adapter*.

In a role the policies bind, the consequence is total. Running the real
adapter as a non-superuser, `NOBYPASSRLS` role that owns the schema - the
posture the design assumes - every write to an owned table is refused (`new
row violates row-level security policy for table "events"`) and every read of
one returns nothing, because the policies were `for all` and so governed
`select` too. A calendar would be empty even to its owner.

**Production did not fail, which is its own finding.** A smoke test against the
live deployment on 2026-10-13, run before this change shipped, created an
event, read it from a friend's account, and booked a hangout onto both
calendars - all with `app.actor_id` unset and `FORCE ROW LEVEL SECURITY` on.
A Logs Insights query over the 70 days of application logs (1,140,836 lines)
finds no row-level security error. Its only logged error is a health check on
2026-08-10 that could not resolve the database hostname. So the production
connection, the Aurora master user, is not
bound by these policies; it bypasses RLS. That was not verified from inside
the database, but nothing else explains a write that the policies refuse
everywhere they apply. **In production, RLS has never been a backstop.** It
was decorative, which is the failure ADR 0026 warned about in its own words:
"a misconfigured role bypasses it".

The deploy's smoke test registered an account (the `users` table has no RLS)
and stopped there, so it could not have told either story.

Wiring the actor through is necessary but not sufficient. The read policies
were ownership-only too, and the product reads across owners constantly: a
friend's calendar view needs the owner's events, sharing defaults and quiet
hours, and the circle-membership lookup in `viewerFor` joins the owner's
circles. Wiring the actor alone would have replaced "everything is empty" with
"everything except your own week is empty" for any role the policies bind.

## Decision

### The actor travels in a request scope

`apps/api/src/repositories/scope.ts` holds an `AsyncLocalStorage`. The server
runs each handler inside `runAsActor(actorId, ...)`, after authentication. The
SQL client reads the scope on every `query`: inside one, it runs the statement
in its own transaction with `app.actor_id` and `app.cross_owner` applied by
`set_config(..., true)`. Outside one (boot, the schema) there is no actor and
the statement runs bare, so any write to an owned table is refused - fail
closed.

`SET LOCAL` exists only inside a transaction, which is why every scoped
statement gets one. That is three extra round trips per statement inside the
VPC, and it keeps the property ADR 0026 asked for: no pooled connection ever
carries one request's identity into the next. PGlite uses its own
`transaction()` so the engine lock covers the whole statement and two requests
in flight cannot interleave inside each other's transaction.

### Reads are open; writes are owned

Each owned table now has two policies. `<table>_read` is `for select using
(true)`; `<table>_write` is `for all` with the ownership check. That is the
shape `listings` already had, and it is what ADR 0004 meant by "RLS expresses
ownership only": who may *see* a row is the visibility lattice, and a read
policy that tried to say it here would be a second, drifting implementation of
the security model.

**Circles are the exception.** Non-negotiable 9 is about the row itself, and
the only cross-owner read the product makes of a circle is the membership join.
So `circles_read` admits the owner and the circle's members, and nobody else.

### Cross-owner writes are named at the call site

`asCrossOwner(fn)` runs `fn` with `app.cross_owner = 'on'`. It refuses to run
without an authenticated scope. `grep asCrossOwner` is the complete list, and
today it is:

| Where | Why |
|---|---|
| Accepting a hangout, booking a floating occurrence | One copy on each calendar ([0010](0010-hangout-resolution.md), [0013](0013-floating-and-open-to-conflict.md)) |
| Editing, moving, cancelling a confirmed hangout | Mirrored onto the other party's copy ([0012](0012-hangout-lifecycle.md)) |
| Accepting and cancelling a handoff | Booked onto, then removed from, both calendars ([0019](0019-the-handoff.md)) |
| A first-come claim; completing a handoff | Moves the *owner's* listing to `CLAIMED` / `EXCHANGED` |
| A moderator's takedown | Withdraws someone else's listing ([0018](0018-reporting-and-moderation.md)) |
| Deleting an account | Other people's copies of a shared plan stop naming the person who left ([0022](0022-export-and-deletion.md)) |

The last one was not on ADR 0026's list. Under a role RLS binds, it would
have thrown halfway through an account deletion, after listings, exchanges and
hangouts were already gone.

`events` and `listings` honour the flag. `sharing_defaults`, `quiet_hours` and
`circles` do not, because the product has no cross-owner write to them.

### The memory adapter enforces the same write rule

`assertMayWrite(ownerId, table)` mirrors the write policies inside a request
scope, so the route suites, which run on the memory adapter, fail on a handler
that forgot `asCrossOwner`. Adding the check before the wraps broke exactly 22
route tests, every one of them a path in the table above. Outside a scope it
permits everything, because the seed and the conformance suite are not
requests.

### A suite runs the whole API as a role RLS binds

`rls-binding.test.ts` builds PGlite with a non-superuser,
`NOBYPASSRLS` role that owns the schema, and walks the main flows over HTTP
with real sessions: events, a friend's view, sharing defaults, quiet hours,
circles, the hangout lifecycle, a claim through a completed handoff, and
account deletion. With the scope disabled, 9 of its 11 tests fail.

### The connection role is unchanged, for now - so production is not yet protected

The API still connects as the master user, which bypasses RLS. **Until that
changes, everything above is correct, tested, and inert in production.** The
policies bind the posture suite and would bind any role without `BYPASSRLS`;
they do not bind the connection production actually uses.

The fix is a login role that owns nothing and cannot bypass RLS, used for
request traffic only. The API applies the schema on boot, and DDL needs the
owner, so this means separating migration from request handling - most simply,
an owner credential used once at boot and a restricted one for the pool. IAM
database authentication is already enabled on the cluster and suits the
restricted role, since it needs no stored password. That change touches the
database's roles and the service's IAM policy, so it is recorded in [the road
to GA](../product/road-to-ga.md) rather than folded into this one. This ADR is
what makes it safe: before it, moving to a role RLS binds would have emptied
every calendar.

## Consequences

- The application sets the actor on every statement, so the policies mean what
  they say for any role they bind. Moving production to such a role is now a
  configuration change rather than an outage.
- RLS is a backstop for **writes** wherever it binds: a handler that writes
  another person's row without saying so is refused by the database even if
  the kernel was skipped. In production it binds nothing until the connection
  role changes.
- RLS is deliberately **not** a backstop for reads, except on circles. That
  matches ADR 0004's intent; it is stated here because the previous policies
  looked as though they were one.
- Every scoped statement costs a transaction - three extra round trips inside
  the VPC. Paid in production today for a backstop that does not yet bind
  there; that is the price of the restricted role being a switch rather than a
  migration.
- A test can no longer pass on PGlite's superuser and fail under a role RLS
  binds without `rls-binding.test.ts` failing too.
- The deploy playbook's smoke test now writes, across two accounts, and is a
  script rather than a checklist.

## Alternatives considered

**Pass `actorId` through every port.** Rejected: it puts an authorization input
on every call site across twelve interfaces, and invites a repository to start
*deciding* things with it.

**One transaction per request.** Cheaper in round trips, and it would make
multi-write handlers atomic, which they currently are not. Rejected *for this
change* because it alters the failure semantics of every route at once and
holds a connection for a handler's whole duration. Worth its own ADR.

**`cross_owner` for reads too.** Rejected: if every read is a cross-owner act,
the flag stops meaning anything, and the grep stops being the list.

**Keep a `BYPASSRLS` connection and call it done.** Rejected: it makes the
policies decorative, which is what production has had all along.
