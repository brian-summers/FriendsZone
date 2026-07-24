# Data classification and handling

Four tiers. The tier decides what may be logged, cached, or sent to a third
party — the questions that actually come up in a code review.

## Tiers

### 🔴 Restricted — never leaves the process boundary

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
| `CalendarEvent.title` | 🟠 | "Oncology, 2pm" |
| `CalendarEvent.description` | 🟠 | |
| `CalendarEvent.location` | 🟠 | Physical location of a person at a known time |
| `Exchange.location` / `.timeRange` | 🟠 | A named person, a place, a time |
| `Block` | 🟠 | Disclosure triggers escalation |
| `CalendarEvent.timeRange` | 🟡 | Free/busy, once stripped of detail |
| `Friendship`, `Circle.memberIds` | 🟡 | Graph structure |
| `Circle.name` | 🟡 | Owner-only; "Reluctant Work Friends" |
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
