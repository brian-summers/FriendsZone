# Visibility and privacy - normative specification

This document specifies exactly how much of a calendar event a viewer may see.
It is the reference implementation's contract, not a summary of it.

**If you change `packages/policy/src/visibility.ts`, change this file in the
same commit.** The tests in `visibility.test.ts` are the executable form of the
table below; a disagreement between the three is a bug in whichever was edited
last.

---

## 1. The lattice

Four levels, totally ordered:

| Level | Rank | The viewer learns |
|---|---|---|
| `HIDDEN` | 0 | Nothing. The event does not exist for them. |
| `BUSY` | 1 | An opaque unavailable interval. No title, location, or attendees. |
| `TITLE` | 2 | Busy, plus the title and confirmed/tentative status. |
| `FULL` | 3 | Everything, including description, location, and attendee list. |

The ordering is load-bearing. The engine takes the **maximum** of everything a
viewer is granted, then clamps with the **minimum** against the event's ceiling.
Inserting a level in the middle later means revisiting `VISIBILITY_RANK` and
every projection function.

## 2. Audiences

A `ShareRule` pairs an audience with a level. Audiences are:

| Audience | Matches when |
|---|---|
| `SELF` | Never matches a non-owner. Owner access is decided earlier. |
| `FRIENDS` | The viewer is an accepted, mutual friend. **`PENDING` does not match** - asking to be someone's friend must not be enough to read their calendar. |
| `CIRCLE(id)` | The viewer is an accepted friend **and** a member of that circle. |
| `PUBLIC` | Always, including unauthenticated callers. |

**There is no negative audience** - no "everyone except X". Negative audiences
fail *open*: a bug in the exclusion list grants access rather than withholding
it. Every audience here requires an affirmative match.

`CIRCLE` re-checks friendship at read time rather than trusting the roster.
Unfriending someone does not scrub them from circle membership lists, so the
roster alone would leave an ex-friend holding a valid key.

Now that unfriending is reachable from the product
([ADR 0028](../adr/0028-friend-requests-and-blocking.md)), that re-check is
load-bearing rather than theoretical, and
`social.test.ts` exercises it end to end: an ex-friend still on a circle roster
sees nothing of an event shared to that circle - not the location, not the
title, not that the hour is occupied.

## 3. The algorithm

`resolveEventVisibility(event, viewer, ownerDefaults) → VisibilityLevel`

Evaluated strictly in this order:

1. **Owner** → `FULL`. Nothing can hide your own calendar from you, including a
   `HIDDEN` ceiling.
2. **Blocked** → `HIDDEN`. Checked before any grant is considered, so no rule -
   not even `PUBLIC` - can route around a block.
3. **Attendee** → `FULL`, *bypassing the ceiling*. Someone invited to a thing
   already knows where and when it is. Withholding it from them would be
   theatre, not privacy.
4. **Rules** → `max(level)` over every matching rule. Uses the event's own
   `shareRules` if it has any; otherwise the owner's `SharingDefaults`. An empty
   rule list means *inherit defaults*, not *deny*.
5. **Ceiling** → `min(result, event.visibilityCeiling)`.

Default outcome when nothing matches: `HIDDEN`. The engine has no branch that
grants access without an affirmative match.

### Worked cases

| Scenario | Result | Why |
|---|---|---|
| Owner, ceiling `HIDDEN`, no rules | `FULL` | Rule 1 precedes everything. |
| Blocked viewer, rule `PUBLIC→FULL` | `HIDDEN` | Rule 2 precedes grants. |
| Blocked viewer who is an attendee | `HIDDEN` | Rule 2 precedes rule 3. |
| Stranger, no rules | `HIDDEN` | Default deny. |
| Friend, no event rules, conservative defaults | `BUSY` | Rule 4 falls back to defaults. |
| Friend in circle; rules `FRIENDS→BUSY`, `CIRCLE→FULL` | `FULL` | Rule 4 takes the max. |
| Friend not in that circle, same rules | `BUSY` | Only `FRIENDS` matched. |
| Friend, rule `FRIENDS→FULL`, ceiling `BUSY` | `BUSY` | Rule 5 clamps. |
| Attendee, ceiling `HIDDEN` | `FULL` | Rule 3 bypasses the ceiling. |
| Pending friend request, rule `FRIENDS→TITLE` | `HIDDEN` | Pending ≠ friend. |
| Ex-friend still in circle roster, rule `CIRCLE→FULL` | `HIDDEN` | Friendship re-checked. |
| Anonymous, rule `PUBLIC→TITLE` | `TITLE` | `PUBLIC` matches everyone. |
| Non-owner, rule `SELF→FULL` | `HIDDEN` | `SELF` never matches a non-owner. |

## 4. Projection

`projectEvent(event, level)` builds the viewer's copy. It is a **whitelist**:
each level names the fields it emits.

| Level | Fields emitted | Deliberately absent |
|---|---|---|
| `HIDDEN` | *nothing at all* | the event does not appear in any form |
| `BUSY` | `start`, `end` | **no `id`** - an id is a handle for correlation; **no `title`** |
| `TITLE` | `id`, `ownerId`, `timeRange`, `title`, `status` | `description`, `location`, `attendeeIds` |
| `FULL` | everything in `TITLE`, plus `description?`, `location?`, `attendeeIds` | - |

> A `...event` spread anywhere in `projection.ts` is a security bug. The
> whitelist is what makes adding a field to `CalendarEvent` unable to leak it by
> default. `projection.test.ts` asserts the exact key set at `TITLE` and will
> fail if anyone widens it without deciding to.

**Owner-only fields.** A few `FULL` fields - `sharedAs`, `shareRules`,
`ownVisibilityCeiling` - exist so the owner can see and edit their own event's
sharing. They are populated **only** in the owner branch of `projectCalendar`,
never on a non-owner's `FULL` view (which is only reached by attendees or
explicit grants). `projection.test.ts` asserts all three are absent for
non-owners. When you add such a field, follow the pattern and extend that test.

## 5. Calendar-level rules

`projectCalendar()` applies four rules that individual events cannot express:

**Busy blocks are merged**, including across adjacent intervals. If a viewer can
see 09:00–10:00 and 10:00–11:00 as separate blocks, the boundary at 10:00 tells
them there are two commitments rather than one. Merging on `<=` erases that and
the free/busy answer is identical.

**Busy blocks carry no id.** A stable id per busy block would let a viewer
correlate the same event across queries and across viewers.

**Busy blocks are clipped to the requested window**; detail views are not.
Clipping stops a narrow query revealing how far past its edges a commitment
runs. Detail views are exempt because a viewer authorised to see the event is
authorised to see its real extent.

**Cancelled events are dropped for everyone but the owner.** A cancellation is
information - "they freed up that evening" - and it is not the viewer's to have.

**Visible events also appear in `busy`.** The redundancy makes slot-finding
correct for a client that reads only `busy`, and stops a client treating a
titled event as free time.

## 5a. Defaults, and the three presets

Almost nobody changes defaults, so `SharingDefaults` *is* the privacy control for
most users on most events. Three named presets are offered
([ADR 0021](../adr/0021-sharing-presets.md)):

| Preset | Rules | A friend sees |
|---|---|---|
| `PRIVATE` | none | Nothing |
| `BUSY_TO_FRIENDS` | `FRIENDS → BUSY` | That you're busy |
| `OPEN_TO_FRIENDS` | `FRIENDS → TITLE` | What it's called |

- ❌ **No preset grants `FULL`, and none reaches `PUBLIC`.** `FULL` carries
  location and the attendee list; as an account default that is a standing grant
  over every event you will ever create, which is the stalking abuse case as a
  settings row. Both stay reachable per event and through custom rules, at the
  cost of a deliberate act. `visibility.test.ts` asserts this over every preset.
- ✅ **`CONSERVATIVE_SHARING_DEFAULTS` and `BUSY_TO_FRIENDS` are the same value**,
  defined once. If they drifted, an unconfigured user and a user who picked
  "Busy to friends" would be sharing different amounts.
- ✅ **An absent row is not consent.** The fallback for someone who has never
  chosen stays `BUSY_TO_FRIENDS`; `chosen: false` makes that state *legible*
  without making it less safe.

## 6. Prohibited disclosures

Reviewers should treat any of these in a diff as a blocking finding.

- ❌ **Counts of withheld items.** No `hiddenCount`, no "3 private events". A
  count of what you cannot see is still a disclosure. `CalendarView` has exactly
  four keys and a test asserts it.
- ❌ **Distinguishable errors.** A blocked viewer, a stranger, and a nonexistent
  user must receive byte-identical responses. Asserted in both
  `projection.test.ts` and `server.test.ts`, and again at the social perimeter:
  a friend request to someone who blocked you and a friend request to an id
  nobody holds return the same status *and* the same body.
- ❌ **Anything that answers "who blocked me" or "was I declined".** There is no
  endpoint for either, and neither has a client-side tell - no "no results, you
  may have been blocked" hint, no declined state in an outbox. A declined
  request is deleted, so there is nothing to leak
  ([ADR 0028](../adr/0028-friend-requests-and-blocking.md)).
- ❌ **A search result page whose length depends on blocks.** Search
  over-fetches and then filters, so a caller cannot infer a block from a page
  that came back one short.
- ❌ **Ids in busy blocks.**
- ❌ **Unbounded windows.** Capped at 62 days: an unbounded range is a
  bulk-export request wearing a calendar's clothes.
- ❌ **Cacheable calendar responses.** Every response carries
  `cache-control: no-store`.
- ❌ **Event data in logs.** Titles, locations, and descriptions never reach a
  log line. Log the structured `DenyReason`, never the resource.

## 6a. Listings - the lattice does not apply

Listings are governed by the **audience model alone**, not by the four-level
lattice. There is no `BUSY` equivalent for a chair: either you are in the
audience and you see the item, or you are not and it does not exist for you.
`projectListing` returns `ListingView | null`, and the `null` is what makes an
out-of-audience listing indistinguishable from one that was never created.

What crosses the boundary, and what never does:

| Field | Owner | In-audience viewer | Everyone else |
|---|---|---|---|
| `title`, `description`, `condition`, `photoKeys`, `status` | ✅ | ✅ | - |
| `claimMode`, `claimsCloseAt` | ✅ | ✅ | - |
| `audience` | ❌ | ❌ | - |
| `yourClaim` | n/a | ✅ own only | - |
| `claims` | ✅ | ❌ **absent** | - |

Three of those rows are prohibitions rather than omissions:

- ❌ **`audience` never leaves the server, not even to the owner.** It is the
  owner's sharing configuration, not a property of the item, and a viewer who
  could read it would learn the shape of the owner's circles. Owners edit it
  through `UpdateListingInput`, which is a different type in a different
  direction.
- ❌ **`claims` is absent for non-owners, not empty.** An empty array is a
  count, and zero is a number. A client that renders "0 interested" for one
  viewer and nothing for another has leaked the distinction.
- ❌ **No entrant counts, ever.** A lottery entrant cannot see their odds. This
  is a real product loss, accepted deliberately -
  [ADR 0017](../adr/0017-claim-modes-and-deadlines.md) records the argument so
  the next person has to disagree with a reason rather than assume there was
  none.

**Photos follow the listing.** A `photoKey` is not a capability: serving one
re-runs `listing:view` for the requester *and* checks that the key belongs to
that listing. Both halves matter - without the second, any visible listing is an
oracle for every photo in the store.

The block gate applies unchanged: `listing:view` is not in
`BLOCK_EXEMPT_ACTIONS`, so a blocked viewer sees nothing. This is why
`projectListing` gates on `can()` rather than testing the audience inline - an
inline `audienceMatches` would silently drop the block check.

## 6b. The slot finder - an intersection, never a privileged read

"When are we all free?" computes over **projections**, not stored events. For
each participant the engine runs the same `projectCalendar` the requester would
get by opening that person's calendar, then intersects the `busy` sets
([ADR 0008](../adr/0008-slot-finder-on-projections.md)).

The property this buys, stated as a rule reviewers should enforce:

> **No information flows that was not already flowing.** A requester learns
> nothing from a hundred slot queries that a hundred ordinary calendar views
> would not have told them.

That is what closes the differential attack. If the finder ever read raw events
- or read *anything* the requester could not read directly - a caller could vary
the participant set across queries and difference the results to isolate an
individual's week. No single response would look like a leak.

Rules that follow:

- ❌ **Never intersect over stored events.** `repos.calendar.eventsInWindow`
  output must pass through `projectCalendar` for the requesting viewer first.
  This will look like a pointless indirection. It is the entire security
  argument.
- ❌ **Never add an audience that only the slot finder honours.** Such a grant is
  privileged data by construction and reopens the attack; see
  [why there is no `SCHEDULING` audience](../adr/0008-slot-finder-on-projections.md#why-there-is-no-scheduling-audience).
- ✅ **Only `busy` blocks a slot.** `openBlocks` are explicitly overlappable, and
  tentative holds are never busy (§7) - treating either as busy would also let a
  requester manufacture false conflicts on someone else's calendar.
- ✅ **Quantize inward.** Start rounds up, end rounds down, to a 15-minute grid,
  so a suggestion never covers busy time and never reveals the exact boundary of
  whatever created the gap.

The accepted cost: someone who shares nothing with you appears completely free,
so suggestions can be wrong. The interface is *required* to say so - "2 of 3
people share availability with you" - which discloses that a grant does not
exist, and nothing whatsoever about their calendar.

## 7. Tentative holds - a separate access rule

Pending hangout requests surface on the calendar as tentative **holds**
(`CalendarView.holds`), and they are governed by their own rule, **not** the
visibility lattice above. `deriveHangoutHolds` (in `packages/policy`) is the
normative implementation; `projection.test.ts` is its executable form.

The rule is **mutual participation**: a hold is emitted for a view of owner
`O` as seen by viewer `V` only when *both* `O` and `V` are parties to the
request. Consequences:

- A hold may carry its full title and the other party's id with **no
  visibility check**, because it is only ever shown to someone who already holds
  the request (they proposed the times or were asked about them). It discloses
  nothing new.
- A third party who can see `O`'s calendar sees **none** of `O`'s holds - they
  are not a party to any of them.
- Holds are **never counted as busy** and never appear in the `availability`
  (free/busy) response. A pending ask is not a commitment; treating it as one
  would let anyone degrade your visible availability by proposing times.

If you change the participation rule, update this section and
[ADR 0011](../adr/0011-tentative-holds.md) in the same commit.

## 7a. Open blocks - occupied but overlappable

Events **overlap by default**. A non-exclusive event (`CalendarEvent.exclusive
=== false`, the default) is real and visible under the ordinary rules above, but
it does not *block time*. Its occupancy is reported in `CalendarView.openBlocks`,
never in `busy`, and it is absent from the free/busy (`availability`) response's
`busy` entirely. Only an event explicitly made **exclusive** (`exclusive: true`
- the opt-out) lands in `busy`; accepted hangouts are exclusive.

The privacy gating is unchanged: an open block only reaches a viewer who could
already see the underlying event at ≥ `BUSY`, so it discloses nothing a hard
busy block would not have. The point is purely that the time reads as *open to
requests / overlappable* rather than as a wall - see
[ADR 0015](../adr/0015-overlap-by-default-and-drag-to-create.md).

**`openBlocks` must never be folded into `busy`.** Doing so would let anyone
mark your overlappable time as unavailable. A route test enforces this.

## 8. Known gaps

Honest accounting of what this model does **not** yet defend against:

- **Timing side channels.** Response time may correlate with how many events
  were filtered. A viewer who can measure precisely could infer activity in a
  window they cannot see. Mitigation deferred; would require constant-time
  projection or padding.
- **Longitudinal correlation.** Repeated polling of merged busy blocks can
  reveal boundaries that any single response conceals. Rate limiting is the
  intended mitigation and is not yet implemented.
- **Attendee inference.** If Alice and Bob both share `BUSY` with you at exactly
  the same interval, you can guess they are together. Inherent to publishing
  free/busy at all; documented rather than solved.
- **Ceiling is per event, not per field.** A user cannot currently share a title
  but hide a location while granting `FULL` to a circle. If that becomes a
  requirement it needs a new level, not a special case.
