# 0008. The slot finder runs on projections, not raw calendars

**Status:** Accepted
**Date:** 2026-07-21
**Amended:** 2026-08-01 — supporting measure 4 (a `SCHEDULING` audience) is
withdrawn and replaced with a refusal, before acceptance. The argument is in
[Why there is no `SCHEDULING` audience](#why-there-is-no-scheduling-audience).

## Context

"When are we all free?" is the highest-value feature Friendszone can build, and
plausibly its reason to exist. Everything else — the calendar, the sharing
lattice, the async requests — is infrastructure for answering that question
without a group chat.

The obvious implementation reads every participant's calendar, intersects the
free time, and returns the gaps. It is a dozen lines and it is a serious
vulnerability.

**The attack.** The intersection is a side channel. A requester who can vary the
participant set across repeated queries can difference the results and isolate
any individual. Ask for {Bob, Carol}, then {Bob}, then {Carol}: the deltas
reconstruct each person's busy pattern. Iterate over windows and a script
extracts a complete calendar from someone who shared nothing with you. No
individual response looks like a leak, which is what makes it dangerous — it
would survive review by anyone examining one request at a time.

This is the standard differential attack on aggregate queries, and the standard
mitigations (query budgets, noise injection) are poor fits: noise makes a
scheduling suggestion wrong in a way users cannot reason about, and a query
budget on a core feature is a bad user experience protecting a bad design.

## Decision

The slot finder operates on **projections**, not raw events. For each
participant, compute their availability exactly as the requester is already
entitled to see it — the same `projectCalendar` output the requester would get
by opening that person's calendar — then intersect those.

The security property becomes trivially true rather than argued:

> No information flows that was not already flowing.

There is no differential attack because there is no privileged data in the
computation. A requester learns nothing from a hundred queries that they could
not learn from a hundred ordinary calendar views, which are already the thing
rate limiting exists to bound.

Supporting measures:

1. **Quantize to a 15-minute grid.** Suggestions never reveal exact event
   boundaries.
2. **Cap participants at 20**, bounding both fan-out and inference surface.
3. **Rate limit separately** from ordinary calendar reads.
4. **Only `busy` intervals block a slot.** `openBlocks` — time an owner marked
   overlappable, "open to conflict" per
   [ADR 0015](0015-overlap-by-default-and-drag-to-create.md) — does not, because
   its whole meaning is that it may be booked over. Tentative holds do not block
   either: [ADR 0011](0011-tentative-holds.md) already establishes that a pending
   ask is never counted as busy, and a slot finder that treated it as busy would
   let a requester manufacture false conflicts on someone's calendar.

### Why there is no `SCHEDULING` audience

An earlier draft of this ADR proposed a purpose-limited `SCHEDULING` audience —
"share Busy-only with people actively scheduling with me" — as a way to get good
suggestions without widening a calendar generally. It is withdrawn, because it
cannot be both purpose-limited and safe.

Put the two possible readings side by side:

- **If it applies only to the slot finder**, then the finder computes over data
  the requester cannot see by opening that person's calendar. That is precisely
  the privileged input this ADR removed, and the differential attack comes
  straight back: vary the participant set, difference the results, isolate the
  individual. The one property that makes this design defensible — *no
  information flows that was not already flowing* — would no longer hold.
- **If it also applies to ordinary calendar reads**, then it is `FRIENDS → BUSY`
  wearing a different label. The lattice already expresses that in one line of
  sharing defaults, and a second spelling of an existing grant is a second thing
  to audit.

There is no third reading. The feature it was meant to buy — "let good
suggestions happen without opening my week to everyone" — is real, and the
answer is a **request to widen an existing grant**, not a new kind of grant: the
interface offers a one-tap "ask them to share free/busy with you", which
produces an ordinary `FRIENDS`- or circle-scoped `BUSY` rule the owner can see in
Settings and revoke like any other. Consent lands in the same place all other
consent lands, where a user can find it.

Note this is *not* a claim that the lattice can express everything. It is the
narrower claim that this particular audience buys nothing the lattice lacks,
while costing the security property the rest of the ADR rests on.

## Consequences

- **Suggestions can be wrong.** A participant who shares nothing appears
  completely free. This is the real cost and it is a genuine product downside.
- The interface must state it plainly: *"Dave doesn't share availability with
  you, so he's shown as free"*, with a one-tap request to share. A wrong
  suggestion the user can explain beats a right one built on data they were not
  entitled to.
- Expect this to be re-proposed. "Just read the real calendars, we only return
  the intersection" is an intuitive and completely wrong argument, which is
  why this ADR exists.
- Implementation is nearly free: `projectCalendar` already produces per-viewer
  busy sets, so the feature is an intersection over N of them.
- Needs a batch relationship port (`relationships(viewerId, ownerId[])`) first,
  or it is an N+1 on every query.
- Telling a requester "Dave doesn't share availability with you" discloses that
  a *grant does not exist*. That is a real disclosure and it is accepted: it
  carries nothing about Dave's calendar — no content, no counts, no timing — and
  without it the feature confidently reports a stranger as free all week, which
  is worse for both of them.

## Alternatives considered

**Raw calendars, return only the intersection.** The naive design. Vulnerable to
differencing as above.

**Raw calendars with differential privacy.** Adding calibrated noise to
availability produces suggestions that are sometimes wrong for reasons no user
can understand, and the privacy budget degrades with use — meaning the feature
gets worse the more you rely on it. Wrong tool for an interactive product.

**Ask every participant to approve each query.** Airtight, and it reintroduces
exactly the synchronous back-and-forth the product exists to eliminate. The
durable, consent-once version is an ordinary sharing rule the owner grants
once and can revoke in Settings — which is what the one-tap request produces.

**Client-side intersection.** Moves the computation but not the disclosure; the
client would need the raw data to intersect it. Strictly worse.
