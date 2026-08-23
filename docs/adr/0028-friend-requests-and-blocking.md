# 0028. Friend requests are a pending friendship; blocks are directed and mutual-safe

**Status:** Accepted
**Date:** 2026-08-03

## Context

The policy kernel has understood `FRIEND`, `PENDING`, and `BLOCKED` since the
foundation pass. Every audience check, every projection, and the whole threat
model assume blocking works. **None of the three could be created.** Friendships
came from the seed; blocks came from the seed; `PENDING` was unreachable.

That is the largest functional hole in the product - [the road to
GA](../product/road-to-ga.md) names it - and a safety feature with no button is
not a safety feature.

Building it surfaced a contradiction that had been sitting quietly in the
codebase. `packages/contracts/src/social.ts` says:

> A block is intentionally *not* modelled as a friendship status. It is a
> separate, **directed** record so that unblocking never silently restores a
> friendship.

The schema and the in-memory adapter both stored it **undirected** - one row per
canonically-ordered pair, exactly like `friendships`. Nothing depended on the
difference while blocks could only be seeded. The moment *unblock* exists, it
becomes a real bug:

> Alice blocks Bob. Bob blocks Alice. One row. Alice unblocks Bob - and Bob's
> block on Alice disappears with it, because there was never a second row to
> keep.

The person who most wants a block to hold is the one who would lose it.

## Decision

### Blocks are directed rows, one per direction

`blocks(blocker_id, blocked_id)`, primary key on both, no canonical ordering.
`relationship()` still collapses to `BLOCKED` if a row exists in **either**
direction - that part was always right, and it is what stops a caller having to
remember to check both ways. What changes is that unblocking removes *your* row
and cannot touch theirs.

`friendships` keeps its canonical ordering (`low < high`) and its check
constraint, because a friendship genuinely is one symmetric fact and a second
row would be a way for the two halves to disagree.

### A friend request is a pending friendship, not a second table

`Friendship` already carries `requestedBy` and `status: PENDING | ACCEPTED` -
the contract has modelled this from the start. Accepting flips the status.

A separate `friend_requests` table would mean two rows describing one
relationship and a window where both exist, which is precisely the
"half-accepted state visible only from one side" the canonical ordering exists
to prevent.

`requestedBy` is what lets the interface tell *"Bob wants to be friends"* from
*"you asked Bob"* without a second query, and it is why the field was there
before anything used it.

### Blocking is a bigger hammer than unfriending, and says so

Blocking **removes the friendship and cancels any pending request in either
direction**, in one transaction. A block that left a friendship row intact would
be relying on the `relationship()` precedence order alone - true today, and one
refactor away from not being.

Blocking deliberately does **not** scrub circle rosters, consistent with
[ADR 0023](0023-circle-management.md): `audienceMatches` re-checks friendship at
read time, so a stale roster entry grants nothing, and quietly editing someone's
lists on another person's action is its own harm. The owner sees such entries
marked inactive.

### Block and unblock are exempt from the block gate

`can()` refuses everything for a blocked pair before the switch. Two actions
must survive that, for the same reason reports do
([ADR 0018](0018-reporting-and-moderation.md)):

- **`block:create`** - if Bob blocks Alice first, Alice must still be able to
  block Bob. Otherwise the person who blocked first controls whether the other
  can protect themselves, and Bob unblocking would silently restore contact
  Alice never agreed to.
- **`block:remove`** - you must be able to withdraw your own block whether or
  not they have one on you.

Both satisfy the exemption's invariant: the response is a fixed shape that says
nothing about the counterparty.

### Search answers only about people you could already reach

Handle search is how anyone finds anyone; `PublicProfile` is deliberately
minimal so that handle enumeration yields nothing worth harvesting.

Two rules on top of that:

- **A blocked pair never see each other**, in either direction, and the result
  is identical to the person not existing. Anything else makes search an oracle
  for "did they block me", which is the signal that makes people escalate to
  another account.
- **Tombstoned accounts never appear.** A deleted user is not a person you can
  befriend.

Results are capped, prefix-matched on handle and display name, and drawn from
the same rate-limit bucket as other reads.

### Every refusal is the same 404

Requesting a nonexistent user, a user who blocked you, and yourself all produce
the same response. The kernel returns different `DenyReason`s - they are
different facts, and operators should see them - but `denialToResponse`
collapses them, as it does everywhere else.

## Consequences

- `RelationshipKind.PENDING` becomes reachable for the first time. It grants
  nothing: `audienceMatches` requires `FRIEND`, and a pending request must not
  leak a calendar.
- `stillAFriend: false` on a circle roster also becomes reachable. ADR 0023's
  test seeded that state directly and said so; it can now be produced through
  the product, and the test is rewritten to do that.
- One schema change to `blocks` (directed) and two columns on `friendships`.
  Existing rows would need a migration; there are none in production, so this is
  a schema edit rather than a migration - the last moment that will be true.
- The social graph is now writable, which makes `SocialGraphPort` the widest
  port. It stays free of authorization logic: the kernel decides, the port
  stores.

## Alternatives considered

**Keep blocks undirected and let the last unblock win.** Simpler, and it hands
control of a safety boundary to whichever party acts second. The bug above is
not hypothetical - it is the expected outcome of two people who dislike each
other both using the feature.

**Auto-accept friendships (follow model).** Removes the request flow entirely
and changes what a "friend" means in every audience check. The whole visibility
model rests on friendship being mutual and affirmative.

**Let blocking scrub circle rosters.** Tidier, and it edits the owner's private
groupings in response to someone else's action. ADR 0023 already argued this;
the re-check makes stale entries harmless.

**Notify on block.** Never. The threat model is explicit that learning you have
been blocked reliably triggers escalation and evasion.
