# Requirements expansion and feature weighting

An honest assessment of what Friendszone should become, what each thing costs at
scale, and what it should refuse to build.

Costs are rated for the *whole* change — schema, policy, projection, tests,
docs, and operational burden — not just the happy-path code.

---

## Tier 0 — Obligations, not features

These are not optional and they are not differentiating. Nothing else ships
first.

| Item | Why it blocks launch | Cost |
|---|---|---|
| Authentication | No product without it. [ADR 0006](../adr/0006-authentication-deferred.md) | M |
| Postgres + RLS | In-memory data is not a product. [ADR 0004](../adr/0004-persistence.md) | L |
| Rate limiting | Without it, every "gap" in the threat model is trivially exploitable at scale | S |
| Reporting & moderation | **Prerequisite for the exchange feature.** Shipping in-person meetups with no way to report someone is negligent | M |
| Account export & deletion | Legal obligation; also the honest counterpart to a privacy-first pitch | M |
| Digest notifications | Without any notification the product is forgotten; with the wrong kind it becomes the thing it was built to replace | M |

**On notifications specifically.** The design constraint from
[ADR 0007](../adr/0007-async-by-design.md) is that a notification must never
manufacture urgency. "Bob is waiting for your reply" is a read receipt with
extra steps. The pattern that works: a **once-daily digest at a user-chosen
hour**, listing what arrived, with expiry dates shown as dates rather than
countdowns.

Pleasingly, this is also the cheapest option to operate — one batched job per
user per day instead of a real-time fan-out on every write. The ethical choice
and the cheap choice coincide here, which is worth noticing because it usually
does not.

---

## Tier 1 — Completes the core product

### "When are we all free?" — the mutual slot finder

**The feature.** Pick some friends, a rough window, a duration. Get back times
that work for everyone.

**Why it matters.** This is the single highest-value feature in the product and
arguably its reason to exist. Everything else — the calendar, the sharing
model, the async requests — is infrastructure for answering this question
without a group chat.

**Why it is dangerous.** The naive implementation reads everyone's raw calendar
and returns the intersection. That leaks, and not subtly: by varying the
participant set across repeated queries and differencing the results, a
requester can isolate any individual's busy pattern completely. The intersection
is a side channel, and a determined user with a script extracts a full calendar
from someone who shared nothing.

**The design that works.** Compute the intersection over **projections, not raw
events** — each participant's availability exactly as the requester is already
entitled to see it. This falls directly out of the existing architecture:
`projectCalendar` already produces per-viewer busy sets, and the slot finder
becomes an intersection over N of them.

The security property is then trivially true rather than argued: *no information
flows that was not already flowing.* No differential attack exists because
there is no privileged data in the computation.

The cost is a UX problem, not a security one: a friend who shares nothing with
you appears completely free, so suggestions are wrong. Three mitigations:

1. Show the denominator honestly — "4 of 6 friends share availability with you".
2. Offer a one-tap **request to share free/busy for scheduling**.
3. Add a purpose-limited `SCHEDULING` audience — "share Busy-only with people
   actively scheduling with me", narrow and revocable — so a user can enable
   good suggestions without widening their calendar generally.

Further hardening: quantize results to a 15-minute grid so exact boundaries are
never revealed, cap participants at ~20, and rate limit the endpoint separately
from ordinary calendar reads.

**Scale weight.** N calendar reads per query. With the caching strategy below
this is N cache hits plus N pure projections — microseconds each. The
intersection itself is a linear sweep over merged intervals. Cheap.

**Cost: M. Verdict: build it, and build it on projections. Requires an ADR.**

### RSVP as a first-class record

Currently implied by `attendeeIds`. Real RSVPs need yes/no/maybe, a response
time, a plus-one count, and the ability to change your mind.

Note the interaction with the privacy model: an attendee sees `FULL`, which
includes the attendee list. So RSVP status is visible to co-attendees by
construction — that is correct, but it should be a deliberate decision recorded
in the domain model rather than a side effect nobody noticed.

**Cost: S. Verdict: build.**

### Sharing presets and honest onboarding

Almost nobody changes defaults, which makes the default the most important
privacy control in the product. Ship three named presets — *Private*, *Busy to
friends* (the current conservative default), *Open to friends* — chosen during
onboarding with the consequence spelled out in plain language.

Then, periodically, a **sharing checkup**: "Here is what Bob can see of your
week." Showing someone their own calendar through another person's eyes is worth
more than any settings screen, and it is nearly free to build because the
projection engine already does exactly this.

**Cost: S. Verdict: build. Highest value-to-effort ratio in this document.**

### Recurring events

**The honest assessment: this is the most expensive feature in the product, and
it looks like one of the cheapest.**

It touches `eventsInWindow`, every projection path, the busy-merge logic, RLS
predicates, and the exception model (this Tuesday moved, that one cancelled,
the rest unchanged). Two implementation strategies, neither free:

- *Expand at query time.* No storage cost, but unbounded CPU for "every Monday
  forever" and a recurrence expansion inside the hot read path.
- *Materialize a rolling window.* Bounded reads, but a background job, storage
  growth, and a reconciliation problem whenever a rule changes retroactively.

Recommended: materialize a rolling 13 months, keep the rule plus exceptions as
the source of truth. Note it interacts badly with field-level encryption —
re-materializing means re-encrypting.

**Cost: XL. Verdict: build, but only with its own ADR, and never as a
"just add a field" change.**

---

## Tier 2 — Valuable once the core is solid

| Feature | Value | Cost | Notes |
|---|---|---|---|
| Circle management UI | High | S | Circles exist in the model but are unusable without one |
| Calendar import (ICS, read-only) | High | M | See the warning below |
| Wishlists — "looking for a desk" | Med | S | The inverse of a listing; reuses the entire audience model |
| Exchange safety kit | High | M | Suggested public meetup spots, share-with-a-friend, in-flow reporting |
| Travel mode | Med | M | Timezone changes silently corrupt availability windows; worth solving properly |
| Shared circle calendars | Med | L | Ownership becomes ambiguous, which is where authorization bugs breed |
| Web push | Med | S | Only ever for the digest. Never per-event |

**On calendar import.** Enormous convenience value — an empty calendar is a dead
product — but it imports 🟠 Sensitive data wholesale from Google or Apple, and
users will not realise their work calendar's event titles are now in a second
system. Mitigations: import as `BUSY`-only by default with titles discarded
unless explicitly opted into, one-way sync only, and a visible provenance marker
on imported events. Export in the other direction is a bigger risk and should
wait.

---

## Anti-features — deliberate refusals

Recorded so they get re-proposed with an argument rather than by default.

| Refused | Why |
|---|---|
| Read receipts, presence, typing indicators | [ADR 0007](../adr/0007-async-by-design.md). Also a high-resolution activity log we then have to defend |
| Public discovery feed | Turns a friends product into a social network and invites strangers into a system whose safety model assumes they are absent |
| Live location sharing | Given [the threat model](../security/threat-model.md), this is the single most dangerous feature we could build |
| Contact-book upload for friend suggestions | Requires harvesting the address books of people who never consented. A privacy catastrophe sold as onboarding |
| In-app payments for listings | Regulatory burden, fraud surface, and it changes secondhand exchange from a favour between friends into a transaction between counterparties |
| Streaks, badges, engagement gamification | Manufactures the obligation the product exists to remove |
| Algorithmic friend ranking | Encodes a judgement about whose friendships matter, then leaks it through ordering |

---

## Scale characteristics

### The caching problem, and the one legal answer

Calendar responses are per-viewer and carry `cache-control: no-store`, so there
is **no shared cache, no CDN, no edge caching** of any response. If a popular
user has 150 friends checking their week, that is 150 distinct projections.

The resolution follows from the architecture rather than fighting it:

> **Cache the input, never the output.**

Raw events for an owner and window are identical regardless of who is asking, so
they are safely cacheable — keyed `events:{ownerId}:{weekBucket}`, short TTL,
invalidated on write. The projection is a pure function over that data,
measured in microseconds for a realistic number of events, and is recomputed per
request.

This preserves the security property exactly (a projection is never stored or
shared) while removing the database from the hot path. It is only available
because the policy engine is pure — a projection that did I/O could not be
recomputed cheaply per request. The purity constraint from
[ADR 0005](../adr/0005-policy-engine.md) turns out to buy a scaling property, not
just a testing one.

### Known hot spots

| Concern | Assessment |
|---|---|
| **N+1 relationship lookups** | `viewerFor(ownerId)` is per-owner by design. Any multi-owner view needs a batch port — `relationships(viewerId, ownerId[])` — before the slot finder ships |
| **Busy merge** | O(n log n) on a bounded window. Not a concern |
| **Recurrence expansion** | The real risk. Materialize; do not expand in the read path |
| **Notification fan-out** | Digest batching makes this trivial. Real-time push would not be |
| **Marketplace search** | Interacts with field-level encryption — see below |
| **Social graph queries** | Friend-of-friend traversal is absent by design; the graph stays shallow and cheap |

### An encryption decision that should be made early

[Data classification](../security/data-classification.md) calls for field-level
encryption of 🟠 Sensitive fields, which forecloses server-side search over
them. The resolution is to be precise about scope rather than to encrypt
everything:

- **Encrypt** calendar event titles, descriptions, and locations. Nobody needs
  to full-text search their own calendar badly enough to justify the exposure.
- **Do not encrypt** listing titles and descriptions. They are 🟡 Internal, they
  exist to be browsed by friends, and search is a core part of that feature.

Deciding this before encrypting is much cheaper than deciding it afterwards.

---

## Suggested sequence

1. **Tier 0** — auth, persistence, rate limiting, moderation, deletion, digest.
2. **Sharing presets and the sharing checkup.** Cheap, and it makes the privacy
   model legible to users rather than merely correct.
3. **Circle management UI.** Unlocks a model capability that already exists.
4. **The slot finder,** on projections, with the `SCHEDULING` audience.
5. **RSVPs**, then **calendar import** with `BUSY`-only defaults.
6. **Recurrence**, with its own ADR and its own release.
