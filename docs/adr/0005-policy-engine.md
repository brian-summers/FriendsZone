# 0005. Authorization as a pure security kernel

**Status:** Accepted
**Date:** 2026-07-20

## Context

Authorization in a typical application is scattered: a middleware check, an `if`
in a controller, a `WHERE user_id = ?` in a query, a conditional in a template.
Each is individually reasonable. Together they are unreviewable - nobody can
answer "who can see Alice's calendar?" without reading the whole codebase, and
the answer changes every time anyone adds an endpoint.

Friendszone's central feature is a privacy model with real consequences for real
people. It needs to be auditable in one sitting.

## Decision

All authorization lives in `packages/policy`, which is a **pure kernel**:

1. **No I/O.** No database, no network, no clock, no environment. Callers
   assemble a `ViewerContext` from trusted sources and pass it in.
2. **No dependencies** beyond `@friendszone/contracts`.
3. **Default deny.** Every branch that grants access is affirmative. There is no
   fallback that returns allow.
4. **Total functions.** Every `switch` ends in `assertNever`, so a new union
   member breaks the build.

Two entry points:

- `can(viewer, request)` - the coarse gate. "May this actor attempt this?"
- `resolveEventVisibility` / `projectCalendar` - per-record filtering. "What
  does this specific viewer actually get?"

The purity is not aesthetic. Because the engine performs no I/O, an attacker
cannot influence a decision by poisoning something the engine fetched on its
own. Every input is explicit, so every decision is reproducible from its
arguments - which is why the security-critical code is also the most thoroughly
tested code in the repo, at ~55 focused unit tests with no mocks anywhere.

## Consequences

- Callers must assemble context before asking, and must rebuild it per resource
  owner. `ctx.viewerFor(ownerId)` makes that the path of least resistance.
- Potential N+1 on the relationship lookup when projecting many owners. Solvable
  with a batch load in the adapter; the engine is unaffected either way.
- A reviewer can read the entire security model in one file tree, without a
  database or a running server.
- The two-stage split (`can` then project) must be understood, or someone will
  eventually use the coarse gate alone for a read and leak everything.
  Documented in [the authorization model](../security/authz-model.md) and
  called out in the review checklist.

## Alternatives considered

**Middleware-only authorization.** Cannot express per-record visibility, which
is the entire product. Would have forced "friend sees everything" - the exact
model Friendszone exists to avoid.

**Database row-level security as the primary control.** Postgres RLS cannot
express a four-level lattice with per-event ceilings without unreadable SQL, and
policy bugs would only be discoverable against a live database. RLS is planned
as *defence in depth* instead - see [ADR 0004](0004-persistence.md).

**An external policy engine (OPA, Cedar).** Genuinely good for multi-service
deployments. Here it adds a second language, a deployment dependency, and a
network hop to every check, in exchange for flexibility a single service does
not need. Revisit if Friendszone becomes several services.
