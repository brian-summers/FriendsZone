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
edge, and the week view all work end to end. Persistence and authentication do
not exist yet — each has an ADR describing what it must satisfy when it arrives.

The API deliberately refuses to start with `NODE_ENV=production`, because no
real authenticator exists yet.

| Screen | State |
|---|---|
| Week view | Real. Live per-viewer projections for your calendar and a friend's, deep-linkable at `/` and `/people/:id` |
| Tentative holds | Real. Pending hangouts show as tentative entries on both participants' calendars — never to third parties |
| On-calendar actions | Real. Tap a tentative hold to accept a slot, decline, or withdraw — without leaving the calendar |
| Requesting time | Real. **Open a friend's week → Request time.** Specific slots *or* a floating "anytime, on repeat" invitation |
| Inbox | Real. Received/sent requests; accept, decline, withdraw, book floating occurrences; recent-update notifications |
| Accepting | Real. Accepting books the firm event onto **both** calendars and clears the holds |
| Managing hangouts | Real. From the calendar: **edit, reschedule, or cancel** (with an optional heads-up to the other party) |
| Open to conflict | Real. Mark an event flexible so friends can request that time anyway — it shows as "open", not busy |
| Creating events | Real. `+ New event` writes through `POST /v1/events`; the owner is the session, never the request |
| Editing & deleting events | Real. Click your event → **Edit or delete**; change title, time, open-to-conflict, or remove it |
| Per-event sharing editor | Real. Click your event → **Change who sees this** — audiences as rows, an ordinal level slider, consequences in plain words |
| Sharing defaults | Real, editable in **Settings** — the control most people actually live with |
| Sharing checkup | Real. Server-rendered previews of what each person sees |
| Things | Placeholder route. Gated on moderation shipping first |

## Quick start

```bash
npm install
npm run verify        # typecheck + 190 tests
```

Run it. Two terminals:

```bash
cp .env.example .env
npm run dev:api       # API on :8080, seeded with demo data
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

Contributing, including for AI agents: [CLAUDE.md](CLAUDE.md).
