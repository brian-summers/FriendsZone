# 0030. The grid covers the whole day, and unavailability is a region

**Status:** Accepted
**Date:** 2026-08-23

## Context

Three problems, all about time the product could not express.

**The grid ran 07:00 to 23:00.** A third of every day was unreachable: you
could not see, create, or drag anything before seven in the morning or after
eleven at night. Night shifts, early flights, and anyone whose evening runs
past eleven simply had nowhere to put it.

**Time was picked from one long dropdown** of half-hour steps. Tolerable across
a working day, unusable across twenty-four, and it silently forbade 09:05
because five past was never on the list.

**There was no way to say "not then, ever".** You could decline each request
individually, which is exactly the repeated small friction the product exists
to remove, and it required being asked at 3am to say no to 3am.

## Decision

### The grid draws 00:00 to 24:00

`DAY_END_HOUR` is 24, the exclusive upper bound, so the last row is 23:00 to
23:59. The grid already scrolls, so the cost is scrolling rather than absent
hours.

### Time is an hour field and a minute field

Two short lists instead of one long one. Twenty-four hours and twelve minute
steps, each pickable without scrolling, and together they reach any quarter
hour. The value handed to callers is still one minute-of-day, so nothing
downstream knows it is two controls. A stored value off the step, from a drag
or an older event, stays selectable rather than being silently rounded.

### Quiet hours are a region, not an event

A recurring daily window in which nobody may propose a plan.

**They are deliberately not calendar entries.** No id, no title, no occupancy.
They render as a hatched region behind everything, non-interactive, and they
never appear in `busy`. That distinction is the whole design: a quiet hour says
*do not ask*, not *I am occupied*. Folding it into busy would overstate how
full a week is and would publish a sleeping pattern as though it were a
commitment.

**The window wraps, and that is the common case.** 23:00 to 09:00 is
`startMinute > endMinute`. Everything that reasons about it handles the wrap in
one place: `inQuietHours` for membership, `quietHoursToBands` for drawing. On a
grid starting at 00:00 a wrapping window is *two* bands, one at the top of the
day and one at the bottom; treating it as a single span computes a negative
height and draws nothing.

**A window whose bounds are equal is empty, not all-day.** "From 9 to 9" is a
mistake, and reading it as never-available would lock someone out of their own
calendar with no obvious way back.

**The zone travels with the window.** `QuietHours` carries `timeZone` rather
than the evaluator reading it from the owner's profile. A rule is then
self-describing: judging it needs only the window and the instant. "Do not ask
me after 23:00" means *the owner's* 23:00, and a proposer abroad must be
refused on the owner's clock or the feature is useless to anyone with friends
in another country. The trade is that moving country keeps the hours you set,
in the zone you set them, until you re-save.

**Overlap is sampled, not solved.** Every 15 minutes, plus the instant before
the end. A closed form would have to model the midnight wrap, multi-day ranges,
and daylight-saving transitions where a local hour repeats or does not exist,
and would be wrong in the cases nobody tests. The smallest bookable unit is 15
minutes, so sampling is exact at the granularity the product offers.

**Enforcement is server-side.** The client shades; the route refuses. A request
built by hand or by an older client is rejected the same way, with a validation
error rather than a policy denial, because it is a malformed proposal and not a
permission problem. Naming the reason discloses nothing: the proposer can
already see the shaded region.

**Visibility follows the projection rules.** Quiet hours reach the owner and
accepted friends. A stranger, a blocked viewer and an anonymous caller all get
`null` - that view is otherwise identical for those three, and a field that
varied between them would be the oracle the rest of the projection removes.

### Creating an event returns to the calendar

It used to open the detail pane on the new event. You have just said what the
event is; a read-only summary of it is a step backwards, and it covers the grid
you wanted to watch it land on.

## Consequences

Easy: the whole day is usable, any quarter hour is reachable, and "never ask me
at night" is one setting rather than a decline every time.

Accepted costs:

- **One window, not several.** Enough for the case people actually have. A list
  of windows is a bigger control for a rarer need, and can be added without
  changing the storage shape.
- **A taller grid.** 24 rows at 44px is 1056px, so the default view scrolls
  where it previously did not.
- **Quiet hours are visible to friends.** That is required for the feature to
  work - they have to know not to propose - and it discloses a rough daily
  rhythm. Anyone uncomfortable with that should not set one, which is why the
  control is off by default.

## Alternatives considered

**Quiet hours as recurring events.** Rejected: they would occupy time, appear
in `busy`, need titles and ids, and be openable. Every one of those is wrong for
a rule that means "do not ask".

**Storing them against the user's profile timezone.** Rejected: evaluating a
rule would then need a second lookup, and a profile timezone change would
silently move every window without the owner touching it.

**Client-side enforcement only.** Not an option. Shading is presentation; the
rule has to hold for a request that never went through the client.
