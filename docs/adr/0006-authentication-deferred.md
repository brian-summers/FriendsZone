# 0006. Defer authentication, fail closed meanwhile

**Status:** Accepted
**Date:** 2026-07-20
**Implemented by:** [ADR 0024](0024-authentication.md) (2026-08-01). This record
stands as written — it is the reason the deferral was safe, and the constraint
list below is what 0024 was held to. One item, Argon2id, was deviated from
deliberately and is argued there.

## Context

The foundation pass had to choose between building authentication and building
the authorization and privacy model. Doing both properly in one pass would have
meant doing neither properly.

Authentication is well-trodden: sessions, password hashing, recovery flows, MFA.
The solutions are known and the risk of getting it wrong is mostly the risk of
being careless. Friendszone's *authorization* model — a four-level visibility
lattice with per-event ceilings and circle-scoped audiences — is novel to this
product, is the reason the product exists, and is where an original mistake is
most likely.

So authorization went first. The question then becomes how to leave the
authentication hole without it becoming a deployed vulnerability.

## Decision

Do not implement authentication yet. Make its absence **structurally
undeployable**:

1. `createAuthenticator()` **throws** when `NODE_ENV=production`. The process
   exits at boot. There is no flag to override it.
2. The development shortcut (`x-dev-actor-id`) is gated behind that same check —
   not behind a separate convention someone could forget.
3. Even the dev shortcut validates its input as a `UserId`, so a malformed id
   never reaches the policy engine to be compared against real owner ids.
4. A repeated header is refused rather than resolved. Header smuggling depends
   on two parties disagreeing about which duplicate wins.

A skeleton that silently authenticates everyone as user 1 is worse than no
skeleton at all: the first is a vulnerability that looks like a feature, the
second is an obvious gap.

## Consequences

- The API cannot be deployed to production. Deliberate, and it is a test:
  `server.test.ts › refuses to construct in production`.
- Every authorization path is exercisable today by setting one header, which
  made the policy engine testable end to end in the first pass.
- Whoever implements authentication must satisfy:
  - Sessions in `HttpOnly`, `Secure`, `SameSite=Lax` cookies — never
    `localStorage`, which is readable by any XSS.
  - Session id rotation on login and on any privilege change.
  - Argon2id for password hashing.
  - Constant-time credential comparison, and identical response timing and
    wording for "no such account" and "wrong password" — otherwise the login
    form becomes an account-enumeration oracle, which matters more here than in
    most products because account existence is itself social information.
  - Rate limiting and lockout on credential endpoints.
  - Credentials stored separately from `User`, per
    [data classification](../security/data-classification.md).

## Alternatives considered

**A minimal session implementation now.** "Minimal auth" in a foundation pass
becomes production auth by inertia, and nobody revisits it because it appears to
work.

**Delegate to an identity provider (Auth0, Clerk, WorkOS).** Genuinely
reasonable and still on the table — it would satisfy every constraint above out
of the box. Deferred rather than rejected: it is a vendor commitment, and making
it in the same pass as the domain model would have been two large decisions at
once.

**Ship a dev-mode header with a warning comment.** This is what we did, minus
the part where a comment is the only thing standing between the header and
production. The boot-time throw is the difference.
