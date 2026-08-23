# Architecture decision records

One file per decision. They are immutable once accepted: to change a decision,
write a new ADR that supersedes the old one, and update the old one's status.
The value is in the trail, not in any single file being current.

Write one when a choice would be expensive to reverse, when a reasonable person
would ask "why on earth is it like this?", or when you rejected an option that
someone will inevitably re-propose.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-typescript-monorepo.md) | TypeScript monorepo with npm workspaces | Accepted |
| [0003](0003-contracts-first.md) | Contracts-first domain modelling with Zod | Accepted |
| [0004](0004-persistence.md) | PostgreSQL with row-level security | Accepted — implemented, query layer in [0026](0026-sql-layer.md) |
| [0005](0005-policy-engine.md) | Authorization as a pure security kernel | Accepted |
| [0006](0006-authentication-deferred.md) | Defer authentication, fail closed meanwhile | Accepted — implemented by [0024](0024-authentication.md) |
| [0007](0007-async-by-design.md) | No presence, no read receipts, ever | Accepted |
| [0008](0008-slot-finder-on-projections.md) | The slot finder runs on projections, not raw calendars | Accepted |
| [0009](0009-cache-the-input.md) | Cache the input, never the output | Proposed |
| [0010](0010-hangout-resolution.md) | Hangout requests resolve 1:1, acceptance books both calendars | Accepted |
| [0011](0011-tentative-holds.md) | Pending hangouts appear as participant-scoped tentative holds | Accepted |
| [0012](0012-hangout-lifecycle.md) | Hangouts stay editable after acceptance; notifications are records | Accepted |
| [0013](0013-floating-and-open-to-conflict.md) | Floating hangouts and open-to-conflict events | Accepted |
| [0014](0014-event-editing-and-sharing-editor.md) | Events are editable; the per-event and default sharing editors are real | Accepted |
| [0015](0015-overlap-by-default-and-drag-to-create.md) | Overlap by default (exclusive opt-out); drag-to-create | Accepted |
| [0016](0016-cross-calendar-drag-and-multi-day-events.md) | Drag on any calendar (friend's → request); multi-day events | Accepted |
| [0017](0017-claim-modes-and-deadlines.md) | Things are claimed by one of three modes, against one deadline | Accepted |
| [0018](0018-reporting-and-moderation.md) | Reports are in-app records with two one-way threads; email only points at them | Accepted |
| [0019](0019-the-handoff.md) | The handoff is proposed and accepted, and shows third parties only Busy | Accepted |
| [0020](0020-rate-limiting.md) | Token buckets at the edge, declared per route, in process memory | Accepted |
| [0021](0021-sharing-presets.md) | Three account presets, none of them Full, and "never chose" is a state | Accepted |
| [0022](0022-export-and-deletion.md) | An export is a projection; deletion erases, tombstones, and keeps three things | Accepted |
| [0023](0023-circle-management.md) | A circle is owner-only, keeps ex-friends, and scrubs its rules when deleted | Accepted |
| [0024](0024-authentication.md) | Sessions in hashed cookies, scrypt instead of Argon2id, a shape that admits social login | Accepted |
| [0025](0025-durable-file-store.md) | A durable file-backed store, as an honest interim before Postgres | Superseded by [0004](0004-persistence.md) / [0026](0026-sql-layer.md) |
| [0026](0026-sql-layer.md) | Raw SQL behind a two-method client, tested against real Postgres | Accepted |
| [0027](0027-deploy-on-aws.md) | One origin on AWS; Cloudflare drops to DNS or nothing | Accepted |
| [0028](0028-friend-requests-and-blocking.md) | A request is a pending friendship; blocks are directed, so unblocking cannot lift theirs | Accepted |
| [0029](0029-direct-messages-and-discoverability.md) | Messages are a mailbox with no read receipts; discoverability has no friends-of-friends | Accepted |

## Template

```markdown
# NNNN. Title

**Status:** Proposed | Accepted | Superseded by [NNNN](NNNN-x.md)
**Date:** YYYY-MM-DD

## Context
What forces are at play? What makes this a decision rather than an obvious call?

## Decision
What we are doing, stated in the active voice.

## Consequences
What becomes easy. What becomes hard. What we accept as a cost.

## Alternatives considered
What else was on the table, and the specific reason it lost.
```
