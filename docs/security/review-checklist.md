# Security review checklist

Use this on any change touching routes, policy, contracts, or repositories. It
is written to be usable by a human reviewer or an agent asked to review a diff.

Findings marked 🚫 are blocking.

## Always

- [ ] 🚫 No secret, token, or credential in code, tests, fixtures, or logs.
- [ ] 🚫 No 🟠 Sensitive data in a log line — see
      [data classification](data-classification.md). Watch for `log.info({ event })`.
- [ ] Errors returned to clients carry a bare code, never a message, stack, or
      driver detail.
- [ ] New config is added to `ConfigSchema` and validated at boot, not read
      inline with a `??` fallback.

## New or changed route

- [ ] 🚫 `authz` is declared and correct.
- [ ] 🚫 If `PUBLIC`: is it genuinely safe unauthenticated? Does the
      justification say something real? Is the allowlist in `routes.test.ts`
      updated deliberately?
- [ ] `params` and `query` have Zod schemas. Ids use branded types.
- [ ] Any list or range endpoint is bounded (page size, window length).
- [ ] The handler calls `ctx.viewerFor(ownerId)` *inside* the handler, per
      owner. A context hoisted or reused across owners is a leak.
- [ ] 🚫 For reads: is per-record filtering applied, or does the coarse gate
      wrongly stand in for it?
- [ ] Does the response differ observably between "forbidden" and "nonexistent"?
      It must not.

## New or changed policy logic

- [ ] 🚫 Does the change start from deny and add affirmative grants, or does it
      add a fallback that grants?
- [ ] 🚫 Is the block check still evaluated before any grant?
- [ ] `assertNever` still present in every default branch.
- [ ] Tests cover the allow path **and every deny path**.
- [ ] If `BLOCK_EXEMPT_ACTIONS` grew: is there a proof the response carries no
      data? 🚫 if not.
- [ ] [`visibility-and-privacy.md`](../architecture/visibility-and-privacy.md)
      updated in the same commit.

## New field on an entity

- [ ] What tier is it? Add it to the
      [field reference](data-classification.md#field-reference).
- [ ] 🚫 Does it appear in a projection by accident? Check for `...spread` in
      `projection.ts`.
- [ ] If it should be visible only at `FULL`, is the `TITLE` key assertion in
      `projection.test.ts` still passing *and still correct*?
- [ ] Does it need a length cap? Unbounded user text is a DoS vector.

## New dependency

- [ ] Is it necessary? `packages/policy` takes no dependencies but
      `@friendszone/contracts` — 🚫 on anything else.
- [ ] Maintained, reasonable transitive tree, no install scripts doing network I/O.
- [ ] Pinned to a range you have actually looked at.

## Before production

Currently unmet. Track these as launch blockers:

- [ ] Authentication implemented ([ADR 0006](../adr/0006-authentication-deferred.md))
- [ ] Postgres with row-level security ([ADR 0004](../adr/0004-persistence.md))
- [ ] Rate limiting on reads, writes, and any enumeration surface
- [ ] Field-level encryption for 🟠 event titles, descriptions, locations
- [ ] Reporting and moderation flow — a prerequisite for the exchange feature
- [ ] Audit log for privileged and administrative access
- [ ] Retention jobs implemented per
      [data classification](data-classification.md#retention)
- [ ] Dependency and secret scanning in CI
