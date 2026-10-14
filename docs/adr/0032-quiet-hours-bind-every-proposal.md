# 0032. Quiet hours bind every route that proposes a time, and only where they are shown

**Status:** Accepted
**Date:** 2026-10-13
**Amends:** [ADR 0030](0030-full-day-grid-and-quiet-hours.md)

## Context

ADR 0030 defines quiet hours as "a recurring daily window in which nobody may
propose a plan", enforced server-side. The implementation enforced it on one
route, `POST /v1/hangouts`. Three other routes put a time in front of another
person, and none of them checked:

- **Rescheduling a hangout**, both a pending re-ask and a move of a confirmed
  one. The proposer could send a 14:00 request and move it to 03:00.
- **Booking a floating occurrence**, which writes straight onto the other
  party's calendar without asking them at all.
- **Proposing a handoff time** ([ADR 0019](0019-the-handoff.md)).

Separately, the overlap check sampled every 15 minutes on the grounds that "the
smallest bookable unit is 15 minutes". The same commit made minutes pickable in
fives, so a five-minute window lying between two samples of a longer slot was
stepped over. Reproduced in `availability.test.ts`.

## Decision

### One helper, on every proposing route

`refuseQuietHours` in `apps/api/src/routes/quiet-hours.ts` is called by all
four routes. It checks the *other* parties' windows only: your own quiet hours
are a request to other people, not a restriction on you, so you may book your
own night.

### Enforced only against a window the proposer is shown

The window that is enforced is `visibleQuietHours(viewer, owner, window)`, the
same function the calendar projection uses. Owner and accepted friends see the
window; everyone else gets `null`, and so is never refused on it.

This matters because a refusal is a disclosure. A proposer who can see the
shaded region learns nothing new from a 400. One who cannot see it would learn
the window one rejected hour at a time, which undoes the projection's `null`.
The case is real: claiming a Thing requires a friendship, but the handoff
outlives one. If the two unfriend after the claim, either may still propose a
handoff time and neither is shown the other's window any more.

The rule is in `packages/policy`, defined once, so the projection and the
enforcement cannot disagree about who is shown what.

### The sampling step is the window's own length, capped at 15 minutes

A window L minutes long is an interval of L real minutes, and samples spaced at
most L apart cannot step over it. The walk stops at the first hit, and a
non-empty daily window is reached within a day, so a range of any length costs
at most about a day of samples. Formatters are cached per zone, because
constructing an `Intl.DateTimeFormat` costs far more than using one.

## Consequences

- "Nobody may propose a plan inside my quiet hours" is now true on every route
  that proposes one.
- Someone who is not your friend can still propose a handoff time inside your
  window. They cannot see it, and they cannot book it: a handoff needs your
  acceptance before anything reaches a calendar.

## Alternatives considered

**Enforce the raw window regardless of who is asking.** Rejected for the
reason above: a validation error is an oracle for anything the asker is not
otherwise shown.

**Leave handoffs out, as a different kind of plan.** Rejected: a handoff is a
time and a place put in front of another person, which is exactly what the
rule is about.

**Sample every minute.** Correct, but up to fifteen times the work on the
common case for no gain over a step sized to the window.
