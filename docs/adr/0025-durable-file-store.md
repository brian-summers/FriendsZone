# 0025. A durable file-backed store, as an honest interim before Postgres

**Status:** Superseded by [ADR 0004](0004-persistence.md) /
[ADR 0026](0026-sql-layer.md), 2026-08-02 - the same day.
**Date:** 2026-08-02

> This ADR existed for a few hours, under the constraint that no new dependency
> could be taken on. That constraint was lifted, PostgreSQL was implemented, and
> this store was deleted - which is exactly what the Consequences section below
> told the next person to do. It is kept as the record of a decision made and
> reversed, and of *why* the reversal was cheap: the ports never changed.

## Context

Everything is in memory. A restart loses every event, listing, report, and
session - which, now that [ADR 0024](0024-authentication.md) has removed the
production boot guard, is the single thing making the API undeployable.

[ADR 0004](0004-persistence.md) specifies PostgreSQL with row-level security,
and it is still the right destination: the social graph is relational, accepting
a hangout writes several rows that must commit together, and `eventsInWindow` is
an overlap query that wants a GiST index on `tstzrange`.

**PostgreSQL needs a driver, and a driver is a dependency.** This repo has three
runtime dependencies - Fastify, Zod, React - and adding one is a decision the
project's owner should make deliberately rather than one taken in passing while
solving a different problem. So this ADR does the part that needs no
permission: it makes data survive a restart, using only `node:fs`, without
foreclosing anything.

## Decision

**A single-process, file-backed store: snapshot on write, atomic replace.**

### What it is

The existing in-memory adapters keep their semantics - they are the ones 481
tests are written against. Each grows a `snapshot()`, and
`createMemoryRepositories` accepts a full snapshot to start from. A wrapper
loads the file at boot, and writes it back after any mutating call.

Writes are **atomic**: serialise to `<file>.tmp`, `fsync`, then `rename` over
the target. A rename within a filesystem is atomic, so a crash mid-write leaves
either the old file or the new one, never half of one. The cost is that the last
few hundred milliseconds of writes can be lost on a hard kill - a debounce
window traded against writing the whole store on every keystroke.

### What it is *not*

Stated plainly so nobody mistakes this for the thing ADR 0004 asks for:

- **No transactions.** Accepting a hangout writes several rows; a crash between
  them leaves a partial plan. The debounce makes this less likely and not
  impossible.
- **No concurrency.** One process, one writer. Two instances pointed at one file
  will corrupt each other - the second one to flush wins and silently discards
  the first's work.
- **No range index.** `eventsInWindow` is a linear scan. Fine for a demo, wrong
  at any size.
- **No row-level security.** ADR 0004 wants RLS as a backstop *behind* the policy
  engine. A JSON file cannot have one, so the kernel is currently the only layer
  - which it always was, but with no second net under it.
- **It does not scale past one box**, which is the same shape of constraint the
  rate limiter and the session store already carry.

The ports do not change. Postgres remains a swap of one line in `index.ts`.

### Restricted data now touches disk

This is the part that deserves a reviewer's attention, because it moves data
across a boundary [data classification](../security/data-classification.md)
previously said it never crossed: password hashes, session token hashes, and
email addresses are now written to a file.

- The file is created `0600` - owner read/write only.
- It sits in a configured `DATA_DIR`, which should not be inside the repository
  or anything served statically. The default is `.data/`, and `.gitignore`
  covers it.
- **Encryption at rest is the deployment's job** (an encrypted volume), not this
  layer's. Field-level encryption of 🟠 Sensitive columns is still outstanding
  and still belongs with the Postgres work, where ADR 0004 already argues it.

The hashes are scrypt and SHA-256 respectively, so the file is not a plaintext
credential dump. It is still the most sensitive artefact the project produces
and should be treated like one.

### Durability is opt-in, and its absence is loud

`DATA_DIR` unset means in-memory, which is what every test wants. But an API
that silently forgets everything in production is worse than one that refuses to
start, so **production without `DATA_DIR` is a boot failure** - the same posture
as the rate limiter and the session secret.

### A missed method is a durability bug, so the compiler and a test catch it

The wrapper must know which port methods mutate. That list is written out
explicitly rather than inferred from names, and a test asserts **every method on
every port is classified** as reading or mutating. A new port method fails that
test rather than silently not persisting - the same backstop shape as
`ALL_ACTIONS`.

## Consequences

- The API can be deployed and keep data. That is the point.
- The whole store is serialised on every flush. That is `O(total data)` per
  write batch and will become the reason to finish ADR 0004, which is a
  perfectly good forcing function.
- Photo bytes live in the same file, base64-encoded, which inflates it by a
  third. Object storage is the real answer and is called out in ADR 0004's
  successor work.
- `.data/` must be excluded from backups that are less protected than the
  database would be.
- **ADR 0004 stays Proposed.** Whoever picks it up should treat this as the
  thing to delete, not the thing to extend.

## Alternatives considered

**Add `pg` and write the Postgres adapter now.** The right destination, and it
adds a runtime dependency plus a database to run, migrate, and back up. Left to
the project's owner to choose deliberately - and the schema work is the same
either way, so nothing here is wasted.

**SQLite via `node:sqlite`.** Genuinely tempting: transactions, indexes, no
dependency in recent Node. Rejected for now because ADR 0004 already considered
and rejected SQLite for this product on the grounds that migrating off it later
"is exactly the kind of work that never gets scheduled" - and a file-backed
store nobody could mistake for a database is *less* likely to become permanent
than a real one that almost works.

**Append-only journal with periodic compaction.** Better write amplification and
a real recovery story. More machinery than an interim deserves; if this outlives
its welcome, that is the first upgrade.
