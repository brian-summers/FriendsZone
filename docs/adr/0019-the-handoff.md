# 0019. The handoff is proposed and accepted, and shows third parties only Busy

**Status:** Accepted
**Date:** 2026-07-31

## Context

[ADR 0017](0017-claim-modes-and-deadlines.md) shipped listing and claiming and
stopped deliberately short of the handoff, gating it on reporting and moderation.
[ADR 0018](0018-reporting-and-moderation.md) built that. The gate is satisfied,
and this is the decision it was waiting for.

`Exchange` has been modelled since the foundation pass, with a comment naming it
"the one place the product moves people into physical proximity". Everything else
Friendszone does is text between people who are already friends, and is
recoverable if it goes wrong. This is not. A handoff record is a **named person,
at a named place, at a known time** — the single most sensitive row the product
will ever write, and the one an attacker with access to the database would want
most.

So the design question is not "how do we schedule a meetup". It is "what is the
least dangerous shape this can take while still being useful".

## Decision

### Two steps: propose, then accept

One party proposes a time and place; the other accepts. Nothing is booked on
either calendar until both have agreed.

Rejected: **auto-scheduling on claim acceptance.** Accepting a claim means "you
can have the chair", not "I will be at this address on Thursday". Collapsing the
two would put a location commitment behind a button that reads like a giveaway,
and the person most likely to click through without reading is the one being
pressured into it.

Either party may propose, and either may re-propose while it is still
`PROPOSED` — haggling over a time is the normal case, not an exception.

### Booked events are capped at BUSY

When an exchange is accepted, each participant gets an event **on their own
calendar**, with `visibilityCeiling: 'BUSY'`.

The ceiling is doing precise work here, and it is worth spelling out why it is
safe rather than merely restrictive:

- A **third party** resolves through `minVisibility(granted, ceiling)`, so the
  most anyone else can learn is that this person is occupied. Not where. Not with
  whom. At `BUSY`, `projectEvent` emits a time range and nothing else — no title,
  no location, no attendee list.
- Both **participants** still see everything, because the attendee branch of
  `resolveEventVisibility` returns `FULL` *before* the ceiling clamp. Two people
  meeting need the address; the neighbourhood does not.

This is the opposite of an accepted hangout, which uses `FULL`. A hangout is a
social plan people are often happy to have visible. A handoff is an address.

The events are `exclusive: true` — a firm commitment blocks its slot.

### The location is typed by a person, and stored nowhere else

`location` is free text the participants agree between themselves. It is never
auto-filled, never suggested from anything we hold, and never resolved to
coordinates.

We store no home addresses, which is what makes this easy to promise. There is
deliberately **no venue database, no map, and no location history**: building any
of them would mean accumulating a record of where our users physically meet, and
that dataset is more dangerous than the feature is valuable.

The UI suggests meeting somewhere public. That is *copy*, not data — a sentence
in the compose form, not a list of places we tracked.

### Cancelling removes both events

Cancellation is either party's right at any point before completion, and it
deletes the calendar events on **both** calendars rather than marking them
cancelled in place.

This differs from hangouts, where cancelled events survive for the owner. The
reason is the ceiling: a cancelled handoff that lingers still occupies a slot,
and "they freed up that evening, at short notice" is exactly the pattern
[the visibility spec](../architecture/visibility-and-privacy.md) drops cancelled
events to avoid. A handoff that is off should leave no trace on anyone's week.

No reason is required and none is recorded. "Why did you cancel" is a question a
person being made uncomfortable should never have to answer to a form.

### Completion is either party's call

Either party marks it done, which moves the listing to `EXCHANGED`. Not a
two-sided confirmation: chasing someone for a confirmation tap is precisely the
low-grade obligation [ADR 0007](0007-async-by-design.md) refuses, and nothing
turns on the record being adjudicated.

### Reporting is in the flow

The handoff UI carries a report control aimed at the counterparty, reusing the
`USER` subject from [ADR 0018](0018-reporting-and-moderation.md). Someone who
becomes uneasy while arranging a meetup should not have to go and find the
feature; and a report about a person needs no evidence snapshot, which is exactly
the case that works when there is nothing to screenshot.

Blocking still cuts the whole thing off: `can()` refuses every exchange action
for a blocked pair before any state is consulted.

## Consequences

- Two more cross-owner writes join `resultingEventIds` as sanctioned exceptions
  to "you write only your own calendar". Both take owner ids from stored state,
  never from a request body, following [ADR 0010](0010-hangout-resolution.md).
- The `BUSY` ceiling means an owner's own "who can see this" badge reads *Busy*
  for a handoff. That is correct and will look like a bug to someone who does not
  know why. Hence this ADR, and hence a test named after it.
- Deleting events on cancel means the calendar has no record a handoff was ever
  scheduled. Accepted: the `Exchange` row retains the history for support and
  moderation, and the calendar is not an audit log.
- No map and no venue suggestions will be re-proposed as an obvious convenience.
  The answer is in this file.

## Alternatives considered

**Book on claim acceptance, edit later.** Fewer taps, and it puts an address
commitment behind a button that reads like generosity. Rejected above.

**A shared handoff "chat".** Every message channel between two people who may be
in conflict is a channel that needs moderation, blocking semantics, and retention
rules. The exchange carries a proposed time, a place, and an optional note; if
they need to talk more, they are friends and already have a way.

**Auto-suggested public meetup spots.** Genuinely the best safety feature
available, and it requires either a third-party places API (sending our users'
neighbourhoods to a vendor on every compose) or our own venue set (a dataset of
where people meet). Both fail the test of being less dangerous than the problem.
Revisit only with a design that holds no per-user data.

**Requiring both parties to confirm completion.** Adds a nag, settles nothing.
