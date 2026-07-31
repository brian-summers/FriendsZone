# 0013. Floating hangouts and open-to-conflict events

**Status:** Accepted — the open-to-conflict polarity is revised by
[ADR 0015](0015-overlap-by-default-and-drag-to-create.md) (events overlap by
default; `openToConflict` became `exclusive`, an opt-out). Floating hangouts
stand as written.
**Date:** 2026-07-22

## Context

Two requests that both loosen the rigid "one plan, one fixed time" model:

- A **floating** hangout that can happen *any number of times within a period* —
  "let's walk the dog whenever, over the next two weeks."
- Events that are **open to conflict** — you have something booked but you'd
  happily be pulled away, so friends should be able to request that time anyway.

Both bend the calendar's core assumptions (an event occupies a fixed slot; a
booked time is unavailable), so both need care not to break the privacy and
free/busy invariants.

## Decision

### Floating hangouts

A `HangoutRequest` gains a `kind`: `FIXED` (the classic candidate-slots ask) or
`FLOATING`. A floating request carries a `period` and an `occurrenceMinutes`
instead of proposed slots, and stays `PENDING` for its whole life. Either party
**books an occurrence** (`hangout:book`) at any start inside the period; each
booking mints a pair of confirmed events — one per participant — and the
invitation stays open for the next one. It expires at the period's end.

Booked occurrences are ordinary confirmed events, so they appear on the calendar
as firm plans and count as busy like anything else. The floating *invitation*
itself is managed from the inbox, not drawn on the grid — it has no single time
to occupy.

### Open to conflict

A `CalendarEvent` gains `openToConflict`. Such an event is real and visible per
the normal visibility rules, but it does **not block time**: it contributes to a
new `CalendarView.openBlocks` field rather than `busy`, and is absent from the
free/busy (`availability`) response's `busy` entirely. It reads on the calendar
as "open", not as a hard wall, and the request composer treats that time as
requestable.

The two axes stay independent: `openToConflict` (does this block time?) is
orthogonal to visibility (who can see it?) — an event can be BUSY-to-friends and
still open to conflict, in which case those friends see a soft `openBlocks`
entry rather than a hard `busy` one.

## Consequences

- Floating gives "recurring, but flexible" without a recurrence engine (the
  expensive feature deferred in [the roadmap](../product/roadmap.md)): there is
  no rule to expand, just occurrences booked on demand.
- `openBlocks` is a new field on `CalendarView`, so the "exact keys" privacy
  test was updated to include it. It carries the same visibility gating as
  `busy` — an open block only appears to a viewer who could already see the
  event at ≥ BUSY — so it discloses nothing new.
- **Availability must never fold `openBlocks` into `busy`.** Doing so would let
  anyone quietly mark your negotiable time as unavailable, which is the opposite
  of the feature. A route test asserts adding an open-to-conflict event does not
  change the availability response's `busy`.
- Per-occurrence cancellation of a floating booking is not yet built — an
  occurrence is a plain event, and event-level edit/delete is a separate,
  still-absent capability. Managing the *whole* floating invitation (withdraw
  while pending) works today.

## Alternatives considered

**Model floating as recurrence.** Recurrence is the most expensive feature in
the product ([roadmap](../product/roadmap.md)) and answers a different question
("this, every Tuesday"). Floating is "this, whenever, some number of times",
which is exactly on-demand booking against a window — much cheaper and a better
fit for the ask.

**Exclude open-to-conflict events from the calendar entirely** so they never
block. Rejected: they are real events the owner wants to see and share; the
issue is only whether they *block requests*. Splitting time into `busy` vs
`openBlocks` keeps them visible while making them requestable.

**A soft flag on `busy` blocks instead of a separate array.** Busy blocks are
merged and anonymised; hanging a per-block flag off them fights that merge.
A separate `openBlocks` array composes with the existing merge cleanly.
