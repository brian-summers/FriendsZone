# Visibility and privacy — normative specification

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
| `FRIENDS` | The viewer is an accepted, mutual friend. |
| `CIRCLE(id)` | The viewer is an accepted friend **and** a member of that circle. |
| `PUBLIC` | Always, including unauthenticated callers. |

**There is no negative audience** — no "everyone except X". Negative audiences
fail *open*: a bug in the exclusion list grants access rather than withholding
it. Every audience here requires an affirmative match.

`CIRCLE` re-checks friendship at read time rather than trusting the roster.
Unfriending someone does not scrub them from circle membership lists, so the
roster alone would leave an ex-friend holding a valid key.

## 3. The algorithm

`resolveEventVisibility(event, viewer, ownerDefaults) → VisibilityLevel`

Evaluated strictly in this order:

1. **Owner** → `FULL`. Nothing can hide your own calendar from you, including a
   `HIDDEN` ceiling.
2. **Blocked** → `HIDDEN`. Checked before any grant is considered, so no rule —
   not even `PUBLIC` — can route around a block.
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

```
HIDDEN → nothing
BUSY   → { start, end }                      ← no id, no title
TITLE  → { id, ownerId, timeRange, title, status }
FULL   → TITLE + { description?, location?, attendeeIds }
```

> A `...event` spread anywhere in `projection.ts` is a security bug. The
> whitelist is what makes adding a field to `CalendarEvent` unable to leak it by
> default. `projection.test.ts` asserts the exact key set at `TITLE` and will
> fail if anyone widens it without deciding to.

**Owner-only fields.** A few `FULL` fields — `sharedAs`, `shareRules`,
`ownVisibilityCeiling` — exist so the owner can see and edit their own event's
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
information — "they freed up that evening" — and it is not the viewer's to have.

**Visible events also appear in `busy`.** The redundancy makes slot-finding
correct for a client that reads only `busy`, and stops a client treating a
titled event as free time.

## 6. Prohibited disclosures

Reviewers should treat any of these in a diff as a blocking finding.

- ❌ **Counts of withheld items.** No `hiddenCount`, no "3 private events". A
  count of what you cannot see is still a disclosure. `CalendarView` has exactly
  four keys and a test asserts it.
- ❌ **Distinguishable errors.** A blocked viewer, a stranger, and a nonexistent
  user must receive byte-identical responses. Asserted in both
  `projection.test.ts` and `server.test.ts`.
- ❌ **Ids in busy blocks.**
- ❌ **Unbounded windows.** Capped at 62 days: an unbounded range is a
  bulk-export request wearing a calendar's clothes.
- ❌ **Cacheable calendar responses.** Every response carries
  `cache-control: no-store`.
- ❌ **Event data in logs.** Titles, locations, and descriptions never reach a
  log line. Log the structured `DenyReason`, never the resource.

## 7. Tentative holds — a separate access rule

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
- A third party who can see `O`'s calendar sees **none** of `O`'s holds — they
  are not a party to any of them.
- Holds are **never counted as busy** and never appear in the `availability`
  (free/busy) response. A pending ask is not a commitment; treating it as one
  would let anyone degrade your visible availability by proposing times.

If you change the participation rule, update this section and
[ADR 0011](../adr/0011-tentative-holds.md) in the same commit.

## 7a. Open blocks — occupied but negotiable

An event marked **open to conflict** (`CalendarEvent.openToConflict`) is real
and visible under the ordinary rules above, but it does not *block time*. Its
occupancy is reported in `CalendarView.openBlocks`, never in `busy`, and it is
absent from the free/busy (`availability`) response's `busy` entirely.

The privacy gating is unchanged: an open block only reaches a viewer who could
already see the underlying event at ≥ `BUSY`, so it discloses nothing a hard
busy block would not have. The point is purely that the time reads as *open to
requests* rather than as a wall — see
[ADR 0013](../adr/0013-floating-and-open-to-conflict.md).

**`openBlocks` must never be folded into `busy`.** Doing so would let anyone
mark your negotiable time as unavailable. A route test enforces this.

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
