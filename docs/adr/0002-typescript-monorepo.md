# 0002. TypeScript monorepo with npm workspaces

**Status:** Accepted
**Date:** 2026-07-20

## Context

Friendszone needs a server, eventually a web client, and shared domain logic that
both must agree on. The privacy rules in particular must be identical
everywhere - a client that renders a "private" event differently from how the
server projects it is a bug factory.

The environment has Node 24 and npm 11. pnpm is not installed.

## Decision

A single TypeScript monorepo using **npm workspaces** and **TypeScript project
references**.

Strict compiler settings, including several that are load-bearing for security
rather than style:

| Flag | Why it is not optional here |
|---|---|
| `strict` | Baseline. |
| `noUncheckedIndexedAccess` | `array[i]` is `T \| undefined`. Caught a real bug in the busy-merge loop. |
| `exactOptionalPropertyTypes` | `{ location: undefined }` and "no location" are different things in a projection. |
| `noFallthroughCasesInSwitch` | The authorization engine is a large `switch`. Fallthrough there is a privilege escalation. |
| `verbatimModuleSyntax` | Type-only imports never survive into runtime code. |

Most authorization logic is an exhaustive `switch` over a union. These flags are
what turn "you forgot a case" into a compile error rather than a silent grant.

## Consequences

- One `npm install`, one `tsc --build`, one `vitest run` for everything.
- Project references mean `packages/policy` genuinely cannot import from
  `apps/api` - the layering is enforced by the compiler, not by a lint rule
  someone can disable.
- Strictness costs some ceremony (conditional spreads for optional fields, the
  `AnyRoute` erasure in the route registry). Both are commented where they occur.
- npm workspaces are slower and less strict about phantom dependencies than
  pnpm. Accepted for zero-setup onboarding; revisit if the tree grows.

## Alternatives considered

**Separate repositories.** Guarantees drift between client and server on exactly
the rules that must not drift.

**pnpm workspaces.** Better hoisting discipline and faster. Rejected only
because it is not installed here and requiring a global install before `npm
install` works is a bad first five minutes. Worth revisiting.

**Nx / Turborepo.** Real benefits at ten packages. At three, the config costs
more than the caching saves.
