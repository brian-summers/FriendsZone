# Deploy on AWS

One CloudFront distribution in front of an S3 bucket (the client) and a
container (the API), with Postgres behind it. Rationale and the alternatives
that lost: [ADR 0027](../adr/0027-deploy-on-aws.md).

```mermaid
flowchart LR
    dns(["friends-zone.app"]) --> cf["CloudFront"]
    cf -->|"/api/*"| app["App Runner"]
    cf -->|"/*"| web[("S3 - built client")]
    app --> db[("Aurora Serverless v2")]
    app --> photos[("S3 - listing photos")]
```

**Two things to avoid, because they are most of the idle bill:** a NAT Gateway
(~$32/mo) and an Application Load Balancer (~$16/mo). Neither is needed at this
size, and neither appears below.

---

## It is now infrastructure as code

The console walkthrough below is kept because it explains *why* each setting is
what it is, and that reasoning is the valuable part. **The actual deployment
lives in [`infra/`](../../infra/)** as a CDK app, and that is what should be
run:

```bash
cd infra && npm install
npx cdk synth --strict          # cdk-nag runs here; findings block the deploy
npx cdk deploy FriendszoneData      # VPC, Aurora, secrets, ECR
# build and push the image (see below), then:
npx cdk deploy FriendszoneService   # App Runner, S3, CloudFront
```

Two stacks, split on **state**. `FriendszoneData` holds the only copy of every
user's calendar and carries `terminationProtection`; `FriendszoneService` is
rebuildable from this repository in minutes.

### Three things that bit during the first real deploy

- **Pin an engine version the region actually has.** `VER_16_6` exists in the
  CDK enum and does not exist in `us-east-2`. The stack rolled back ten minutes
  in. Check with `aws rds describe-db-engine-versions --engine aurora-postgresql`.
- **`RETAIN` leaves orphans that block the retry.** After the rollback, the ECR
  repository, the DB subnet group and the session secret survived, and each
  collided by name on the next attempt. Delete them, or the retry fails for a
  reason unrelated to the original fault.
- **No em dashes in CloudFormation descriptions.** A security group description
  containing one fails template validation with a regex error that does not
  mention the character.

### Four more that bit, all at the edge

- **App Runner routes on `Host`.** CloudFront's `ALL_VIEWER` origin-request
  policy forwards the viewer's Host, so App Runner's Envoy saw
  `d1xxx.cloudfront.net`, did not recognise it, and answered **404 with an
  empty body** before the container was consulted. It looks exactly like a
  missing route. The only tell is `Server: envoy` in the response headers. Use
  `ALL_VIEWER_EXCEPT_HOST_HEADER`.
- **CloudFront does not strip the path prefix.** The client calls
  `/api/v1/me`; the API serves `/v1/me`. `originPath` only *prepends*, so a
  CloudFront Function has to remove it.
- **Do not write a regex inside a CDK inline function.** The code is a
  TypeScript template literal, which eats the backslash in `\/` - `/^\/api/`
  synthesised to `/^/api/`, a syntax error CloudFront accepts at deploy time
  and fails on at request time with a bare 503. Use `indexOf`/`substring`, and
  check it with `aws cloudfront test-function` before trusting it.
- **`errorResponses` are distribution-wide.** Mapping 404 to `/index.html` with
  status 200 for SPA routing also rewrote every API denial - and this API
  answers *denied* with 404 by design. Scope the fallback to the client
  behaviour with a function instead.

### The two-pass deploy, and why it is not a mistake

App Runner needs `PUBLIC_ORIGIN` to set the session cookie's `Secure` flag;
CloudFront needs App Runner's URL as its origin. That is a genuine cycle.
It is resolved by deploying twice rather than by a custom resource:

```bash
npx cdk deploy FriendszoneService                                  # pass 1, placeholder
npx cdk deploy FriendszoneService -c publicOrigin=https://<dist>   # pass 2, real
```

A custom resource that reaches in and mutates a running service's environment
would hide the cycle rather than resolve it.

---

## What is actually deployed

| | |
|---|---|
| Client + API | `https://d1xuqpfc4zouut.cloudfront.net` |
| Region | `us-east-2` (Agent Toolkit pinned to `us-east-1`) |
| Database | Aurora Serverless v2 PostgreSQL 17.10, **0-2 ACU**, encrypted, 7-day backups |
| API | App Runner `friendszone-api`, 0.25 vCPU / 0.5 GB, VPC egress, `/readyz` health check |
| NAT gateways | **0** |
| Deploy identity | IAM user `friendszone-deploy`, not root |
| Budget | $40/mo, alerts at 50% actual and 100% forecast |

---

## 0. Before anything

```bash
npm run verify        # typecheck + 665 tests
npm run build:web     # → apps/web/dist
```

A deploy from a tree that does not pass `verify` is a deploy you cannot reason
about later.

---

## 1. Database - Aurora Serverless v2, minimum 0 ACU

RDS Console → Create database → **Aurora (PostgreSQL Compatible)** → Serverless
v2.

| Setting | Value | Why |
|---|---|---|
| Capacity range | **0 – 2 ACU** | Zero minimum means an idle database costs storage only. This is the single most important setting on the page |
| Public access | No | The API reaches it over the VPC connector |
| Encryption | Enabled | Default, and the answer to "encryption at rest" in [data classification](../security/data-classification.md) |
| Backups | 7 days | Phase 1 of [the road to GA](../product/road-to-ga.md) says restore one before you rely on it |

> The 12-month RDS free tier is deliberately **not** used. It expires, and a
> deployment that becomes expensive on a date nobody wrote down is worse than
> one that costs a little from the start.

Note the cluster endpoint. The connection string is
`postgres://USER:PASS@ENDPOINT:5432/friendszone`.

**Cold starts:** at 0 ACU the first query after idle takes a few seconds. That is
the right trade while evaluating and the wrong one once people are using it -
raise the minimum to 0.5 ACU at that point.

---

## 2. Secrets - SSM Parameter Store

Standard parameters are free; `SecureString` uses the free AWS-managed key.

```bash
aws ssm put-parameter --name /friendszone/SESSION_SECRET --type SecureString \
  --value "$(openssl rand -base64 48)"
aws ssm put-parameter --name /friendszone/DATABASE_URL --type SecureString \
  --value "postgres://USER:PASS@ENDPOINT:5432/friendszone"
```

Never in the task definition, never in the image, never in git.

---

## 3. API - App Runner

```bash
aws ecr create-repository --repository-name friendszone-api
docker build -t friendszone-api .
docker tag friendszone-api:latest "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/friendszone-api:latest"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/friendszone-api:latest"
```

App Runner → Create service → from ECR.

| Setting | Value |
|---|---|
| Port | `8080` |
| Health check | `/readyz` - readiness, not `/healthz`. See below |
| CPU / memory | 0.25 vCPU / 0.5 GB to start |
| VPC connector | The database's VPC and subnets |
| Environment | `NODE_ENV=production`, `PUBLIC_ORIGIN=https://friends-zone.app`, `TRUSTED_PROXY_HOPS=1`, `MODERATOR_IDS=<your user id>` |
| Secrets | `SESSION_SECRET`, `DATABASE_URL` from SSM |

**`TRUSTED_PROXY_HOPS=1` matters.** `request.ip` feeds the anonymous rate-limit
bucket. Left at 0 behind CloudFront, every anonymous caller shares one bucket and
one abuser rate-limits everybody. Set higher than the number of proxies you
actually run and a caller can spoof `X-Forwarded-For` to mint a fresh bucket per
request.

**`/readyz`, not `/healthz`.** Liveness says the process is up and decides
whether to *restart* it; readiness says the database answers and decides whether
to send traffic. Point a health check at the wrong one and a container whose
database blinks gets restarted into the same condition, in a loop.

The schema applies itself on boot - every statement is `if not exists`
([ADR 0026](../adr/0026-sql-layer.md)) - so there is no migration step yet.

---

## 4. Client - S3

```bash
aws s3 mb s3://friendszone-web
aws s3 sync apps/web/dist s3://friendszone-web --delete
```

**Block all public access** and leave it blocked. CloudFront reaches the bucket
through Origin Access Control; a publicly readable bucket is a second, unguarded
front door.

---

## 5. CloudFront - one distribution, two behaviours

This is the part that matters most, and the part easiest to get subtly wrong.

**Default behaviour** `/*` → the S3 origin (via OAC)
  - Viewer protocol: redirect HTTP → HTTPS
  - Cache policy: `CachingOptimized`
  - Custom error responses: **403 and 404 → `/index.html` with status 200**, so
    a deep link and a hard refresh reach the client's router

**Behaviour** `/api/*` → the App Runner origin
  - Cache policy: **`CachingDisabled`**
  - Origin request policy: `AllViewerExceptHostHeader` - the API needs the
    `Cookie` header, and a policy that strips it silently signs everyone out
  - Allowed methods: **all** - `GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE`

> **Caching must be off for `/api/*`.** Every API response already carries
> `cache-control: no-store`, but a CDN behaviour that caches by default is one
> misconfiguration away from serving one viewer's calendar projection to
> another - which would defeat the entire privacy model. Set it explicitly and
> treat a change to it as a security review.

One distribution serving both is what keeps the client and API **same-origin**.
That is not cosmetic: `apps/web/src/lib/api.ts` says there is no CORS
configuration anywhere in this product, and splitting the hostnames would
require one and would break `SameSite=Lax` on the session cookie
([ADR 0024](../adr/0024-authentication.md)).

---

## 6. Domain

ACM certificate in **`us-east-1`** - CloudFront reads certificates only from
there, whatever region the rest of the stack is in. Attach it, add
`friends-zone.app` as an alternate domain name, and point DNS at the
distribution.

DNS can stay on Cloudflare or move to Route 53; both are fine and it is
reversible in an afternoon. Everything else Cloudflare was doing here has been
removed ([ADR 0027](../adr/0027-deploy-on-aws.md)).

---

## 7. Verify the deployment, not just the deploy

```bash
curl -s https://friends-zone.app/healthz                     # {"status":"ok"}
curl -s https://friends-zone.app/readyz                      # {"status":"ready"} - proves the DB
curl -sI https://friends-zone.app/api/v1/me | grep -i \
  -e content-security-policy -e strict-transport -e cache-control
```

Then, by hand, the things a smoke test cannot assert:

- [ ] Register an account; confirm the session cookie is `Secure` and `HttpOnly`
- [ ] Sign out, sign back in
- [ ] Create an event; hard-refresh a deep link and confirm the SPA fallback works
- [ ] Restart the App Runner service and confirm you are **still signed in** -
      sessions are in Postgres, not memory
- [ ] Two accounts: confirm one cannot see the other's private event

---

## Cost, honestly

| | Idle | Light use |
|---|---|---|
| Aurora Serverless v2 (0 ACU min) | ~$1–3 (storage) | ~$10–20 |
| App Runner (0.25 vCPU) | ~$5 | ~$5–15 |
| S3 + CloudFront | ~$0 (always-free tier) | ~$0–2 |
| **Total** | **~$6–8/mo** | **~$15–35/mo** |

No NAT Gateway, no ALB. If the bill is materially higher than this, one of those
two has appeared - check first.

---

## Scaling, when it is needed

In rough order, and none of it is a re-architecture:

1. **Aurora minimum off 0** - kills cold starts. One number.
2. **App Runner instances up** - it autoscales; raise the ceiling.
3. **Shared rate-limit store** - buckets are per-process, so N instances means
   N× the limit ([ADR 0020](../adr/0020-rate-limiting.md)). `RateLimiter` has one
   method so this is an adapter. **Do this before step 2 goes past one instance.**
4. **Photos to S3** - they are in a `bytea` column today
   ([ADR 0004](../adr/0004-persistence.md)). Right for cost and right for the
   database.
5. **Aurora read replica** - the projection path is read-heavy.
