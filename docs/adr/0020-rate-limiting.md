# 0020. Token buckets at the edge, declared per route, in process memory

**Status:** Accepted
**Date:** 2026-08-01

## Context

Rate limiting has been the outstanding Tier 0 obligation since the foundation
pass. [The threat model](../security/threat-model.md) carries several rows that
resolve to "⛔ not built" or "⚠️ partial" purely because nothing bounds request
volume: photo upload has a per-file cap and no per-user quota, the slot finder
fans out to twenty calendar projections per call, and every "gap" in the model is
exploitable at scale precisely because scale is free.

The privacy model makes this sharper than it would be elsewhere. A calendar view
is *designed* to be safe to serve - a stranger gets an empty week, a friend gets
what they were granted. What it is not designed to survive is ten thousand of
them a minute, because the aggregate of individually-safe reads is a scraping
run, and [ADR 0008](0008-slot-finder-on-projections.md) explicitly leans on rate
limiting as the thing that bounds it: "a requester learns nothing from a hundred
queries that they could not learn from a hundred ordinary calendar views, **which
are already the thing rate limiting exists to bound**."

## Decision

**Token buckets, declared per route as a named class, enforced at the HTTP edge,
held in process memory.**

### Named classes, not numbers on routes

A route declares `rateLimit: 'EXPENSIVE'`, not `{ capacity: 10, refill: 0.2 }`.
Numbers on individual routes drift: the twentieth route to be added gets whatever
the author guessed that afternoon, and nobody can answer "what are our limits"
without reading every file. A closed set of classes is greppable, reviewable in
one place, and forces a new route to say which kind of thing it is.

Omitting the field is not "unlimited" - it is `DEFAULT`. There is no route
without a bucket.

### Keyed by actor, falling back to client address

An authenticated caller is limited as themselves. Everyone else is limited by
remote address.

The fallback is the weak half and is documented as such: addresses are shared by
NAT and cheap to rotate for anyone who cares. It is a speed bump on anonymous
traffic, not a control, and the real answer arrives with
[ADR 0006](0006-authentication-deferred.md).

There is a sharper problem while the dev authenticator is in play: `x-dev-actor-id`
is caller-supplied, so a caller can claim any id and exhaust *someone else's*
budget - a targeted denial of service against a named user. That is not
theoretical, it is trivial. It is acceptable only because the authenticator
**refuses to construct in production**, and it is called out here so that
whoever implements real sessions knows this bucket key becomes load-bearing the
moment they do.

### In process memory, and the consequence

No Redis, no shared store. One `Map`, swept periodically.

The consequence, stated plainly because it will otherwise be discovered in an
incident: **with N instances behind a load balancer, the effective limit is N
times the configured one.** That is fine for one process and wrong for a fleet.
Whoever adds the second instance owns replacing this with a shared counter, and
the interface is deliberately narrow - `RateLimiter` has one method - so the swap
is an adapter, not a rewrite.

The store is **bounded**. An unbounded map keyed by remote address is itself a
memory-exhaustion vector, which would make the denial-of-service control a
denial-of-service vector. When it is full, the oldest entries are evicted, which
means a flood of distinct keys can evict a legitimate caller's bucket and hand
them a fresh allowance. Refusing service instead would let anyone lock every user
out by filling the table; forgiving is the correct failure direction for this
control specifically, and only because the buckets it holds are cheap.

### Disabling it is a boot failure in production

`RATE_LIMIT_ENABLED=false` exists for tests and local load work. The config
validator **refuses to start in production** with it off, in the same spirit as
the authenticator: a security control that can be quietly turned off in
production is a control that eventually is.

## Consequences

- Every route now carries a bucket, so a new endpoint is limited by default
  rather than by remembering.
- `429` responses carry `Retry-After`. That discloses only how long *you* must
  wait - a fact about the caller, not about anyone else.
- Limits are per process. See above; this is the thing to fix first when scaling
  out.
- The existing suite runs with limiting disabled, because 401 tests hammering
  `app.inject` would otherwise trip buckets and produce failures that have
  nothing to do with what each test is checking. One dedicated file turns it on
  and exercises the limiter directly.
- Tuning is guesswork until there is production traffic. The numbers are chosen
  to be invisible to a person using the product and obstructive to a script.

## Alternatives considered

**Fixed-window counters.** Simpler, and they permit a double-rate burst across a
window boundary - exactly when a scraper is most likely to be hammering. A token
bucket smooths that for the same amount of code.

**Sliding-window logs.** Precise, and they store a timestamp per request per key.
Storing more data to defend against volume is the wrong shape.

**A reverse proxy or CDN rule.** Correct for crude volume, and it cannot key by
authenticated actor, which is the key that actually matters here. Complementary
rather than alternative - do both, eventually.

**Rate limiting inside `packages/policy`.** Considered and rejected: the kernel
is pure and may not hold state or read a clock, and "how many times have you
asked" is not an authorization question about a resource. It belongs at the
transport edge with the other transport concerns.
