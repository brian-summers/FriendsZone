# Playbook: add a feature

A repeatable order of operations. Following it means the security-relevant
decisions get made before the code that depends on them exists, rather than
being retrofitted onto a working feature — which is when they get skipped.

Written to be executable by an agent as well as a person.

## 0. Decide whether this needs an ADR

Write one first if the change is expensive to reverse, introduces a dependency,
or would make a reader ask "why on earth is it like this?".

## 1. Contracts first

Add or extend schemas in [`packages/contracts`](../../packages/contracts/src/).

- One Zod schema per concept; infer the TypeScript type, never hand-write it.
- Branded ids for anything that identifies an entity.
- Cap the length of every user-supplied string. Unbounded text is a DoS vector.
- Classify each new field against
  [data classification](../security/data-classification.md) and add it to the
  field reference table.

**Stop and ask** if the feature seems to need a new visibility level or a
negative audience ("everyone except…"). Both are load-bearing refusals, not
gaps — see [the visibility spec](../architecture/visibility-and-privacy.md).

## 2. Policy next

Extend [`packages/policy`](../../packages/policy/src/).

1. Add the member to `Action` and `ACTION_REGISTRY`.
2. Add a `PolicyRequest` variant taking a `Pick<>` of **only** the fields the
   decision needs. The signature is documentation of what is security-relevant.
3. Handle it in `can()`. Start from deny; add affirmative grants.
4. If it is a read that returns records, decide whether it also needs per-record
   projection. The coarse gate is not a filter.

## 3. Tests before the route

In `packages/policy/src/*.test.ts`: the allow path, and **every** deny path.

The `ALL_ACTIONS` backstop catches a *missing* test, not a shallow one. Aim to
make a reviewer confident by reading the test names alone.

## 4. Repository ports

Add methods to the port interfaces in
[`apps/api/src/repositories/ports.ts`](../../apps/api/src/repositories/ports.ts),
then implement them in the memory adapter.

Ports return **raw, unfiltered rows**. Filtering belongs to the policy engine;
splitting it across both means two places to audit and two places to get wrong.

## 5. Route last

Add to `apps/api/src/routes/`, using `defineRoute`.

- `authz` is required. If `PUBLIC`, write a justification that would survive
  review, and update the allowlist assertion in `routes.test.ts` deliberately.
- Zod schemas for `params` and `query`; branded ids.
- Bound every list and range.
- Call `ctx.viewerFor(ownerId)` **inside** the handler, per owner. Never hoist a
  viewer context or reuse one across owners.
- Register it in `buildRoutes`.

## 6. Integration test

In `apps/api/src/server.test.ts`, via `app.inject`. At minimum:

- the happy path for an authorised viewer;
- an unauthorised viewer gets an answer **indistinguishable** from "nonexistent";
- a blocked viewer gets exactly what a stranger gets;
- malformed input yields `400` with a bare code;
- serialised output does not contain sensitive strings — assert on
  `response.body`, not just the parsed object.

## 7. Documentation

- Touched `packages/policy`? Update
  [visibility-and-privacy.md](../architecture/visibility-and-privacy.md) **in the
  same commit**.
- New surface or new data? Update
  [the threat model](../security/threat-model.md).
- New entity or lifecycle? Update
  [the domain model](../architecture/domain-model.md).

## 8. Verify

```bash
npm run verify        # tsc --build && vitest run
```

Then walk [the security review checklist](../security/review-checklist.md).

## Anti-patterns

Things that look reasonable in a diff and are not:

| ❌ | ✅ |
|---|---|
| `return { ...event }` in a projection | Whitelist each field per level |
| Authorization logic in a route handler | `can()` in `packages/policy` |
| One `ViewerContext` reused across owners | `ctx.viewerFor(ownerId)` per owner |
| `403` for a resource the viewer shouldn't know exists | `404`, via `denialToResponse` |
| `hiddenCount` in a response | Nothing. A count is a disclosure. |
| `log.info({ event })` | `log.info({ status, route })` |
| Unbounded list or range endpoint | An explicit, tested cap |
| A new `catch` that swallows a `PolicyDeniedError` | Let it reach `errorToResponse` |
