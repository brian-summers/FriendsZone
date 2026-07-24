# Authorization model

## Shape

Relationship-based (ReBAC). Permission is derived from the relationship between
the viewer and the *owner* of the resource — not from a role attached to the
user. There are no roles, and adding one should require an ADR: "admin" is how a
social product acquires an internal surface that can read every calendar.

A decision is a pure function of three things:

```
can(viewer: ViewerContext, request: PolicyRequest) → Decision
```

`ViewerContext` is the engine's entire input surface:

```ts
{
  viewerId: UserId | null            // null = anonymous, never a sentinel
  relationship: RelationshipKind     // to THIS owner
  sharedCircleIds: CircleId[]        // owner's circles the viewer is in
}
```

Keeping it this small is the point. The engine cannot look up a friendship,
cannot query a database, cannot be fooled by a stale cache it fetched itself.
Every decision is reproducible from its arguments, which is what makes the
security-critical code exhaustively testable.

## The two-stage pattern

Authorization happens twice, and conflating the stages is the most likely way to
introduce a leak here.

**Stage 1 — the coarse gate.** `can()` answers "may this actor attempt this
action at all?" It rejects categorically forbidden things: writing to someone
else's calendar, messaging a non-friend, claiming your own listing.

**Stage 2 — per-record filtering.** For reads, the visibility engine decides
what actually comes back, one record at a time.

For calendars, stage 1 rejects almost nothing on purpose. Everyone may *ask*;
the answer is filtered per event, and may legitimately be empty. That is why a
stranger receives `200 {busy: [], details: []}` rather than `403` — see the next
section.

## Denials do not distinguish themselves

`denialToResponse()` maps most reasons to **404, not 403**.

A 403 is an admission. "You may not view Alice's calendar" confirms Alice
exists, confirms the id is hers, and — if the status varies by reason — reveals
whether you are blocked or merely not a friend. Chained across a handle list,
that turns the API into a social-graph oracle.

| Reason | Status | Rationale |
|---|---|---|
| `ANONYMOUS` | 401 | Telling an unauthenticated caller to log in reveals nothing they could not learn by logging in. |
| `WRONG_STATE` | 409 | Only reachable after an identity check passed, so the caller demonstrably knows the resource exists. |
| `BLOCKED`, `NOT_FRIENDS`, `NOT_OWNER`, `NOT_PARTICIPANT`, `NO_MATCHING_AUDIENCE` | 404 | Indistinguishable from "no such thing". |

`DenyReason` codes exist for **operators**, not callers. They are structured so
they can be counted and alerted on without smuggling a username, an event title,
or a location into a log aggregator.

## The block exemption

`calendar:view` is exempt from the blanket block check. This is the one place
the model bends, and it bends to close a leak rather than to open one.

If `calendar:view` were denied for a blocked viewer, they would get a 404 where
a stranger gets an empty 200. That difference *is* the disclosure: it tells them
they have been blocked, which the blocker did not choose to share, and it is
precisely the signal that prompts someone to escalate to a second account.

The exemption is only safe because `resolveEventVisibility` returns `HIDDEN` for
a blocked viewer *before consulting any rule*, so the projection is empty
regardless. Those two facts are load-bearing together, and three tests pin them:

- `visibility.test.ts` → hides everything from a blocked viewer, including a
  `PUBLIC` event and including one they attend
- `projection.test.ts` → blocked viewer receives byte-identical output to a
  stranger
- `server.test.ts` → same status code and same body over HTTP

**Do not add to `BLOCK_EXEMPT_ACTIONS` without an equivalent guarantee that the
response carries no data.**

## How the perimeter is held

Structural, not procedural. Conventions decay; these do not:

1. **`authz` is a required field** on `RouteDefinition`. A route that forgot
   access control does not compile.
2. **Public routes cost a written justification.** `routes.test.ts` enforces a
   length floor, so "n/a" fails.
3. **The public surface is an allowlist.** Adding a public endpoint means
   editing an assertion, which means a reviewer sees it.
4. **`can()` is exhaustive.** `assertNever` in the default branch means a new
   action breaks the build until it is handled.
5. **Every action must be exercised.** `actions.test.ts` compares tested actions
   against `ALL_ACTIONS`; an untested capability fails CI.
6. **Ids are branded.** A `ListingId` will not type-check where a `UserId` is
   expected, killing a whole class of "wrong id in the permission check" bugs.

## Defence in depth: row-level security

Not yet implemented; required before production. When Postgres lands, ownership
predicates should be enforced by RLS policies *in addition to* the policy
engine. The engine is the primary control and RLS is the backstop — a bug in a
handler should hit a wall in the database, not a data leak. See
[ADR 0004](../adr/0004-persistence.md).

## Adding a new action

1. Add the member to `Action` and to `ACTION_REGISTRY` (the compiler demands the
   second once you do the first).
2. Add a `PolicyRequest` variant taking a `Pick<>` of *only* the fields the
   decision needs. The signature should document what is security-relevant.
3. Handle the case in `can()`. Start from deny and add affirmative grants.
4. Test the allow path and **every** deny path. The `ALL_ACTIONS` backstop
   catches a missing test, not a shallow one.
5. If it is a read, decide whether it needs stage-2 filtering too.
6. Update [the threat model](threat-model.md) if it opens a new surface.
