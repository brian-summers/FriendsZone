# 0001. Record architecture decisions

**Status:** Accepted
**Date:** 2026-07-20

## Context

Friendszone will be built largely with AI assistance. That changes what
documentation is for.

A human returning to unfamiliar code carries residual memory - they half-recall
that the odd-looking thing was deliberate. An agent starting a session carries
none. It reads the code, sees something that looks like an oversight, and
"fixes" it. The most dangerous version of this is security logic, where the
correct implementation frequently looks redundant: a friendship re-checked
against a circle roster, a block checked before a grant, a 404 where a 403 would
be more informative.

Undocumented rationale does not merely get lost. It gets actively reversed.

## Decision

Record every non-obvious decision as an ADR. Emphasise **why**, and especially
why the plausible alternative was rejected.

Additionally: inline comments in this repo explain rationale, not mechanics.
`// increment i` is noise. `// friendship is re-checked because unfriending does
not scrub circle rosters` is the difference between code that survives a
refactor and code that quietly stops protecting anyone.

## Consequences

- Changing a decision costs a new ADR. Intended friction.
- A reviewer - human or agent - can answer "was this intentional?" without
  archaeology.
- Some ADRs will document things that later seem obvious. Acceptable: the ones
  that seem obvious in hindsight are usually the ones that were re-litigated.

## Alternatives considered

**A single ARCHITECTURE.md.** Becomes a description of the present with no
memory of what was rejected, and merge-conflicts constantly.

**Rely on commit messages and PR descriptions.** They are keyed to the moment of
change, not the topic, and neither an agent nor a new contributor reads git log
before editing a file. The rationale needs to sit next to the thing it explains.
