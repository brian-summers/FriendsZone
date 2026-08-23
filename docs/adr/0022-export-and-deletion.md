# 0022. An export is a projection; deletion erases, tombstones, and keeps three things

**Status:** Accepted
**Date:** 2026-08-01

## Context

Account export and deletion is a Tier 0 obligation - legally, and as
[the roadmap](../product/roadmap.md) puts it, "the honest counterpart to a
privacy-first pitch". A product that argues this hard about what friends can see
of each other looks silly if a user cannot get their own data out or make it
stop existing.

It is also no longer a small feature. A user now touches events, sharing
defaults, hangouts, listings, photographs, claims, handoffs, reports they filed,
reports filed *about* them, moderation correspondence, notifications, circles,
friendships, and blocks. Several of those records are **shared with another
person**, and two of them exist precisely to protect people from the user doing
the deleting.

Two constraints are already fixed and pull against naive erasure:

- [ADR 0004](0004-persistence.md) commits that **blocks are never hard-deleted**;
  a one-way hash of the pair is retained.
- [ADR 0018](0018-reporting-and-moderation.md) captures **evidence snapshots** so
  a report survives the subject deleting the material.

## Decision

### An export is a projection, not a database dump

Every section of an export is built by the **same projection functions the API
already uses**: `projectEvent`, `projectListing`, `projectReportForReporter`,
`projectReportForSubject`, `projectExchange`.

This is the whole security design, and it is nearly free because the
architecture already forces it. The property it buys:

> **An export can never contain more than the user could already read.**

The case that makes it concrete: a report filed *about* you appears in your
export through `projectReportForSubject`, which carries no `reporterId`, no
`detail`, and no filing timestamp. Exporting the stored `Report` row instead
would hand a reported person the identity of whoever reported them, in a
downloadable file, as a *privacy feature*. That is the single worst thing this
feature could do, and it is the obvious implementation.

Anything genuinely private to the user that has no projection - their own
sharing defaults, their own claim messages - is exported directly, because they
are its author and sole audience.

### Deletion erases, then tombstones

The user row is not removed. It is **emptied and marked deleted**: id retained,
every human-meaningful field cleared, handle released, display name replaced with
a neutral placeholder.

Removing the row outright would dangle every foreign reference in the product -
a hangout Bob still has, an exchange Carol is party to, a moderation case - and
dangling references in a system whose safety depends on resolving ids correctly
is how a deleted user's data reappears attached to the wrong person. A tombstone
keeps every join resolvable and every join *empty*.

What is destroyed outright: events, sharing defaults, listings and their photo
bytes, claims, notifications, and circle rosters they owned.

### The counterparty's copy is not yours to delete

A hangout or handoff writes **one event per participant, each owned by that
participant**. Deleting your account removes yours. It does not reach into
someone else's calendar and delete theirs.

Their copy is their record of their own week. It survives, showing a tombstoned
name - the same way a photograph you are in stays in someone else's album when
you close your account. Any other rule lets one person quietly rewrite another's
history, and a "delete everything I ever touched" button is a weapon in exactly
the disputes this product's safety features exist for.

### Three things survive, each for a stated reason

1. **Blocks, as a one-way hash of the pair.** Already committed in
   [ADR 0004](0004-persistence.md). If deletion cleared blocks, deleting and
   re-registering would be a documented way to reach someone who blocked you.
   The hash is not reversible into a user list; it answers "is this pair
   blocked" and nothing else.

2. **Live moderation cases about you.** An open report and its evidence survive
   the subject's deletion. Otherwise deletion is an escape hatch from
   moderation: harass someone, get reported, delete, and the case evaporates.
   This is the recognised "rights of others" limit on erasure, not a convenience.
   Once a case is **closed**, the evidence is erased on the ordinary schedule.

3. **Reports you filed, with your identity already tombstoned.** The case
   continues for the person it protects; the subject still never learns who
   filed it, because they never could. Anonymity does not lapse when a reporter
   leaves.

### Deletion is immediate, irreversible, and confirmed by typing

No grace period. A "deleted, restorable for 30 days" account is an account whose
data still exists, and saying "deleted" when data is retained is the kind of
claim this product should not make. The cost is that a mistaken deletion is
unrecoverable, which is why it costs typing your handle rather than clicking
once.

Deletion is a `POST` with the handle in the body. A `DELETE /v1/me` with an empty
body is one mis-scoped fetch away from firing.

## Consequences

- Export must be regenerated whenever a projection changes, or it silently drifts
  from what the API returns. A test asserts the export of a reported user
  contains no reporter identity; that is the one that must never be deleted.
- Every port grows an erase method. The memory adapter implements them; the
  eventual Postgres adapter must, and RLS makes that easier rather than harder.
- A tombstoned user still appears in other people's history as a neutral name.
  Some users will expect their name to vanish from a friend's past calendar. It
  does not, and the reason is above.
- Export is bounded like every other read and draws from the `EXPENSIVE` bucket:
  it is the single most fan-out-heavy call in the product.
- **Not built here:** anything that re-identifies a tombstone, and any
  "download will be emailed to you" flow, which needs email delivery that does
  not exist yet.

## Alternatives considered

**Dump the raw rows.** Simpler, faster, and it leaks the reporter of every report
filed about the user. Rejected on the strength of that one case alone.

**Hard-delete the user row.** Dangling references across five entity types in a
system where a mis-resolved id is a privacy incident.

**Cascade-delete everything the user participated in.** Deletes other people's
calendars and other people's moderation cases. A griefing tool.

**A 30-day restoration window.** Standard, kinder to mistakes, and it means
"deleted" is not true for a month. If it is ever added it must be named
"scheduled for deletion" in the interface.
