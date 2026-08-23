# 0016. Drag on any calendar, and multi-day events

**Status:** Accepted
**Date:** 2026-07-25

Extends the drag-to-create gesture from [ADR 0015](0015-overlap-by-default-and-drag-to-create.md)
and the grid geometry it introduced.

## Context

[ADR 0015](0015-overlap-by-default-and-drag-to-create.md) let you drag out a
slot **on your own calendar** to create an event, and it placed every interval
with a single-day helper (`place`) that clamped anything crossing midnight to
the bottom of its start column. Two gaps followed:

- The same gesture felt natural on a **friend's** calendar too - but there it
  can't create an event, because you don't own that calendar. The one thing
  dragging a friend's free time *does* mean is "let's meet then."
- Real plans cross midnight - a trip, an overnight, a red-eye. The data model
  always allowed it (`timeRange` is two instants), but the grid couldn't draw
  it: a Saturday-to-Sunday event showed only on Saturday, clamped to the edge.

## Decision

### Drag on any calendar; the calendar's role decides what it means

`WeekGrid` reports a selected range through one `onRangeSelect` callback and
takes no position on what it's for. The screen wires it per calendar:

- **Your calendar** → open the New Event dialog, pre-filled (unchanged).
- **A friend's calendar** → open the request composer with that slot pre-filled
  as the first proposed time.

The grid never writes to a calendar itself, so a friend's grid still cannot
create an event on their calendar - the gesture only *composes a request*, which
travels the ordinary hangout path and its authorization. The free/busy conflict
hint the composer already shows now doubles as live feedback while you pick.

A request slot is single-day and hour-granular, so a cross-day or half-hour drag
on a friend's calendar is **collapsed** to an hour slot on its start day. A
multi-day *hangout* isn't a thing the composer models; forcing the drag to fit
its shape is more honest than inventing one.

### Multi-day events render as a band of per-day segments

`place` is replaced by `placeSpan`, which returns **one segment per day an
interval touches** within the visible week: the first runs to the bottom of its
column, whole middle days fill theirs, and the last runs in from the top. The
edges that continue into an adjacent day are squared (`spans-before` /
`spans-after`), so the event reads as one continuous band rather than unrelated
chips that happen to line up. Column packing runs **per day** on each segment's
portion *of that day*, so a spanning event shares columns with whatever it
actually overlaps on each day.

The New Event dialog gained a separate **end day**, so a multi-day event can be
created directly (validity compares absolute minutes-from-week-start, not just
clock time). A drag that crosses columns selects a multi-day range: the pointer
is hit-tested under capture to find the column it's over, so the selection
follows across days.

## Consequences

- `placeSpan` is the single placement helper now; the old `place` is gone rather
  than left to drift beside it. Its per-day segmentation, clipping to the visible
  week, and continuation flags are unit-tested.
- Cross-day drag relies on `document.elementFromPoint` while the pointer is
  captured to the origin column. Environments without hit-testing (jsdom) fall
  back to vertical-only tracking in the origin column, so the gesture degrades to
  single-day rather than breaking - which is exactly what the component test
  exercises.
- The seed gained a `Cabin weekend` that runs Saturday into Sunday, so the
  running app demonstrates the band. It is `exclusive` (a real trip) and shared
  with friends by title, so it exercises a multi-day entry in both `busy` and
  `details`.
- No privacy surface moved: `placeSpan` is pure client geometry over projections
  the server already computed. A multi-day busy block was always a legal
  projection; only its drawing changed.

## Alternatives considered

**Make a friend's drag create a "suggested" event on their calendar.** That is a
write to someone else's calendar in all but name, and it would need its own
authorization story. Routing the gesture into the existing request flow reuses
the one sanctioned way to put time on another person's calendar.

**Keep clamping multi-day events to their start day** and show a "→ continues"
marker. Simpler, but it hides where the time actually goes - the whole point of a
calendar is to see the block. A band across the real columns is legible and
matches every other calendar.

**Full-precision cross-day drag (per-minute, free end day).** The 30-minute snap
from ADR 0015 stands; it keeps the selection legible and maps onto the dialog's
pickers. The dialog's explicit end-day select covers the multi-day case without
a fiddly diagonal drag being the only way to reach it.
