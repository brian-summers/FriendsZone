# Documentation map

## Start here

| If you want to… | Read |
|---|---|
| Understand the system | [architecture/overview.md](architecture/overview.md) |
| Change anything in `packages/policy` | [architecture/visibility-and-privacy.md](architecture/visibility-and-privacy.md) - **normative** |
| Add a feature | [playbooks/add-a-feature.md](playbooks/add-a-feature.md) |
| Review a diff | [security/review-checklist.md](security/review-checklist.md) |
| Know what we are defending against | [security/threat-model.md](security/threat-model.md) |
| Know why something is the way it is | [adr/](adr/) |

## Product and design

- [Roadmap](product/roadmap.md) - feature expansion, cost at scale, and the
  anti-features we are refusing on purpose
- [Design system](design/design-system.md) - palette, typography, motion, voice
- [Interface design](design/interface.md) - screen-level decisions

## Architecture

- [Overview](architecture/overview.md) - layers, request lifecycle, key flows
- [Domain model](architecture/domain-model.md) - entities, lifecycles, invariants
- [Visibility and privacy](architecture/visibility-and-privacy.md) - the
  normative spec for the projection algorithm

## Security

- [Threat model](security/threat-model.md) - assets, STRIDE, abuse cases
- [Authorization model](security/authz-model.md) - how `can()` is meant to be used
- [Data classification](security/data-classification.md) - tiers, logging rules,
  retention
- [Review checklist](security/review-checklist.md) - per-change gates

## Decisions

[All ADRs](adr/README.md) · [0001](adr/0001-record-architecture-decisions.md)
· [0002](adr/0002-typescript-monorepo.md) · [0003](adr/0003-contracts-first.md)
· [0004](adr/0004-persistence.md) · [0005](adr/0005-policy-engine.md)
· [0006](adr/0006-authentication-deferred.md)
· [0007](adr/0007-async-by-design.md)
· [0008](adr/0008-slot-finder-on-projections.md)
· [0009](adr/0009-cache-the-input.md) · [0010](adr/0010-hangout-resolution.md)
· [0011](adr/0011-tentative-holds.md) · [0012](adr/0012-hangout-lifecycle.md)
· [0013](adr/0013-floating-and-open-to-conflict.md)
· [0014](adr/0014-event-editing-and-sharing-editor.md)
· [0015](adr/0015-overlap-by-default-and-drag-to-create.md)
· [0016](adr/0016-cross-calendar-drag-and-multi-day-events.md)
· [0017](adr/0017-claim-modes-and-deadlines.md)
· [0018](adr/0018-reporting-and-moderation.md) · [0019](adr/0019-the-handoff.md)
· [0020](adr/0020-rate-limiting.md) · [0021](adr/0021-sharing-presets.md)
· [0022](adr/0022-export-and-deletion.md)
· [0023](adr/0023-circle-management.md) · [0024](adr/0024-authentication.md)
· [0025](adr/0025-durable-file-store.md) · [0026](adr/0026-sql-layer.md)
· [0027](adr/0027-deploy-on-aws.md)
· [0028](adr/0028-friend-requests-and-blocking.md)
· [0029](adr/0029-direct-messages-and-discoverability.md)
· [0030](adr/0030-full-day-grid-and-quiet-hours.md)
· [0031](adr/0031-rls-request-scope.md)
· [0032](adr/0032-quiet-hours-bind-every-proposal.md)

## Conventions for these documents

**Normative** documents (`visibility-and-privacy.md`) specify behaviour. Code
and tests must match them, and changing one means changing all three in the same
commit.

**Descriptive** documents (`overview.md`, `domain-model.md`) explain the
present. Keep them current, but they are not a contract.

**ADRs** are immutable. Supersede, never rewrite - the trail is the value.
