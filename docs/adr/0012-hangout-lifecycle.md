# 0012. Hangouts stay editable after they are made; notifications are records, not pushes

**Status:** Accepted
**Date:** 2026-07-22

## Context

Until now a hangout was immutable once it resolved: accepted meant booked, and
that was the end of the state machine (`ACCEPTED` was terminal). Real plans are
not immutable. People change the time, fix a typo in the title, or cancel
because they came down with a cold. The calendar - the single pane of glass -
had no way to do any of that, so a confirmed hangout was a dead end.

## Decision

**`ACCEPTED` is no longer terminal.** Three edit operations join the state
machine, plus one new status:

- **Update** (`hangout:update`) - change title / note / location. The
  organiser's right. When the hangout is already confirmed, the change is
  mirrored onto both calendar copies so the booked event stays in step.
- **Reschedule** (`hangout:reschedule`) - the organiser's right. A pending
  request gets fresh proposed slots (a re-ask); a confirmed one is re-booked to
  a single new time on both calendars.
- **Cancel** (`hangout:cancel` → new `CANCELLED` status) - *either* participant
  may call off a *confirmed* hangout. Both calendar copies are marked cancelled.
  (A still-pending request is withdrawn or declined, as before.)

Who may do what is deliberate. The **organiser owns the shape** - they authored
the ask and the invitee agreed to *those* terms, so changing them is the
proposer's call; the invitee's recourse to a change they dislike is to cancel.
But **cancelling is either party's**, because a confirmed hangout is a mutual
commitment and either person must be able to pull out.

These operations act through the `HangoutRequest`, which now tracks
`resultingEventIds` - *every* calendar copy, not just the accepter's. Fanning an
edit out to both copies reads from there. This is the same sanctioned
cross-owner write as acceptance ([ADR 0010](0010-hangout-resolution.md)): owner
ids come from the stored request's participants, never the request body.

**Notifications are records, not pushes.** Each of these operations takes an
optional `notify`. When set, a `Notification` is *written* for the other party
to find - it is not delivered in real time. This keeps "let them know" honest
(the message is composed and stored, and the recipient sees it in their inbox)
without building the real-time nudge channel that
[ADR 0007](0007-async-by-design.md) rules out. A notification is the recipient's
alone; there is no fan-out and no "seen" state.

## Consequences

- The calendar can now manage a hangout in place - edit, move, cancel - which
  is what "everything from the calendar" requires.
- `resultingEventIds` must stay complete or a fan-out edit will miss a copy.
  The accept, book, reschedule, and cancel paths all maintain it, and the
  route tests assert both copies move together.
- The notification store is minimal by design: create + read-your-own. When the
  daily digest of [ADR 0007](0007-async-by-design.md) is built, it reads from
  here; nothing about these records presumes real-time delivery.
- `hangout:read` was added so the client can load a hangout it is a party to
  (to know the viewer's role and current details) without a second privileged
  surface. It is participant-only and collapses "not yours" into "not found".

## Alternatives considered

**Reschedule a confirmed hangout by reopening it as pending.** More "correct" -
the other party re-accepts the new time - but heavier, and out of step with how
every calendar app works. We chose the optimistic move-and-notify: the mover
picks the new time, both copies move, the other party is told and can cancel if
it no longer works. The async, low-pressure ethos makes "told, can back out"
acceptable where a hard re-acceptance gate would add friction.

**Let either party edit and reschedule.** Rejected: an invitee silently
rewriting the plan the organiser proposed is a surprising authority. Editing is
the organiser's; cancelling is shared.

**Deliver notifications immediately.** That is precisely the pressure the
product exists to remove. Records now; digest later.
