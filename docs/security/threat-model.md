# Threat model

Scope: the Friendszone application as designed in this repository. Revisit this
document whenever a new capability is added, and specifically whenever a change
touches the calendar projection, the social graph, or the exchange flow.

## What we are actually protecting

Ranked by how badly a breach hurts a real person, not by how interesting it is
technically.

| Asset | Why it matters | Where it lives |
|---|---|---|
| **Calendar patterns** | Reveals where someone is, when, and when their home is empty. The single most dangerous dataset here. | `CalendarEvent`, free/busy projections |
| **Social graph** | Who knows whom, and the shape of someone's circles. Enables targeted pretexting. | `Friendship`, `Circle`, `Block` |
| **Block relationships** | Learning you have been blocked reliably triggers escalation and evasion. | `Block` |
| **Exchange meetups** | A specific person, at a specific place, at a specific time. | `Exchange` |
| **Event content** | Titles and locations: "oncology appointment", "AA meeting". | `CalendarEvent.title`, `.location` |
| **Credentials/session** | Account takeover yields everything above. | Credential store (not yet built) |

The recurring theme: this product's worst-case failure is not financial. It is
enabling someone to physically locate a person who is avoiding them.

## Trust boundaries

```
  Internet
     │
     ▼  ── boundary 1: untrusted input, unauthenticated by default
 ┌──────────────┐
 │  apps/api    │  parses, authenticates, shapes errors
 └──────┬───────┘
        │  ── boundary 2: only ViewerContext + entities cross
 ┌──────▼───────────────┐
 │  packages/policy     │  pure. no I/O. cannot be tricked by a fetch
 └──────┬───────────────┘
        │  ── boundary 3: ports; raw rows in, nothing sensitive out
 ┌──────▼───────┐
 │ repositories │
 └──────────────┘
```

Boundary 2 is the interesting one. Because the policy engine performs no I/O, an
attacker cannot influence a decision by poisoning a cache the engine consulted
on its own — every input is explicit and supplied by the caller. It also means
an auditor can read the whole security kernel in one sitting.

## STRIDE

| | Threat | Mitigation | Status |
|---|---|---|---|
| **S** | Session theft / fixation | Signed, `HttpOnly`, `SameSite` cookies; rotation on privilege change | ⛔ not built — [ADR 0006](../adr/0006-authentication-deferred.md) |
| **S** | Forged `x-dev-actor-id` in production | Authenticator refuses to construct when `NODE_ENV=production`; process exits at boot | ✅ tested |
| **T** | Client tampers with ids to read another calendar | Every id parsed as a branded UUID; per-owner `ViewerContext`; per-event projection | ✅ tested |
| **T** | Handler mutates another user's event | `event:modify` requires ownership | ✅ tested |
| **R** | Denies sending a request | Append-only request records with timestamps | ⚠️ partial — no audit log yet |
| **I** | **Calendar detail leaks to non-friends** | Default-deny lattice, whitelist projection, conservative defaults | ✅ tested |
| **I** | Error codes reveal existence | Denials collapse to an indistinguishable `404` | ✅ tested |
| **I** | Blocked user detects the block | `calendar:view` exempt from the block gate; empty result instead of `404` | ✅ tested |
| **I** | Busy-block boundaries reveal event count | Merged on `<=`, ids stripped, clipped to window | ✅ tested |
| **I** | Shared cache serves one viewer's calendar to another | `cache-control: no-store` on every response | ✅ tested |
| **I** | Stack traces expose internals | `errorToResponse` returns bare codes; details stay in logs | ✅ tested |
| **D** | Bulk export via huge window | 62-day cap | ✅ tested |
| **D** | Oversized payloads | 256 KiB body limit | ✅ |
| **D** | Request flooding | Rate limiting | ⛔ not built |
| **E** | Route ships without an authz check | `authz` is a required field; perimeter tests assert the public allowlist | ✅ tested |
| **E** | New action ships unreviewed | `can()` is exhaustive; `ALL_ACTIONS` coverage backstop | ✅ tested |

## Abuse cases

Ordinary users misusing intended features. These matter more than exotic
exploits, because they need no skill and they happen at scale.

### Stalking via free/busy

**Attack.** Someone befriends a target, or keeps an old friendship alive, and
polls the free/busy endpoint to learn their routine — gym Tuesdays, empty house
Saturday mornings.

**Mitigations in place.** Conservative defaults mean a new friend sees `BUSY`
only. Busy blocks are merged and clipped. Windows are capped.

**Gaps.** Repeated polling still reconstructs a routine over time. Needs rate
limiting plus per-viewer access visibility ("Bob viewed your calendar 40 times
this week") so the target can notice. Neither is built.

### Block evasion

**Attack.** A blocked user creates a new account and re-adds the target.

**Mitigations.** Blocks are indelible directed records, and the block itself is
undetectable through the calendar endpoint — removing the signal that usually
prompts someone to make a second account.

**Gaps.** No same-device or same-contact detection. Deliberate: the obvious
implementations require collecting device fingerprints or contact lists, which
would create a worse privacy problem than the one being solved. Revisit only
with a design that does not.

### Exchange as a pretext

**Attack.** Post a desirable free item, wait for a claim, use the exchange flow
to get a specific person to a specific place at a specific time.

**Mitigations.** Claiming requires an accepted friendship even for `PUBLIC`
listings. Exchange events are capped at `BUSY`, so no third party learns the
location. Locations are participant-chosen free text and are never auto-filled —
we store no home addresses to auto-fill from.

**Gaps.** No reporting flow, no safe-meetup guidance in the UI, no way to share
an exchange with a trusted third party. The first is a prerequisite for launch.

### Handle enumeration to map a social graph

**Attack.** Iterate handles, use response differences to infer who exists and
who is connected to whom.

**Mitigations.** `PublicProfile` is minimal. Calendar responses are identical
for "stranger", "blocked", and "no such user".

**Gaps.** Handle-availability checks during signup are an inherent oracle;
constrain with rate limiting when signup is built.

### Circle-name leakage

**Attack.** Infer that you were sorted into "Work (Obligation)".

**Mitigation.** Circle names are owner-only and never appear in any projection.
`CIRCLE` audiences are an *input* to a decision, never part of a response.

## Assumptions

Stated so they can be challenged:

1. TLS terminates before the app; transport confidentiality is not our concern.
2. The database is not attacker-readable. Field-level encryption for event
   titles and locations is **not** implemented — a database compromise discloses
   them.
3. Users understand "friend" as a trust boundary. Weak assumption; the
   conservative default limits the blast radius when it is wrong.
4. No insider-threat controls exist. Anyone with production database access can
   read everything. Needs access logging before real users exist.

## Review triggers

Re-read this document, and update it, when a change:

- touches `packages/policy` at all;
- adds a route, especially a `PUBLIC` one;
- adds a field to `CalendarEvent`, `Listing`, or `User`;
- introduces notifications, search, or any bulk/export endpoint;
- adds a third-party integration, particularly calendar import/export.
