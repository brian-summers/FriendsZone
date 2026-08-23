# 0010. Hangout requests resolve 1:1, and acceptance books both calendars

**Status:** Accepted
**Date:** 2026-07-22

## Context

The hangout request is the product's reason to exist: propose a few times, get
an answer whenever, no pressure to reach someone now. The domain model
(`HangoutRequest`) has been in `@friendszone/contracts` since the first pass, with
an `inviteeIds` *array* and a per-slot preference model built for group
scheduling. Turning that into a working feature forced two decisions the model
left open: who resolves a request, and what "accepted" does.

## Decision

**1:1 for now.** The create endpoint takes a single `inviteeId`, not a list. The
stored request still uses `inviteeIds: [one]`, so the model is untouched and
groups remain a forward-compatible extension - but the *input type* expresses
the constraint honestly rather than accepting a list and half-supporting it.

Group requests are deferred because they need a genuinely different flow: the
proposer collects everyone's per-slot availability, *then* confirms a winning
time (the sequence diagram in [overview.md](../architecture/overview.md)). That
is a proposer-confirms model. The 1:1 case is simpler and more immediate, and
shipping it well beats shipping an ambiguous group version.

**The invitee resolves it.** For a 1:1 request, the single invitee either
accepts a slot or declines - there is no second round-trip waiting on the
proposer to confirm. This maps exactly onto the existing `hangout:respond` policy
gate (invitee, pending), so no new authorization action was needed. The proposer
can still `hangout:withdraw` while it is pending.

**Accepting books both calendars.** On accept, the server creates a
`CalendarEvent` for the proposer *and* the invitee, each owning their own copy,
with both as attendees (so each sees the other's copy at `FULL`). This is the
one place in the product that performs a cross-owner write.

**Expiry is lazy.** A pending request past `expiresAt` is settled to `EXPIRED`
the next time anyone reads or touches it (`isHangoutExpired` + `settleExpiry`),
and the new status is persisted. No scheduler runs.

## Consequences

- The cross-owner write needs a clear justification, because it appears to
  violate the rule that a writer owns only their own calendar. It does not: the
  owner ids come from the *stored request's participants* - server-side trusted
  state - never from the request body, and the write is authorized by the
  semantics of accepting an invitation, not by the accepter's (nonexistent)
  rights over the proposer's calendar. This is the sanctioned exception the
  policy comments always anticipated ("invitations create events owned by each
  invitee on acceptance"). It is the *only* such exception, and
  `hangouts.test.ts` pins that both copies appear and that non-participants are
  refused.
- Lazy expiry means the effective status is correct on read without a job, and
  the same `isHangoutExpired` predicate answers for the store and for tests. The
  cost is that a request only *becomes* EXPIRED when observed - fine, because
  nobody acts on an unobserved request.
- `resultingEventId` is singular but there are two event copies; it points at
  the accepter's own copy. A minor imprecision the two-copy model creates;
  documented rather than papered over.
- A blocked relationship that appears *after* a request is sent still denies
  respond/withdraw, because those handlers build the viewer against the
  counterparty and `can` short-circuits on `BLOCKED`.

## Alternatives considered

**Proposer confirms after collecting preferences.** The right model for groups,
and overkill for 1:1 - it adds a round trip ("Bob says Thursday works" → "Alice
confirms Thursday") with no benefit when there is one invitee. Adopt it when
group requests arrive; it does not replace this.

**A dedicated `hangout:accept` action for the proposer.** Needed only under the
proposer-confirms model. Under invitee-resolves, `hangout:respond` already
authorizes exactly the right person, so a new action would be dead weight.

**A background job for expiry.** More infrastructure to run and monitor for a
status transition that only matters when someone looks. Lazy settlement is
indistinguishable to every observer and needs no clock.
