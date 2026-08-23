# 0011. Pending hangouts appear as participant-scoped tentative holds

**Status:** Accepted
**Date:** 2026-07-22

## Context

Until now a hangout request was invisible on the calendar until it was accepted.
That left a gap: you could propose three times to a friend and see no trace of
it on your own week, and they saw nothing tentative on theirs either. The
calendar - the product's single pane of glass - did not reflect the plans in
flight.

The ask: put pending hangouts on *both* participants' calendars as tentative
entries, make firm-versus-tentative unmistakable, and let people accept or
decline from the calendar itself.

The hazard: a pending request contains times, a title, and the other party.
Splashing that onto a calendar naively risks disclosing it to third parties who
can see the calendar but have nothing to do with the request.

## Decision

**Holds are derived, not stored.** A pending request is not written to the
calendar as a `CalendarEvent`. Instead, `deriveHangoutHolds` computes tentative
`HangoutHold` entries at read time from the pending requests. This keeps the
hangout request the single source of truth - accept, decline, withdraw, and
expiry change one record, and the holds follow automatically with no second
copy to keep in sync.

**Holds are strictly participant-scoped.** A hold is emitted for a calendar view
only when **both** the calendar's owner and the viewer are parties to the
request. The consequence is that a hold discloses nothing: the viewer either
proposed those times or was asked about them, and already holds the request.
That is what makes it safe for a hold to carry its full title and the other
party's id with no visibility check - it is never shown to anyone who was not
already entitled to the request's contents. A third party who can see the
calendar sees none of its owner's holds. Verified in `projection.test.ts` and
`hangouts.test.ts`.

**A hold is never busy.** Holds are a separate field on `CalendarView`, never
folded into `busy`, and the free/busy (`availability`) endpoint omits them
entirely. A maybe must not make you look unavailable - otherwise proposing a
time to someone would degrade their availability to everyone else.

**`role` travels with the hold.** The server tags each hold with the viewer's
role (`PROPOSER` / `INVITEE`) so the calendar can offer exactly the right action
in place - accept this slot or decline (invitee); withdraw (proposer) - without
a second request and without ever presenting an action the viewer can't take.

**Firm versus tentative is a distinct visual axis.** Confirmed events are solid;
tentative holds (and any `TENTATIVE`-status event) are dashed and washed, with a
"Pending" marker and a clock glyph. This is deliberately orthogonal to the
visibility encoding (which is about *who can see*, not *how firm*), so the two
never compete for the same channel. A small legend keys firm / tentative / busy.

## Consequences

- The calendar becomes the single pane of glass the product intends: propose,
  see the hold on both weeks, accept or decline in place. The Inbox remains as a
  list view but is no longer the only way to resolve a request.
- Deriving at read time costs a small query (`pendingInvolving`) per calendar
  read. Cheap, and it composes with the "cache the input" strategy of
  [ADR 0009](0009-cache-the-input.md) - the pending set is cacheable per user.
- Holds only appear for the week you're viewing (slots are clipped to the
  window). A request with slots in another week shows there, and the Inbox plus
  the nav count cover discovery. Acceptable.
- Because holds live in the security kernel (`packages/policy`), the
  participant rule is unit-tested rather than trusted to a route - consistent
  with keeping every access decision in one auditable place.

## Alternatives considered

**Materialise tentative `CalendarEvent`s on send; flip/delete on resolve.** Two
copies of the truth to keep in sync across accept, decline, withdraw, and
expiry, and every one of those is a chance to leave an orphaned hold on someone's
calendar. Worse, a stored event owned by the proposer with the invitee as
attendee would fall under the *owner's* sharing defaults, leaking the tentative
hold to the owner's friends as busy - the exact disclosure we set out to avoid.
Derivation sidesteps both problems.

**Show holds to anyone who can see the calendar.** Simpler, and a privacy
regression: it would tell your friends that someone (unnamed, but timed) has
asked to meet you. The participant scope is the point.

**Count holds toward busy.** Would make free/busy "safer" but is a lie - a
pending ask is not a commitment, and treating it as one lets anyone quietly
degrade your visible availability by proposing times.
