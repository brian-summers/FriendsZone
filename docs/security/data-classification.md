# Data classification and handling

Four tiers. The tier decides what may be logged, cached, or sent to a third
party — the questions that actually come up in a code review.

## Tiers

### 🔴 Restricted — never leaves the process boundary, except to its own store

**Amended 2026-08-02.** With [ADR 0004](../adr/0004-persistence.md) these values
are stored in PostgreSQL. They leave the process only to the database, and they
are stored **hashed** — scrypt for passwords, SHA-256 for session tokens — never
in the clear. They still never reach a log, an error, or a projection.

Two things remain outstanding and are named in ADR 0004: **encryption at rest**
is the deployment's responsibility (an encrypted volume or a managed instance
that provides it), and **field-level encryption** of 🟠 Sensitive columns —
event titles, descriptions, locations — is not yet implemented.

Credentials, session tokens, `SESSION_SECRET`, password reset tokens.

- Never logged, not even redacted-adjacent (no "token starts with…").
- Never in an error message, including validation errors. `loadConfig()`
  reports *which* variable failed, never its value.
- Never in an analytics event, a crash report, or a URL.

### 🟠 Sensitive — disclosure can cause physical or personal harm

Event titles, descriptions, locations; exchange locations and times; block
relationships; a user's full event list.

- **Never logged.** Log the structured `DenyReason` and the route, never the
  resource.
- Never cached by a shared cache — every response carries
  `cache-control: no-store`.
- Only ever leaves the server through `projectEvent()`.
- Requires field-level encryption at rest before production. Not implemented;
  a database compromise currently discloses this tier.

### 🟡 Internal — meaningful only in context

Free/busy intervals, friendship existence, circle membership, handles of
non-public users, listing contents.

- May appear in aggregate metrics, never per-user.
- Ids may be logged; content may not.

### 🟢 Public — safe by design

`PublicProfile` (id, handle, display name, avatar), events explicitly shared
`PUBLIC`, health check output.

Still rate-limit. Public does not mean bulk-harvestable.

## Field reference

| Field | Tier | Notes |
|---|---|---|
| `SESSION_SECRET`, tokens | 🔴 | Never logged, never in errors |
| `AuthIdentity.secretHash` | 🔴 | scrypt hash. No view type includes it, which is the control — there is nothing to forget to strip |
| `AuthIdentity.subject` (email) | 🔴 | Lives on the identity, never on `User`, so an accidentally-serialised `User` is not a contact leak |
| `Session.tokenHash` | 🔴 | The **hash**, never the token. A dump yields values that cannot be presented |
| `CalendarEvent.title` | 🟠 | "Oncology, 2pm" |
| `CalendarEvent.description` | 🟠 | |
| `CalendarEvent.location` | 🟠 | Physical location of a person at a known time |
| `Exchange.location` / `.timeRange` | 🟠 | A named person, a place, a time — the most sensitive row the product writes. Never leaves the two parties: booked events cap third parties at `BUSY` ([ADR 0019](../adr/0019-the-handoff.md)) |
| `Listing.photoKeys` → stored bytes | 🟠 | A photo of a possession, often taken indoors at home. Served only through a listing the viewer can see, never by key alone |
| `Claim.claimantId` | 🟠 | Who wants what someone owns. Disclosed to the listing owner alone — never to fellow claimants, not even as a count |
| `Claim.message` | 🟠 | Free text to one specific person |
| `Message.body` | 🟠 | Free text between two named people. **Never logged**, never in an error, and never previewed to anyone but the two parties |
| `Conversation.lowReadAt` / `.highReadAt` | 🟠 | Each party's own read bookmark. Projected to *its owner* and to nobody else — disclosing it to the sender is a read receipt, which [ADR 0029](../adr/0029-direct-messages-and-discoverability.md) refuses |
| `User.discoverability` | 🟠 | Private configuration. Appears on `MeView` and on no projection that reaches another person: "why can't I find them" is an answer about them |
| `Report.reporterId` | 🔴 | **Never** reaches the subject, at any status. Disclosure invites retaliation against someone who asked for help |
| `Report.detail` | 🟠 | The reporter's own words, which routinely identify them. Moderators only |
| `ReportNote.body` | 🟠 | Scoped to one thread; the other party never receives it |
| `EvidenceSnapshot` | 🟠 | A frozen copy of reported material. Moderator-only, and the reason account deletion must reach report evidence |
| `Block` | 🟠 | Disclosure triggers escalation. Directed, so `blockedBy` answers only *your* rows — there is no endpoint, anywhere, for "who blocked me" ([ADR 0028](../adr/0028-friend-requests-and-blocking.md)) |
| `Friendship.status = 'PENDING'` | 🟠 | Shown to the two parties only. A declined request is **deleted**, so "waiting" and "turned down" are the same observable state |
| `CalendarEvent.timeRange` | 🟡 | Free/busy, once stripped of detail |
| `Friendship`, `Circle.memberIds` | 🟡 | Graph structure |
| `Friendship.requestedBy` | 🟡 | Which of the two asked. Both parties already know; it is what stops a sender accepting their own request |
| `Circle.name` | 🟡 | Owner-only; "Reluctant Work Friends" |
| `Listing.title` / `.description` | 🟡 | Exists to be browsed by the chosen audience. Deliberately *not* encrypted — search is core to the feature (see roadmap) |
| `Report.reason` / `.status` | 🟡 | The category and where it is up to; shown to both parties |
| `Listing.claimMode` / `.claimsCloseAt` | 🟡 | The terms of the offer; shown to everyone who can see the listing, because they are what a claimant is agreeing to |
| `User.timeZone` | 🟡 | Coarse location signal |
| `PublicProfile` | 🟢 | |

## Logging rules

Concrete, because "be careful with logs" is not an implementable rule.

**Allowed:** request id, route pattern (`/v1/users/:ownerId/calendar`, not the
filled-in path), HTTP status, duration, `DenyReason`, actor id, error class
names.

**Forbidden:** event titles/descriptions/locations, listing contents, message
bodies, handles of non-public users, raw request bodies or query strings, whole
entity objects (`log.info({ event })` — the next field someone adds to
`CalendarEvent` is then live in the log pipeline).

The request id is generated server-side via `crypto.randomUUID()` rather than
echoing a client header, because a client-controlled value in a log field is log
injection.

## Retention

**Account deletion** ([ADR 0022](../adr/0022-export-and-deletion.md)) destroys
events, sharing defaults, listings and their photo bytes, claims, notifications,
and owned circle rosters, then tombstones the profile — id retained, every field
emptied — so foreign references stay resolvable and resolve to nothing.

Three things deliberately survive, and the interface says so rather than glossing
it: **blocks** (never cleared, or delete-and-rejoin defeats them), **live
moderation cases** about the departing user (or deletion is an escape hatch from
moderation), and **other participants' copies** of shared plans, which are their
records of their own weeks.

Not yet implemented; needed before real users.

| Data | Target |
|---|---|
| Cancelled/past events | User-configurable, default 12 months |
| Expired hangout requests | 90 days |
| Completed exchanges | 12 months |
| Blocks | Indefinite — expiring a block re-exposes the person it protects |
| Logs | 30 days |
| Deleted account | 30-day grace, then hard delete except blocks, which persist as one-way hashes so evasion stays hard |

That last row is the one with a real tension in it: honouring deletion fully
would let a harasser clear their blocks by deleting and recreating an account.
Retaining a one-way hash of the block pair keeps the protection without
retaining the person's data.
