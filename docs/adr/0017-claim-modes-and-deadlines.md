# 0017. Things are claimed by one of three modes, against one deadline

**Status:** Accepted
**Date:** 2026-07-31

## Context

`Listing`, `Claim`, and `Exchange` have been modelled and policy-covered since
the foundation pass, but nothing drives them: the Things route is a placeholder.
Making it real forces a question the original model ducked.

The existing `Claim` comment says "multiple claims may be PENDING at once; the
owner picks." That is one sensible way to give away a chair. It is not the only
one, and it is the *worst* one for the case the product actually cares about — a
well-loved object with several interested friends, where "the owner picks" turns
a small kindness into a small social obligation. Choosing between friends in
public is exactly the pressure [ADR 0007](0007-async-by-design.md) exists to
remove.

Two other patterns are common and better suited to some items:

- **First come.** Right for low-stakes items where speed is fair enough and the
  owner wants it gone.
- **A draw.** Right when several friends want the same thing and the owner would
  rather not adjudicate. Randomness is the point: it launders the decision so
  nobody is refused *by* anyone.

Whichever applies, an offer that stays open forever becomes clutter. Both the
owner and the people watching need to know when it closes.

## Decision

**One `claimMode` per listing, and one `claimsCloseAt` deadline.**

### The modes

`ClaimMode` is `FIRST_COME | LOTTERY | OWNER_SELECTS`.

| Mode | What a claim means | How it resolves |
|---|---|---|
| `FIRST_COME` | "I'll take it" | The first eligible claim is accepted on arrival; the listing becomes `CLAIMED` in the same write |
| `LOTTERY` | "Enter me" | Every entry stays `PENDING` until the deadline; the owner then draws once, at random |
| `OWNER_SELECTS` | "I'd like that" | Entries accumulate; the owner accepts one whenever they choose |

The mode is fixed at creation and **cannot be changed** while claims exist.
Switching from `LOTTERY` to `FIRST_COME` after people have entered would
retroactively rewrite what they agreed to, and switching the other way lets an
owner stage a draw they have already seen the entrants for.

### The deadline

`claimsCloseAt` is optional, and means the same thing in every mode: **after it
passes, no new claims are accepted.** What differs is only what happens next —
nothing (`FIRST_COME`, which is usually already resolved), the draw becomes
available (`LOTTERY`), or the owner picks at leisure (`OWNER_SELECTS`).

One field, one meaning. A per-mode deadline vocabulary ("entry closes" vs
"claim by") would be three fields that are really one, and three chances for a
comparison to be written against the wrong one.

### The draw is an explicit owner action

`POST /v1/listings/:id/draw`, gated on `listing:draw`.

Rejected: **drawing lazily on read**, in the style of hangout expiry. Expiry is
idempotent and derivable — anyone recomputing it gets the same answer. A draw is
neither. Making a `GET` mutate state means the winner depends on who happened to
load the page first, and it puts a random write inside a read path that is
otherwise safe to retry.

Rejected: **a scheduled job.** There is no job runner, and inventing one for this
is a larger commitment than the feature.

The cost is that an owner can simply never draw. That is acceptable: it is their
object, and a listing nobody draws is indistinguishable from one nobody wanted.

### Randomness is injected, never read by the kernel

`packages/policy` may not read the clock, and by the same rule it may not read a
random source ([ADR 0005](0005-policy-engine.md)). `drawWinner()` is a pure
function taking the entrant list and a caller-supplied number in `[0, 1)`. The
route supplies `crypto.getRandomValues`; tests supply a fixture and assert the
selection exactly.

`Math.random()` is not used. It is not a security boundary here, but a draw whose
outcome is predictable from previous draws is a bad look for a feature whose
entire value is that it is *visibly* fair.

### Entrant counts are not disclosed

A non-owner is never told how many people have claimed or entered, and never who.
This follows the standing rule that a count of hidden things is a disclosure
(CLAUDE.md non-negotiable 4): "three friends want this" is a fact about three
people who did not agree to broadcast their interest, and it is inferable down to
individuals by watching the number move.

The deliberate cost: a lottery entrant cannot see their odds. That is a real
product loss and it is accepted, because the alternative leaks a social signal
every time someone acts. Owners see their own listing's entrants in full — they
have to, in order to draw or select.

### A claimant sees their own claim, and no others

`projectListing()` returns `yourClaim` — the viewer's own claim, if any — and
never the others. This is what makes "I entered this" renderable without making
"who else entered" derivable.

### The in-person handoff stays gated

This ADR ships **listing and claiming only**. `Exchange` — the handoff that puts
two people in a room — remains unbuilt and unrouted, still gated on reporting and
moderation per [the roadmap](../product/roadmap.md). Accepting a claim tells two
friends they should sort something out; it does not schedule anything, and no
calendar event is written.

That boundary is not incidental. Everything before the handoff is text and
photos between people who are already friends, and is recoverable if it goes
wrong. The handoff is the part that is not, and it does not ship without a way to
report someone.

## Consequences

- Three resolution paths means three lifecycle tests per gate, not one. The deny
  matrix in `actions.test.ts` grows accordingly, which is the intended cost.
- `claimMode` immutability is enforced by *absence*: `UpdateListingInput` has no
  such field, so the edit route cannot express the change and does not have to
  police it. A rule the schema makes unsayable beats a rule a handler remembers.
- The draw needs the full entrant list in memory at once. Bounded by the claim
  cap per listing, so this stays cheap.
- Suppressing entrant counts will be re-proposed — it looks like an oversight
  from the outside. It is written down here so the next person has to argue with
  the reason rather than assume there wasn't one.
- Photos land with listings, which puts user-supplied binary on a surface with no
  moderation behind it yet. Mitigated by friends-only claiming, strict format
  sniffing, and access tied to listing visibility — but this is the thing to
  revisit first when moderation lands.

## Alternatives considered

**Auction / best offer.** `priceMinorUnits` already exists, but bidding turns a
favour between friends into a transaction between counterparties — an
[explicitly refused anti-feature](../product/roadmap.md).

**Queue / waitlist.** "You're third in line" is a count of hidden interest, and
it manufactures exactly the low-grade obligation the product refuses.

**Auto-decline the losing entries on a draw.** Kept, in fact — a draw declines
every entry it did not select, because leaving them `PENDING` forever is the
guilt pile in another costume. This differs from `OWNER_SELECTS`, where accepting
one deliberately leaves the rest open as backups.
