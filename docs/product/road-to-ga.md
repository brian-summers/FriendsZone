# The road to general availability

Where Friendszone is, what stands between it and a public release, and roughly
what each step costs. Ordered so that nothing later is blocked by something
earlier being skipped.

Estimates are in **focused days** for one person who knows this codebase. They
assume the repo's own standard — contracts → policy → tests → ports → route →
integration test → docs — because work done below that bar comes back.

---

## Where it stands today

Built, tested, and documented: the privacy kernel, the calendar, hangouts,
Things with claim modes and the handoff, reporting and moderation, the slot
finder, rate limiting, sharing presets, circles, export and deletion, real
authentication, and PostgreSQL with row-level security. **511 tests.**

That is a complete product for a small group of friends. It is not yet something
to put in front of strangers, and the gap is smaller than it looks — but it is
mostly *operational*, and operational gaps are the ones that get skipped.

---

## Phase 0 — Get it running in the cloud (2–3 days)

The point is a real URL, on a real domain, over HTTPS, that a handful of people
can use. Not "production" — a place to find out what is actually broken.

| Step | Days | Notes |
|---|---|---|
| Container image for the API | 0.5 | Multi-stage, non-root, `node:22-alpine` |
| Aurora Serverless v2, 0 ACU minimum | 0.5 | Idle cost is storage only. **Not** the 12-month RDS free tier |
| App Runner service + VPC connector | 0.5 | No ALB, no NAT — see [ADR 0027](../adr/0027-deploy-on-aws.md) |
| S3 bucket + CloudFront, two behaviours | 0.5 | `/api/*` → API with caching **off**; `/*` → S3 |
| Domain, ACM certificate, DNS | 0.5 | `TRUSTED_PROXY_HOPS=1` once behind the distribution |
| Secrets in SSM Parameter Store | 0.25 | `SESSION_SECRET`, `DATABASE_URL` |

**Exit:** someone who is not you can sign up on their phone and add an event.

### Deferred at deploy time, with reasons

These came out of running `cdk-nag` against the real stack. Each is suppressed
in [`infra/`](../../infra/) with the reason written next to it, so the
suppression is reviewable rather than invisible.

| Item | Why it was deferred | What it costs to fix |
|---|---|---|
| **Custom domain + ACM certificate** | Without one, CloudFront serves the default `*.cloudfront.net` certificate and **pins the minimum TLS version** — `AwsSolutions-CFR4` cannot be satisfied at all until a certificate exists. This is the highest-value item here | Domain registration + ~1h |
| **Secrets Manager rotation** | Rotating the Aurora credential needs a Lambda inside the VPC, and this VPC has no NAT by design — so it also needs a Secrets Manager interface endpoint at ~$7/mo, more than the database costs at rest | ~$7/mo + 0.5d |
| **WAF on the distribution** | Every route already declares a token-bucket rate-limit class ([ADR 0020](../adr/0020-rate-limiting.md)) and the origin scales to one small instance. Real, but not yet worth the monthly floor | ~$8/mo + 0.25d |
| **Stop using the account root user** | An IAM admin (`friendszone-deploy`) now exists and is what deploys. Root still has no MFA, which is the remaining gap | 10 min, console only |
| **IAM database authentication** | Already **enabled** on the cluster; the application still connects with the password from Secrets Manager. Moving to short-lived tokens is now an application change, not a migration | 0.5d |

**CloudFront access logging is deliberately off and is not on this list.** An
access log records the concrete request URI, and this API's URIs carry the
subject's identity — `/api/v1/users/<uuid>/calendar`. [Data
classification](../security/data-classification.md) is explicit that what may
be logged is the *route pattern*, never the concrete id, so enabling that
control would breach the rule it appears to serve.

**Cost:** low single-digit dollars a month idle.

---

## Phase 1 — The things that make it safe to invite strangers (5–8 days)

Everything here is a real gap, and each has been named in an ADR or a threat
model row rather than discovered late.

### Email delivery (2 days) — *unblocks three other things*

SES, behind a `MailerPort` shaped like the existing `NotifierPort`. This is the
keystone: **password reset**, **registration verification**, and **digest
notifications** are all blocked on it, and the first two are the difference
between a demo and a product.

- Password reset ([ADR 0024](../adr/0024-authentication.md) names its absence).
  Until it exists, a forgotten password is an unrecoverable account.
- Registration verification, which closes the enumeration gap the same ADR
  records as open.

### Photos to S3 (1.5 days)

Currently `bytea` in Postgres ([ADR 0004](../adr/0004-persistence.md) flags it).
Presigned `PUT` for upload; the serving route keeps re-authorising through the
listing, because **a key is not a capability** and a public S3 URL would undo
that. Object storage is also where the cost curve is right.

### Shared rate-limit store (1 day)

Buckets are per-process ([ADR 0020](../adr/0020-rate-limiting.md)): N instances
means N× the limit. `RateLimiter` has one method precisely so this is an adapter
— ElastiCache Serverless, or a Postgres table while volume is low.

### Backups, and a restore you have actually done (0.5 days)

Automated snapshots are the easy half. **Restoring one into a scratch database
and pointing a local API at it** is the half that finds out whether they work.
An untested backup is a hope.

### Observability (1 day)

Structured logs already carry a request id and no sensitive fields. Add: metrics
for 4xx/5xx rate, p95 latency, database connections, and an alarm on the error
rate. Enough to know something is wrong before a user says so.

### Legal surface (1 day, mostly not code)

Privacy policy and terms. The [data classification](../security/data-classification.md)
and [ADR 0022](../adr/0022-export-and-deletion.md) already say precisely what is
collected and what deletion does, which is most of the work — this is
transcription, not discovery.

---

## Phase 2 — The product gaps a stranger will notice (2–3 days)

Not safety-critical. Each is something a new user will trip over in the first ten
minutes.

| Gap | Days | Why it matters |
|---|---|---|
| ~~Friend requests~~ | ~~2~~ | **Done** — [ADR 0028](../adr/0028-friend-requests-and-blocking.md) |
| ~~Unfriending and blocking~~ | ~~1.5~~ | **Done** — and blocks turned out to need to be *directed*, which the schema had wrong |
| ~~User search~~ | ~~1~~ | **Done** — bounded, `EXPENSIVE`-classed, and blind to a blocked pair |
| **Empty states and onboarding** | 1 | A new account is an empty week with nothing to do |
| **Mobile layout pass** | 1.5 | The week grid has a `min-width: 44rem` and a phone does not |

> The largest functional hole in the product is closed. The policy kernel had
> handled `PENDING` and `BLOCKED` correctly since the foundation pass; what was
> missing was every route and button that could produce one. Building them
> surfaced a real bug — `blocks` was stored as one canonically-ordered row per
> pair, so the first unblock in a mutual block would have silently lifted the
> other party's protection. That is now two rows, with a conformance test on
> both adapters.

---

## Phase 3 — Release (2–3 days)

| Step | Days |
|---|---|
| Security review pass against [the checklist](../security/review-checklist.md) | 1 |
| Load test: a few hundred concurrent sessions, watch p95 and connections | 0.5 |
| Runbook: how to restart, roll back, restore, and revoke a session | 0.5 |
| Staged invite — 10 people, then 100 | 0.5 |

**GA exit criteria**, all of which are checkable rather than felt:

- [ ] A stranger can sign up, find a friend, share a calendar, and delete their
      account without help
- [ ] Password reset works end to end
- [ ] A backup has been restored into a scratch environment
- [ ] Error-rate alarm has fired at least once in anger (induce it)
- [ ] No ⛔ rows in [the threat model](../security/threat-model.md); every ⚠️ has
      a named owner and a date
- [ ] Privacy policy matches what the code actually does

---

## Timeline

| | Days | Cumulative |
|---|---|---|
| Phase 0 — cloud | 3 | 3 |
| Phase 1 — safe for strangers | 8 | 11 |
| Phase 2 — product gaps | 7 | 18 |
| Phase 3 — release | 3 | 21 |
| **Incidentals at 30%** | 6 | **27** |

**≈ 27 focused days.** Calendar time depends entirely on how many of those days
a week you get.

### About that 30%

It is not padding, it is the work this plan cannot name in advance:

- Things found by real users in Phase 0 that must be fixed before Phase 3.
- The small feature that turns out to be load-bearing (a timezone bug in the
  slot finder's hour bounds is the one I would bet on — it is a known
  single-timezone approximation).
- Dependency updates, a CVE, a flaky test.
- The ADR that has to be written because a decision turned out to be expensive
  to reverse.

A plan with no room for this is a plan that reports itself on schedule until the
week it is three weeks late.

---

## Deliberately after GA

Named so they do not creep in: **recurring events** (XL, its own ADR and its own
release — [the roadmap](roadmap.md) is emphatic), **social login** (the credential
model is shaped for it, [ADR 0024](../adr/0024-authentication.md)), **MFA**,
**calendar import**, **field-level encryption** of 🟠 Sensitive columns
([ADR 0004](../adr/0004-persistence.md)), and **native mobile apps** — the client
is a responsive SPA and should stay one until there is a reason it cannot be.
