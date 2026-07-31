# 0015. Overlap by default (exclusive opt-out), and drag-to-create

**Status:** Accepted
**Date:** 2026-07-25

Revises the "open to conflict" decision in
[ADR 0013](0013-floating-and-open-to-conflict.md); floating hangouts there are
unaffected.

## Context

[ADR 0013](0013-floating-and-open-to-conflict.md) gave events an `openToConflict`
flag: an event blocked its time by default, and you *opted in* to let it be
overlapped/requested. In practice the more useful default is the opposite. Many
real plans coexist in the same block — a broad "co-working" afternoon with two
calls inside it, an "on call" week overlapping specific meetings — and treating
every event as an exclusive wall makes those awkward to express and makes the
calendar unable to show layered plans.

Separately, creating an event meant opening a dialog and typing times, when the
calendar already shows exactly where the time is. Dragging out a slot is the
expected gesture.

## Decision

**Events overlap by default; exclusivity is an opt-out.** `openToConflict` is
replaced by `exclusive` (default `false`). A non-exclusive event is
overlappable and *soft*: it contributes to `openBlocks`, not `busy`, and friends
may request the time. Opting out — `exclusive: true` — makes it a hard block:
it goes to `busy`, and nothing overlaps it or can be requested over it.

The projection routing inverts accordingly: `event.exclusive ? busy : openBlocks`.
Everything else about the two fields is unchanged — `openBlocks` still carries
the same visibility gating as `busy` and still must never be folded into it.

Consequences of the new default:

- Most occupied time now lands in `openBlocks`. `busy` means specifically
  "a hard commitment you can't be pulled from." Accepted **hangouts book
  exclusive events** — a confirmed plan with a friend is a real commitment.
- Overlapping events are laid out in **side-by-side columns** on the week grid
  (standard interval-graph packing), so layered plans read as "several things
  in this block" rather than chips stacked illegibly. Pure client rendering;
  `layoutColumns` is unit-tested.

**Drag-to-create.** Dragging (or clicking) in free space on your own week
highlights a selection, snapped to a 30-minute grid, and opens the New Event
dialog with the day and time pre-filled. The dialog's time pickers moved to
30-minute steps to match. The grid computes the range from pointer position
(`yToMinutes` / `dayTimeToIso`) and hands a plain `TimeRange` to the screen; it
does not itself create anything, keeping the write path exactly as before.

## Consequences

- The flag rename touches contracts, the projection, the seed, and the client,
  but the seed now demonstrates the point: a broad "Co-working" block with a
  "Sync" and a "Review call" layered inside it, all non-exclusive.
- The test fixture `event()` defaults to `exclusive: true` so the many tests
  that reason about `busy` keep exercising a hard commitment; the product
  default (non-exclusive) is asserted explicitly in the "overlap by default"
  tests. This split is documented at the fixture.
- Drag selection uses pointer capture (guarded, since jsdom omits it) and
  ignores pointer-downs that land on an existing chip, so opening an event and
  dragging a new slot never collide.

## Alternatives considered

**Keep `openToConflict`, just flip its default.** The name would then lie — a
field called "open to conflict" that defaults to true reads as "conflicts are
open," which is the behaviour, but the mental model the user asked for is
"exclusive is the exception you opt into." Naming the exception (`exclusive`)
matches how people now reason about it.

**Stack overlapping events with a z-order instead of columns.** "Layered" was
the user's word, but stacked chips hide each other; side-by-side columns are how
every calendar shows concurrency legibly, and they still read as "layered in the
same block." Columns it is.

**Free-form (per-minute) drag.** Snapping to 30 minutes keeps the selection
legible and maps cleanly onto the dialog's pickers; per-minute precision can come
with an inline editor later.
