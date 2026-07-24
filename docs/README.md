# Documentation map

## Start here

| If you want to… | Read |
|---|---|
| Understand the system | [architecture/overview.md](architecture/overview.md) |
| Change anything in `packages/policy` | [architecture/visibility-and-privacy.md](architecture/visibility-and-privacy.md) — **normative** |
| Add a feature | [playbooks/add-a-feature.md](playbooks/add-a-feature.md) |
| Review a diff | [security/review-checklist.md](security/review-checklist.md) |
| Know what we are defending against | [security/threat-model.md](security/threat-model.md) |
| Know why something is the way it is | [adr/](adr/) |

## Product and design

- [Roadmap](product/roadmap.md) — feature expansion, cost at scale, and the
  anti-features we are refusing on purpose
- [Design system](design/design-system.md) — palette, typography, motion, voice
- [Interface design](design/interface.md) — screen-level decisions

## Architecture

- [Overview](architecture/overview.md) — layers, request lifecycle, key flows
- [Domain model](architecture/domain-model.md) — entities, lifecycles, invariants
- [Visibility and privacy](architecture/visibility-and-privacy.md) — the
  normative spec for the projection algorithm

## Security

- [Threat model](security/threat-model.md) — assets, STRIDE, abuse cases
- [Authorization model](security/authz-model.md) — how `can()` is meant to be used
- [Data classification](security/data-classification.md) — tiers, logging rules,
  retention
- [Review checklist](security/review-checklist.md) — per-change gates

## Decisions

[All ADRs](adr/README.md) · [0001](adr/0001-record-architecture-decisions.md)
· [0002](adr/0002-typescript-monorepo.md) · [0003](adr/0003-contracts-first.md)
· [0004](adr/0004-persistence.md) · [0005](adr/0005-policy-engine.md)
· [0006](adr/0006-authentication-deferred.md) · [0007](adr/0007-async-by-design.md)
· [0008](adr/0008-slot-finder-on-projections.md) · [0009](adr/0009-cache-the-input.md)

## Conventions for these documents

**Normative** documents (`visibility-and-privacy.md`) specify behaviour. Code
and tests must match them, and changing one means changing all three in the same
commit.

**Descriptive** documents (`overview.md`, `domain-model.md`) explain the
present. Keep them current, but they are not a contract.

**ADRs** are immutable. Supersede, never rewrite — the trail is the value.
