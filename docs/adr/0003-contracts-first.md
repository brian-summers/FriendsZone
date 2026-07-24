# 0003. Contracts-first domain modelling with Zod

**Status:** Accepted
**Date:** 2026-07-20

## Context

Domain types need to exist in three places at once: TypeScript types at compile
time, runtime validators at the network edge, and eventually a database schema.
The usual outcome is three definitions that agree on the day they are written
and diverge quietly thereafter. When the drifting field is `visibilityCeiling`,
the divergence is a privacy failure.

There is a second force specific to this project. An agent asked to "add a field
to events" will edit whatever definition it finds first. If there are three, it
finds one.

## Decision

Every domain concept is defined **once**, as a Zod schema, in
`packages/contracts`. TypeScript types are inferred with `z.infer`, never
hand-written alongside.

```ts
export const CalendarEvent = z.object({ /* ... */ });
export type CalendarEvent = z.infer<typeof CalendarEvent>;
```

Two further rules:

**Branded ids.** `UserId`, `ListingId`, and friends are nominal types. A
`ListingId` will not type-check where a `UserId` is expected, even though both
are strings at runtime. This is cheap and it eliminates a whole class of
authorization bug where the wrong id is threaded into a permission check.

**Validate, do not sanitise.** User text is stored raw and escaped at render
time. Sanitising on write destroys the original and drifts out of sync with
whatever the renderer actually does. Length caps *are* enforced on write,
because those are a denial-of-service control rather than a formatting opinion.

## Consequences

- One place to add a field; no possibility of validator/type disagreement.
- Runtime validation is available anywhere, so the boundary between "parsed" and
  "raw" is explicit and enforceable.
- Zod's inferred types get hard to read in error messages for deeply composed
  schemas. Tolerable.
- Branded types need `as` casts in fixtures. Confined to `testing.ts`.
- Zod is pinned to v3. v4 moves several validators to top-level functions; the
  migration is mechanical but should be its own ADR and its own commit, not a
  drive-by during a feature.

## Alternatives considered

**Hand-written interfaces plus separate validators.** The status quo everywhere,
and precisely the drift this decision exists to prevent.

**io-ts / Effect Schema.** More principled, materially steeper learning curve —
which matters when a contributor may be an agent working from the repo alone.

**Generate types from the database schema.** Inverts the dependency: the domain
model ends up shaped by storage concerns, and `packages/policy` would transitively
depend on the database. The policy engine must stay pure — see
[ADR 0005](0005-policy-engine.md).
