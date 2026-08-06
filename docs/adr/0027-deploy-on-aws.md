# 0027. One origin on AWS; Cloudflare drops to DNS or nothing

**Status:** Accepted
**Date:** 2026-08-02
**Supersedes:** the Cloudflare Workers hosting arrangement (`wrangler.jsonc` and
`docs/playbooks/deploy-on-cloudflare.md`), both removed.

## Context

The Cloudflare setup predates most of this product. It was written when the API
**could not be deployed at all** — no authenticator, no persistence — so it
served the static client and nothing else, and that was an honest fit for what
existed. Both blockers are now gone. There is a real API, a real database, and a
reason to choose a host on the merits.

The stated constraints: AWS is the most accessible option, upfront cost should be
near zero, it must be deployable and testable in the cloud without paying for
oversized managed services, and scaling later should not be a rewrite.

## Decision

### One CloudFront distribution in front of everything

```
                    ┌──────────────── CloudFront ────────────────┐
   friends-zone.app │  /api/*  →  API origin (container)         │
                    │  /*      →  S3 bucket (the built client)   │
                    └────────────────────────────────────────────┘
                                        │
                        API ──→ Postgres (RDS / Aurora Serverless v2)
                        API ──→ S3 (listing photos)
                        API ──→ SES (email, when it exists)
```

The single distribution is not a convenience — it is the thing that preserves a
**documented security property**. `apps/web/src/lib/api.ts` says it plainly:
every request goes to a same-origin `/api/*` path, so *"there is no CORS
configuration anywhere — and therefore no permissive `Access-Control-Allow-Origin`
to leak into production by accident."* Splitting the client and the API across
two hostnames means CORS, and CORS means a header that is one careless
wildcard away from undoing the work. It would also break `SameSite=Lax` on the
session cookie, which [ADR 0024](0024-authentication.md) relies on for CSRF.

Two behaviours on one distribution keeps all of that intact.

### Cloudflare is dropped as a host

Nothing in the previous arrangement survives the API existing:

- **The API cannot run on Workers.** Password hashing is scrypt at `N=2^16` —
  ~64 MB and ~100 ms per hash by design ([ADR 0024](0024-authentication.md)).
  That does not fit a Worker's memory and CPU budget, and weakening it to fit
  would trade a security parameter for a hosting choice.
- **Serving the client from Cloudflare while the API is on AWS** reintroduces
  CORS, which is the one thing the single-origin design exists to avoid. Fixing
  that with a proxy Worker means paying a network hop and a second provider's
  operational surface to arrive back where CloudFront already is.
- **The free-tier argument is gone.** CloudFront's always-free tier is 1 TB
  egress and 10 M requests a month — more than adequate, and on the same account
  as everything else.

**DNS is a genuine tossup**, and it is the user's call: Cloudflare's DNS is good
and free, Route 53 is $0.50/zone/month and keeps everything in one console. Both
work. That is the only remaining Cloudflare decision, and it is reversible in an
afternoon.

### AWS is a suitable host, with two named traps

Suitable, yes — but the reason to be explicit is that AWS makes it easy to spend
$50/month on an idle demo without noticing. The two that would bite here:

| Trap | Cost | Avoided by |
|---|---|---|
| **NAT Gateway** | ~$32/mo, always on | Put the API in a public subnet with a security group, or use VPC endpoints. Never a NAT for an app this size |
| **Application Load Balancer** | ~$16/mo, always on | CloudFront talks to the API origin directly. No ALB until there is more than one target to balance |

With those avoided, an idle deployment is **single-digit dollars a month**, and
most of it is the database.

### Two rungs, and the second is a config change

**Rung 1 — evaluation.** App Runner (~$5/mo idle, scales to one small instance)
or Lambda behind a Function URL (free tier covers a demo outright), plus Aurora
Serverless v2 with a **0 ACU minimum** so an idle database costs storage only,
plus S3 and CloudFront on their always-free tiers. Deployable, testable, real
HTTPS, real domain — for the price of a coffee.

**Rung 2 — real usage.** Raise the Aurora minimum off zero to kill cold starts,
raise App Runner's instance count, put the rate limiter on a shared store. None
of that is a re-architecture, and the port interfaces do not move.

The 12-month RDS free tier is deliberately **not** the plan. It expires, and a
deployment that becomes expensive on a date nobody wrote down is worse than one
that costs a little from the start.

### What has to change in the code, and what already has

Fixed as part of this decision, because both are wrong the moment a CDN is in
front:

- **`trustProxy` is now a bounded hop count**, not `true` and not absent.
  `request.ip` feeds the anonymous rate-limit bucket. Absent, every anonymous
  caller behind CloudFront shares one bucket and one abuser limits everyone;
  `true` takes a client-supplied `X-Forwarded-For` and lets a caller mint a
  fresh bucket per request. `TRUSTED_PROXY_HOPS` defaults to 0 — over-limiting
  is the safe direction — and is 1 behind one distribution.
- **CSP and HSTS are now sent.** The app serves user-uploaded images from its own
  origin; shipping that without a Content-Security-Policy was an oversight.
- **`/readyz` is separate from `/healthz`.** Liveness says the process is up and
  is what decides whether to *restart* it; readiness says the database answers
  and is what decides whether to send traffic. Conflating them restarts a
  container in a loop whenever the database blinks.

Still outstanding, and tracked in [the road to GA](../product/road-to-ga.md):
photo bytes belong in S3 rather than a `bytea` column, and the rate limiter is
per-process until it has a shared store.

## Consequences

- One provider, one console, one bill. The operational surface halves.
- CloudFront caches the client aggressively and the API **not at all** — every
  API response already carries `cache-control: no-store`, and a CDN that cached
  one viewer's projection and served it to another would defeat the entire
  privacy model. The `/api/*` behaviour must have caching disabled explicitly,
  and that is called out in the playbook rather than left to a default.
- `wrangler` leaves `devDependencies`; `npm run deploy` and `preview:cf` go.
- Vendor lock-in is modest and deliberate: S3, CloudFront, and Postgres have
  equivalents everywhere. Nothing here uses a proprietary datastore or a managed
  auth service, which was already the position [ADR 0024](0024-authentication.md)
  took on identity providers.

## Alternatives considered

**Stay on Cloudflare, port the API to Workers.** Requires abandoning scrypt at
current parameters and rewriting the Postgres access path around Hyperdrive.
Trading a security parameter for a hosting preference is the wrong direction.

**Fly.io or Railway.** Genuinely simpler for this shape of app and cheaper at the
bottom. Rejected on the user's stated constraint — AWS is what they have access
to — and it is worth recording that the app itself does not care: it is a
container plus a Postgres URL.

**EC2 with everything on one box.** Cheapest of all and the least operable: no
managed backups, patching by hand, and the first scaling step is a rebuild rather
than a number.

**Elastic Beanstalk.** Provisions an ALB by default, which is most of the idle
cost, for orchestration App Runner gives without one.
