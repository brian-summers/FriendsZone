# 0018. Reports are in-app records with two one-way threads; email only points at them

**Status:** Accepted
**Date:** 2026-07-31

## Context

Reporting and moderation is the Tier 0 obligation that
[the roadmap](../product/roadmap.md) names as the prerequisite for the exchange
handoff, and [ADR 0017](0017-claim-modes-and-deadlines.md) deferred that handoff
explicitly waiting on this. Things now ships user-authored text and user-supplied
photographs to other people. That is the surface that needs a way to report
someone.

The obvious starting point - and the one proposed - is an email address:
`reports@friends-zone.app`. It is cheap and needs no product surface at all.

It also cannot do most of what is being asked for, and it is worth being precise
about why rather than dismissing it:

1. **Email is unauthenticated.** A `From:` header is a claim, not a credential.
   A report arriving by mail has no verified reporter, so "do not reveal the
   accuser" has no accuser to protect and no way to reach them for follow-up
   that isn't equally forgeable.
2. **It moves the most sensitive data we hold *out* of the system.** A useful
   report quotes the offending material - event titles, claim messages, photos.
   Mailing that to an inbox copies 🟠 Sensitive content into a mail spool,
   somebody's phone, and a backup, all outside the projection model that the rest
   of the product is built around.
3. **Evidence does not survive.** The reported party can delete a listing the
   moment they suspect a report. If the record lives in a mailbox, the moderator
   is looking at a description of something that no longer exists.
4. **Two-way follow-up in a mail thread leaks by construction.** A reply-all, a
   quoted signature, or a forwarded message and the accuser is exposed. The
   requirement is that this be structurally impossible, not carefully avoided.

## Decision

**The report is an in-app record. Email carries a pointer to it and nothing
else.**

### The notification is content-free

When a report is filed, one message goes to the moderation address:

```
Subject: [Friendszone] New report a3f2c9d1
Body:    A report was filed. Reason: HARASSMENT. Subject type: LISTING.
         Review it in the moderation queue.
```

No names. No titles. No message text. No photographs. Not the reporter, not the
reported. The email exists so a human knows to go and look; everything worth
knowing is behind an authenticated moderation page. An address that is
accidentally forwarded, archived, or breached leaks a reason code and a UUID.

### Evidence is snapshotted at report time

Filing a report captures an immutable `EvidenceSnapshot` - the text fields and
photo keys of the reported material, as they were at that instant.

This does two jobs, and the second is the one that matters more:

- The record survives the subject deleting or editing the material.
- **It bounds moderator access precisely.** A moderator can read the snapshot
  attached to a report. They *cannot* read the live listing, the subject's
  calendar, or anything else. There is no moderator master key, and the
  visibility lattice has no moderator exemption. What was reported is what can be
  seen - which also means a moderator cannot go fishing, and a compromised
  moderator account is worth the reports it can open rather than the database.

### Moderators are a deployment allowlist, not a user role

`MODERATOR_IDS` is a config value, validated at boot like everything else, and
surfaced to the kernel as `ViewerContext.isModerator`.

Deliberately *not* a field on `User`: a role on the profile is one careless
projection away from being public, and one write endpoint away from being
self-assignable. A value that only changes by redeploying cannot be escalated to
through the API at all.

`ViewerContext.isModerator` is **required**, not optional. An omitted boolean
that defaults to `false` would be fail-closed and fine; an omitted boolean is
also invisible in review. Making every construction site name it means the
compiler asks the question.

### Two threads, one direction each

A report carries `ReportNote`s, and every note is stamped with the party it
belongs to: `REPORTER` or `SUBJECT`.

- The reporter sees only `REPORTER` notes.
- The subject sees only `SUBJECT` notes.
- The moderator sees both and is the only path between them.

There is no shared thread, so there is no message that both parties can read and
no reply that can cross over. This is the mechanism behind "follow up without
revealing the accuser": it is not a rule moderators must remember, it is a shape
the data cannot take. `projectReport` builds each party's view from a filter on
that stamp, and the tests assert the cross-party case directly.

The residue we cannot remove: a moderator writes free text, and a moderator can
type a name into it. No schema prevents that. What the system guarantees is that
it never *composes* one - no quoting, no "reported by", no attribution anywhere
in the payload sent to a subject.

### The subject is not told a report exists

Until a moderator opens a thread with them, a reported user learns nothing.

This is not politeness, it is the same oracle problem the rest of the product
fights. "You have been reported" delivered promptly, to someone who just argued
with one person, identifies the reporter as reliably as naming them. Notification
is a moderator's deliberate act, at a time of their choosing, and it carries the
reason category rather than the report.

### Reporting is not an enumeration oracle

You may only report material you can already see. Reporting something outside
your audience and reporting something that does not exist return the identical
404 - otherwise `POST /v1/reports` becomes a probe for whether a given id exists,
which is exactly the disclosure `denialToResponse` exists to prevent everywhere
else.

One open report per reporter per subject, so the queue cannot be flooded by one
person and a report count never becomes a popularity signal.

### Dispositions are records, plus the one enforcement that exists

`OPEN → AWAITING_INFO → UPHELD | DISMISSED`.

Upholding a report about a listing can **take it down** - that enforcement is
real because listings are ours to unpublish. There is deliberately no ban, no
suspension, and no account action: with [ADR 0006](0006-authentication-deferred.md)
outstanding there are no accounts to suspend, and a `banned: true` column that
nothing enforces is worse than an honest gap, because it looks like a control.

## Consequences

- The handoff gated in [ADR 0017](0017-claim-modes-and-deadlines.md) now has its
  prerequisite. Building it is a separate decision and a separate ADR; this one
  does not unblock it automatically.
- `ViewerContext` grows a field, so every construction site in the repo has to
  name it. That churn is the intended cost of not having a defaultable flag.
- Snapshots duplicate content, and duplicated content has to be deleted when a
  user exercises erasure. Account deletion must reach report evidence - noted in
  [data classification](../security/data-classification.md) retention.
- Moderators cannot see context around reported material, only the material. That
  will feel restrictive and it is the point; widening it means designing an audit
  trail first.
- Email delivery is a port with a logging adapter. No SMTP credential exists yet,
  so in development a report prints a pointer to the log.

## Alternatives considered

**Email as the record of truth.** The proposal above. Rejected for the four
reasons in Context - chiefly that it cannot authenticate a reporter and cannot
keep two parties apart in one thread.

**A shared moderator↔parties thread with names redacted.** Redaction is a
negative control, and negative controls fail open: one un-redacted quote is a
permanent disclosure to the person most motivated to act on it. Two threads fail
closed, because there is no shared object to leak.

**A moderator role on `User`, with a self-serve admin UI.** Deferred until real
authentication exists. Escalation to a role stored in the database is a
meaningfully different threat model from escalation to a value in a deploy
config, and the second is the one we can defend today.

**Auto-hiding content on first report.** A free denial-of-service against any
user: report a rival's listing, it disappears. Takedown stays a human decision.
