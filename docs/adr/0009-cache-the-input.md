# 0009. Cache the input, never the output

**Status:** Proposed
**Date:** 2026-07-21

## Context

Every calendar response is a projection computed for one specific viewer, and
every response carries `cache-control: no-store`. That is correct and
non-negotiable: a shared cache holding Alice's calendar as projected for Bob,
and serving it to Carol, would defeat the entire privacy model in the most
direct way available.

It also removes every conventional scaling tool. No CDN, no shared response
cache, no edge caching. If a well-connected user has 150 friends checking their
week, that is 150 distinct projections, and the naive implementation is 150
database round trips for data that did not change between any of them.

This is the central scaling tension in the product, and it is a direct
consequence of the privacy design rather than an accident of implementation.

## Decision

> **Cache the input. Never cache the output.**

Raw events for an owner and a window are identical regardless of who is asking.
They are safely cacheable:

- Key: `events:{ownerId}:{weekBucket}`
- Short TTL, plus explicit invalidation on any write to that owner's calendar
- Also cache the owner's `SharingDefaults`, which change rarely

The projection is then recomputed per request from cached raw data. It is a pure
function over a bounded set of events - microseconds of CPU for a realistic
calendar - so recomputing it per viewer is genuinely cheap.

**What must never be cached, at any layer:** `CalendarView`, `EventView`,
`BusyBlock[]`, or any other per-viewer output. Not in Redis, not in a
process-local map, not behind a CDN, not in a service worker.

## Consequences

- The database leaves the hot read path without any weakening of the privacy
  model. The security property is preserved *exactly*: a projection is never
  stored, never shared, never outlives the request.
- Cache invalidation is scoped to a single owner's writes, which is the easy
  case. No cross-user invalidation graph.
- A cache poisoning bug exposes raw events to the *server*, which already has
  them. It cannot cause a cross-viewer disclosure, because nothing viewer-shaped
  is ever written to the cache. The blast radius of getting this wrong is
  therefore small - which is exactly why the split is drawn here.
- Requires a review rule with teeth: any new cache needs to state which side of
  the line it sits on. Worth an automated check if caching spreads.

**This option only exists because the policy engine is pure.** A projection that
performed I/O could not be recomputed cheaply per request, and we would be
forced toward caching outputs and defending it with careful key construction -
which is the design where one mistake becomes a cross-viewer leak. The purity
constraint from [ADR 0005](0005-policy-engine.md) was adopted for testability
and turns out to buy a scaling property as well.

## Alternatives considered

**Cache projections keyed by (viewer, owner, window).** The obvious move, and it
works right up until a key is constructed wrongly - a missing viewer id, a
normalised window, a stale entry after an unfriend - at which point one person
receives another person's view. The failure mode is a privacy breach rather than
a stale page, and cache keys are not where anyone wants their privacy boundary.

**Cache by relationship class** (all friends-in-circle-X share a projection).
Fewer entries, but it makes circle membership a cache key, so a membership
change silently serves stale access. Same failure mode, more moving parts.

**No caching; scale the database.** Honest and simple, and viable for a long
time. Rejected as the plan of record because the fix is cheap and the read
pattern is knowable now - but it is a perfectly reasonable place to start, and
this ADR should not be read as a licence to build the cache before there is
traffic to justify it.
