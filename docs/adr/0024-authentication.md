# 0024. Sessions in hashed cookies, scrypt instead of Argon2id, and a shape that admits social login

**Status:** Accepted
**Date:** 2026-08-01
**Implements:** the deferral in [ADR 0006](0006-authentication-deferred.md),
which stays Accepted as the record of *why* this waited.

## Context

[ADR 0006](0006-authentication-deferred.md) deferred authentication and made its
absence structurally undeployable: `createAuthenticator()` throws when
`NODE_ENV=production`, so the process exits at boot. That was correct while the
authorization model was the risky, novel work. It is now the single thing
standing between this codebase and a deployment.

ADR 0006 also left a constraint list for whoever implemented it. This ADR
satisfies that list, and deviates from exactly one item, deliberately and with
an argument.

## Decision

### Sessions are opaque tokens, stored hashed, carried in a cookie

A session token is 256 bits from `crypto.randomBytes`, base64url-encoded. What
is **stored is its SHA-256 hash**, never the token itself.

This is the detail most often skipped, and it is the difference between a leaked
session table being an incident and being a catastrophe: an attacker who reads
the store gets hashes they cannot present as credentials. A session token is a
bearer credential, so it deserves the same treatment a password gets.

The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever
`PUBLIC_ORIGIN` is https. Never `localStorage`, which any XSS can read — ADR 0006
is explicit about that and it is the whole reason for the cookie.

Rotation: **a new session on every login**, and every other session revoked on
password change. Expiry is absolute — 30 days — not sliding, because a sliding
window means a stolen token stays alive as long as it is used.

**CSRF** is covered by two things together: `SameSite=Lax` stops cross-site
cookie-bearing POSTs, and every mutating route requires `content-type:
application/json`, which an HTML form cannot send. Neither alone is enough;
together they cover the browser cases without a token round-trip.

### scrypt, not Argon2id — the one deviation

ADR 0006 requires Argon2id. This ships **scrypt** from `node:crypto`, at
`N=2^16, r=8, p=1`.

The reason is dependency shape, not cryptography. Every Argon2id implementation
for Node is a native module (`node-gyp` or a napi prebuild). This repo has three
runtime dependencies in total — Fastify, Zod, React — and putting a compiled
binary on the password path adds a supply-chain surface and an install failure
mode to the most security-sensitive code we have. scrypt is memory-hard, is in
the standard library, and is explicitly listed by OWASP as the acceptable
alternative when Argon2id is unavailable.

The parameters are the second tier of OWASP's table rather than the first
(`N=2^17`). At `N=2^16, r=8` each hash costs roughly 64 MB, and per-hash memory
is itself a denial-of-service surface on a single-process server: `2^17` would
double it to ~128 MB per concurrent login. Login is rate-limited
([ADR 0020](0020-rate-limiting.md)) which bounds concurrency, and that pairing is
what makes this tier defensible rather than a shortcut. **If the limiter is ever
removed from the credential routes, these parameters become a liability.**

Argon2id remains preferred. The hash format is stored self-describing
(`scrypt$N$r$p$salt$hash`), so a future migration can verify old hashes and
re-hash on next successful login without a flag day.

### Login does not reveal whether an account exists. Registration does.

Account existence is social information in this product, so login is fully
non-enumerable:

- Identical response body and status for "no such email" and "wrong password".
- **A dummy hash is computed when the user is unknown**, so the two paths cost
  the same wall-clock time. Without it, the absence of a ~100 ms hash is a
  perfectly good oracle.
- Both are the same rate-limit bucket, so probing costs the same either way.

**Registration is not, and this is a known gap.** Telling a user "that email is
already registered" reveals an account; not telling them makes the form
unusable, because they cannot tell success from silent failure. The real fix is
an email that says "someone tried to register with your address", which requires
mail delivery this product does not have. Until then registration is
hard-rate-limited and the gap is recorded in
[the threat model](../security/threat-model.md) rather than glossed.

Handle collisions **are** reported, and that leaks nothing: handles exist to be
searched for, and the directory already answers whether one is taken.

### The credential model admits social login without a migration

Credentials are an `AuthIdentity` keyed by `(provider, subject)`, not a password
column on `User`:

| Provider | `subject` | `secretHash` |
|---|---|---|
| `PASSWORD` | normalised email | scrypt hash |
| `GOOGLE` | the provider's `sub` | absent |

One user may hold several. Adding Google means adding a provider and an OAuth
callback that resolves to an identity — no change to `User`, to sessions, or to
anything downstream. Deliberately **not** built here: OAuth needs a client
secret, a redirect allowlist, and state/PKCE handling, and bolting it on beside
a first password implementation is two large surfaces at once.

Email lives on the identity, not on `User`. ADR 0003's `User` comment already
promises "no password hash, no email, no phone", and that promise is what keeps
an accidentally-serialised `User` from being a contact leak.

### The dev header survives, outside production only

457 existing tests authenticate with `x-dev-actor-id`. It stays, gated on
`NODE_ENV !== 'production'` exactly as before, and is now checked *after* the
session cookie rather than instead of it.

ADR 0006's boot refusal is removed — that was the point of it — but the property
it protected is kept and now has its own test: **in production the dev header is
ignored entirely**, whatever it contains.

## Consequences

- The API can be deployed. That is the headline, and it means every other
  deferred decision (persistence, above all) is now the thing in the way.
- `authenticate` becomes async, because a session is a lookup. `server.ts` awaits
  it before building any viewer context.
- Sessions are in memory, so **every restart logs everyone out**, and N instances
  do not share sessions. Same shape of problem as the rate limiter, same fix:
  the port has three methods so a Redis or Postgres adapter is a swap.
- Password *reset* is not built. It needs mail delivery. Until it exists a
  forgotten password is an unrecoverable account, which is honest and bad, and
  is the next thing to build after email.
- No MFA. The shape allows it (a second factor on the identity) and it is out of
  scope for a first implementation.

## Alternatives considered

**Delegate to Auth0 / Clerk / WorkOS.** ADR 0006 called this "genuinely
reasonable and still on the table". It remains so, and it is a vendor commitment
that puts the identity of every user in a third party — for a product whose pitch
is that it holds as little as possible about you. Revisit if operating this
becomes the bottleneck rather than the point.

**JWTs instead of server-side sessions.** Stateless, and revocation becomes a
denylist that is a session store wearing a disguise. Logout must work
immediately; a stateless token cannot do that honestly.

**Argon2id via a WASM build.** No native toolchain, and a materially larger
audit surface than `node:crypto`. Worth revisiting when a well-maintained one is
obvious; the stored hash format is ready for it.

**Magic links only, no passwords.** Genuinely attractive — no password to leak —
and it requires mail delivery, which is the dependency this ADR is routing
around. Reconsider once email exists; the identity model already allows it as
another provider.
