# 0007. No presence, no read receipts, ever

**Status:** Accepted
**Date:** 2026-07-20

## Context

Friendszone exists because coordinating plans over messaging apps is stressful.
Not because messaging is technically inadequate — because it is *synchronous by
social convention*. A message that has been delivered creates an obligation. A
message marked "seen" and unanswered creates a worse one. People end up
declining plans they would have enjoyed, or avoiding making them at all, because
the medium demands an immediate answer.

Every product in this space eventually gets asked for presence indicators, typing
indicators, and read receipts. They are easy to build, they demo well, and they
measurably increase short-term engagement.

## Decision

Friendszone will not have them. Not as an option, not defaulted off, not for
"close friends only".

This is a product constraint with a schema consequence: **there is nowhere in
the domain model to store them.** `HangoutRequest` has no `seenAt`,
`deliveredAt`, or `viewedBy`. `User` has no `lastActiveAt`. The absence is
deliberate and is recorded here so that a future contributor — human or agent —
recognises it as a decision rather than an omission to be helpfully filled in.

Three positive mechanisms replace the pressure these features create:

1. **Requests expire.** `expiresAt` is required. A request that quietly ages out
   is socially cheaper than one you must actively decline, and `EXPIRED` is
   deliberately not modelled as a rejection.
2. **Availability windows are consent to be asked**, not a free/busy signal. A
   friend proposing a time inside them is not intruding.
3. **Slots are capped at ten.** A request with thirty options is a scheduling
   burden dressed up as flexibility.

## Consequences

- Some users will ask for read receipts. The answer is no, and this ADR is the
  answer.
- Engagement metrics will look worse than a competitor's. Accepted; the point of
  the product is that using it less anxiously is a success.
- There is a real privacy benefit as a side effect: presence data is a
  high-resolution activity log, and the safest way to protect it is not to
  collect it. A `lastActiveAt` field would undermine the calendar privacy model
  from an entirely different direction — it tells a watcher when you are awake,
  travelling, or at your desk, regardless of what your calendar shares.
- Notification design must be careful not to reintroduce this by the back door.
  A push notification that says "Bob is waiting for your reply" is a read
  receipt with extra steps.

## Alternatives considered

**Read receipts, off by default.** Defaults are the strongest signal a product
sends, but the moment the capability exists, "why haven't you turned it on?"
becomes a social question. The pressure returns via the settings screen.

**Presence limited to a close-friends circle.** Same failure, smaller blast
radius, plus it makes circle membership socially loaded in a way the privacy
model works hard to avoid — see the circle-name leakage abuse case in
[the threat model](../security/threat-model.md).
