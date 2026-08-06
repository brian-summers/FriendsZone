# Friendszone

Coordinate plans with friends without the pressure of coordinating in real time.
A friends' zone — private by design, but about connection. Ships at
**friends-zone.app**.

- **A calendar friends can actually use** — they see what you choose to share,
  at the granularity you choose, per person or per circle.
- **Asynchronous hangout requests** — propose a few times, get an answer
  whenever. Pending asks show as tentative holds on both calendars; requests
  expire on their own so nothing becomes a guilt pile.
- **One pane of glass.** Propose, accept, decline, withdraw, and create — all
  from the calendar. Firm plans are solid; tentative ones are pencilled in.
- **RSVPs** for confirmed plans.
- **Secondhand exchanges** — offer an item to friends, they claim it, you
  schedule a handoff that books itself into both calendars.

No presence indicators. No typing indicators. No read receipts. Ever — see
[ADR 0007](docs/adr/0007-async-by-design.md).

## Status

**Running, on in-memory data.** The domain model, the privacy engine, the HTTP
edge, authentication, and the client all work end to end.

**The API now starts in production.** It refused to, deliberately, until a real
authenticator existed ([ADR 0006](docs/adr/0006-authentication-deferred.md));
one does ([ADR 0024](docs/adr/0024-authentication.md)), and the development
identity header is inert outside development.

**PostgreSQL, with row-level security** ([ADR 0004](docs/adr/0004-persistence.md),
[ADR 0026](docs/adr/0026-sql-layer.md)). `DATABASE_URL` picks the store:
`postgres://…` for a server, `pglite://<dir>` for Postgres 18 running in-process
with nothing to install, or `memory://` for a throwaway run — which production
refuses.

The SQL is exercised by the real engine on every `npm test`: the same
conformance suite runs against both the in-memory and the Postgres adapters, and
the schema, GiST index, constraints, and RLS policies are tested directly.

| Screen | State |
|---|---|
| Sign in / register | Real. Email and password, sessions in an `HttpOnly` cookie. Login never reveals whether an account exists — same body, status, and timing either way ([ADR 0024](docs/adr/0024-authentication.md)) |
| Week view | Real. Live per-viewer projections for your calendar and a friend's, deep-linkable at `/` and `/people/:id` |
| Tentative holds | Real. Pending hangouts show as tentative entries on both participants' calendars — never to third parties |
| On-calendar actions | Real. Tap a tentative hold to accept a slot, decline, or withdraw — without leaving the calendar |
| Requesting time | Real. **Open a friend's week → Request time.** Specific slots *or* a floating "anytime, on repeat" invitation |
| Inbox | Real. Received/sent requests; accept, decline, withdraw, book floating occurrences; recent-update notifications |
| Accepting | Real. Accepting books the firm event onto **both** calendars and clears the holds |
| Managing hangouts | Real. From the calendar: **edit, reschedule, or cancel** (with an optional heads-up to the other party) |
| Open to conflict | Real. Mark an event flexible so friends can request that time anyway — it shows as "open", not busy |
| Creating events | Real. `+ New event` writes through `POST /v1/events`; the owner is the session, never the request |
| Creating by drag | Real. **Drag a free slot** on your week to open the New Event dialog pre-filled; the drag may span days |
| Drag on a friend's week | Real. **Drag their free time** to open the request composer pre-filled — same gesture, routed to a hangout request |
| Multi-day events | Real. Events may run past midnight; they draw as a continuous band across the columns they cover |
| Overlapping plans | Real. Events overlap by default and lay out side-by-side; tick **Block this time** to make one exclusive (a hard `busy` block) |
| Editing & deleting events | Real. Click your event → **Edit or delete**; change title, time, exclusivity, or remove it |
| Per-event sharing editor | Real. Click your event → **Change who sees this** — audiences as rows, an ordinal level slider, consequences in plain words |
| Sharing defaults | Real. Three named presets — **Private / Busy to friends / Open to friends** — with the consequence in plain words, plus finer control. No preset shares your location ([ADR 0021](docs/adr/0021-sharing-presets.md)) |
| Find a time | Real. **When are we all free?** — pick friends, a length, a range, and get slots that work for everyone. Computed over per-viewer projections, so it can see nothing you couldn't ([ADR 0008](docs/adr/0008-slot-finder-on-projections.md)) |
| Your data | Real. Download everything you can see of your own account — built from the same projections the API uses, so a report about you still never says who filed it |
| Deleting your account | Real. Immediate and permanent, confirmed by typing your handle, with an honest list of what is kept and why ([ADR 0022](docs/adr/0022-export-and-deletion.md)) |
| Finding people | Real. Search by handle or display name in **Settings → Friends**. Bounded to 20 results with a two-character minimum, and someone in a block relationship with you simply is not there ([ADR 0028](docs/adr/0028-friend-requests-and-blocking.md)) |
| Friend requests | Real. Ask, accept, decline, or withdraw. A pending request grants **nothing** — not busy, not a title — and a decline leaves no record, so "waiting" and "no" look the same to the sender |
| Unfriending | Real. Either party, at any time. Circle rosters are deliberately left alone; the friendship re-check makes a stale entry grant nothing ([ADR 0023](docs/adr/0023-circle-management.md)) |
| Blocking | Real. Blocking severs the friendship and hides each of you from the other. Blocks are **directed**: unblocking lifts only yours, so if they blocked you too, that stands — and nothing anywhere tells you it exists |
| Circles | Real. Create private groupings of friends in **Settings** and share to them. Only you ever see a circle or its name ([ADR 0023](docs/adr/0023-circle-management.md)) |
| Sharing checkup | Real. Server-rendered previews of what each person sees |
| Things | Real. Offer an item to friends or a circle, with photos; claim it **first-come**, by **draw**, or let the owner **choose**; set a closing time |
| Reporting | Real. Report a listing or a person; the reported party is **never** told who reported them |
| Moderation | Real. A queue for allowlisted moderators: frozen evidence, two separate threads (reporter / reported, which never cross), uphold or dismiss, and takedown |
| Handing it over | Real. Suggest a time and place, the other person agrees, and it books **both** calendars — while everyone else sees only that you're busy ([ADR 0019](docs/adr/0019-the-handoff.md)) |

## Quick start

```bash
npm install
npm run verify        # typecheck + 511 tests
```

Run it. Two terminals:

```bash
cp .env.example .env
npm run dev:api       # API on :8080, seeded with demo data (in-memory)
npm run dev:web       # app on :5173, proxies /api to :8080
```

Open <http://localhost:5173>. The app boots as Alice with a populated week.

**The thing to try first:** use the *Dev · acting as* switcher in the header to
become Bob, then Carol, then Mallory, and open Alice's calendar from the
sidebar. Bob is in her climbing circle and sees that event in full; Carol is an
ordinary friend and sees busy blocks with two names; Mallory is blocked and sees
an empty week indistinguishable from a free one.

As Alice, notice the small corner tag on each of your own events — *the most
anyone else can see*, computed server-side. Add one with **+ New event**, click
any event for its details, or hit **See what others see** for a full preview,
all rendered by the same projection engine that serves the real thing.

**Then make a plan.** Open a friend's week and hit **Request time** — propose a
few slots (each annotated with whether they look free, from what that friend
shares with you) and send. Switch to *acting as* that friend, open the **Inbox**,
and accept one. The hangout lands on both of your calendars. There are no read
receipts and no nudges anywhere in that flow; a request simply waits, and bows
out on its own after a week. That restraint is the product.

## The idea worth knowing

Stored data is never returned to a client. Every response is a **projection**
computed for one specific viewer by a pure function with no database access.

An event resolves to one of four levels for each viewer — `HIDDEN`, `BUSY`,
`TITLE`, `FULL` — by taking the most permissive grant they qualify for and then
clamping it against a ceiling the owner set on that event. Blocks are checked
before any grant. The default, for anyone you have not affirmatively shared
with, is `HIDDEN`.

A stranger asking for your calendar gets `200 {busy: [], details: []}` — not a
`403`, because a `403` would confirm the account exists.

The full specification is
[docs/architecture/visibility-and-privacy.md](docs/architecture/visibility-and-privacy.md).

## Structure

| Path | What lives there |
|---|---|
| [`packages/contracts`](packages/contracts/) | Zod schemas; every domain type, defined once |
| [`packages/policy`](packages/policy/) | The security kernel — pure, no I/O, heavily tested |
| [`packages/design-tokens`](packages/design-tokens/) | Colour, type, and the visibility encodings; contrast is a build gate |
| [`apps/api`](apps/api/) | HTTP edge: transport, authentication, error shaping |
| [`apps/web`](apps/web/) | React client. Renders projections; contains no authorization logic |
| [`docs/`](docs/) | Architecture, security, design, product, decisions, playbooks |

## Documentation

Start with [docs/README.md](docs/README.md), or jump to:

- [Architecture overview](docs/architecture/overview.md)
- [Visibility and privacy specification](docs/architecture/visibility-and-privacy.md)
- [Threat model](docs/security/threat-model.md)
- [Design system](docs/design/design-system.md) and [interface design](docs/design/interface.md)
- [Roadmap and feature weighting](docs/product/roadmap.md)
- [Decision records](docs/adr/)
- [Deploy on AWS](docs/playbooks/deploy-on-aws.md) and [the road to GA](docs/product/road-to-ga.md)

Contributing, including for AI agents: [CLAUDE.md](CLAUDE.md).
