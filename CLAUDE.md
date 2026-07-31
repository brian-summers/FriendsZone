# CLAUDE.md — working in this repository

Friendszone coordinates plans between friends: a privacy-filtered shared
calendar, asynchronous hangout requests, RSVPs, and secondhand item exchanges.

Read this before editing. It is short on purpose; the links go deep.

## Commands

```bash
npm install
npm run verify        # typecheck (all) + typecheck:web + vitest  ← before declaring done
npm test              # vitest run
npm run dev:api       # API on :8080, seeded demo data
npm run dev:web       # client on :5173, proxies /api to :8080
npm run build:web     # production build of the client
```

Tests run against TypeScript sources via aliases in `vitest.config.ts`, so a
clean checkout does not need a build first. `apps/web` is typechecked separately
(`tsc --noEmit`) because it is bundled by Vite rather than emitted by `tsc`.

## Layout

```
packages/contracts/     Zod schemas → inferred types. One definition per concept.
packages/policy/        THE SECURITY KERNEL. Pure. No I/O. Read the rules below.
packages/design-tokens/ Color, type, and the visibility encodings. Contrast is CI-gated.
apps/api/               HTTP edge: transport, authn, error shaping. No authz logic.
apps/web/               React client. Renders projections. No authz logic either.
docs/architecture/      How it works and why.
docs/security/          Threat model, authz model, data handling, review checklist.
docs/design/            Design system and interface decisions.
docs/product/           Roadmap, feature weighting, anti-features.
docs/adr/               Decisions, with the rejected alternatives.
docs/playbooks/         Step-by-step recipes.
```

Dependencies point inward only. `packages/policy` cannot import from `apps/api`,
cannot touch a database, cannot read the clock or the environment. TypeScript
project references enforce this — it is not a convention.

## Non-negotiables

These are not style preferences. Violating one is a security bug, and each is
backed by a test that will fail.

1. **Default deny.** Every access grant is affirmative. No fallback returns
   allow. New `switch` branches start from deny.
2. **Never return a stored entity to a client.** Only `projectEvent()` output
   crosses the network boundary. A `...event` spread in
   `packages/policy/src/projection.ts` is a security bug.
3. **A block outranks everything** — friendship, circles, `PUBLIC`, attendance.
   It is checked before any grant is considered.
4. **Denials must be indistinguishable.** A blocked viewer, a stranger, and a
   nonexistent user receive identical responses. Use `404`, not `403`.
   Never report counts of hidden items.
5. **Authorization lives only in `packages/policy`.** Not in routes, not in
   repositories, not in the client.
6. **Every route declares `authz`.** Public routes need a real written
   justification and an allowlist entry.
7. **Sensitive data never reaches a log.** No titles, locations, descriptions,
   or whole entities. Log `DenyReason` and the route pattern.
8. **Bound every list and range.** Unbounded is a bulk-export vector.
9. **Visibility is never encoded by colour alone.** Every level renders four
   channels — fill, border, glyph, label — at every breakpoint and density.
   Dropping one is a safety regression, not a visual tweak.
10. **Never hard-code a colour.** Use tokens from `@friendszone/design-tokens`.
    Button text uses `onVerdigris`; `#fff` is unreadable on dark-theme verdigris.
11. **On writes, the server owns identity.** `ownerId` (and any id) comes from
    the authenticated actor, never the request body — the input schema has no
    field for it. A route that reads `ownerId` from the body is a bug. Every
    mutating route declares a `body` schema; `routes.test.ts` enforces that.

## Before you "fix" something that looks redundant

Correct security code here frequently looks like an oversight. Before removing
anything in this list, read the comment next to it — each has one:

- Friendship is re-checked against circle membership → rosters survive
  unfriending.
- `calendar:view` is exempt from the block gate → denying it would leak the fact
  of the block.
- Busy blocks are merged on `<=` and carry no id → boundaries and counts are
  disclosures.
- Cancelled events are dropped for non-owners → "they freed up that evening" is
  information.
- Visible events appear in `busy` *and* `details` → the redundancy keeps
  slot-finding correct.
- The authenticator throws in production → the auth gap must not be deployable.
- `assertNever` in every default branch → a new union member must break the
  build.

If one genuinely is redundant, say so and explain why rather than silently
deleting it.

## Adding a feature

Follow [docs/playbooks/add-a-feature.md](docs/playbooks/add-a-feature.md).
Order matters: **contracts → policy → policy tests → ports → route → integration
test → docs**. Doing the route first means the security decisions get retrofitted,
which is when they get skipped.

## Definition of done

- [ ] `npm run verify` passes
- [ ] Policy changes have allow-path **and every deny-path** test
- [ ] New routes declare `authz`; public ones justified and allowlisted
- [ ] New fields classified in
      [data-classification.md](docs/security/data-classification.md)
- [ ] Changed `packages/policy`? Updated
      [visibility-and-privacy.md](docs/architecture/visibility-and-privacy.md)
      in the same commit
- [ ] Walked [the review checklist](docs/security/review-checklist.md)

## Conventions

- Comments explain **why**, never what. `// increment i` is noise; `// friendship
  is re-checked because unfriending does not scrub circle rosters` is the reason
  the code survives its next refactor.
- Prefer exhaustive `switch` over `if` chains, so the compiler catches additions.
- Prefer `Pick<>` in security signatures — it documents what is relevant.
- Tests assert on `response.body` (the serialized string), not only the parsed
  object, when checking that something did not leak.

## Current state

**Built and tested:** contracts, policy engine, HTTP edge (reads *and* validated
writes), full **event CRUD** (create — by dialog *or* by dragging a slot — edit,
delete, with a real **per-event sharing editor** and editable **sharing
defaults**), the full **hangout lifecycle** (propose fixed *or* floating →
tentative holds on both calendars → accept books both → edit / reschedule /
cancel in place, with optional notification records and lazy expiry),
**overlap-by-default** events (`exclusive` opt-out; overlapping events lay out in
columns), **multi-day events** (draw as a band across the columns they span) and
**drag-to-select on any calendar** (your own → create; a friend's → request time),
route-perimeter invariants, in-memory adapters, design tokens with
CI-gated contrast, and a navigable client where the **calendar is the single
pane of glass** — everything but settings happens there. 208 tests.

Decisions worth knowing before touching hangouts or the calendar:
- [ADR 0010](docs/adr/0010-hangout-resolution.md): accepting a hangout is a
  sanctioned cross-owner write (owner ids from trusted stored state, never the
  body). [ADR 0012](docs/adr/0012-hangout-lifecycle.md) extends that to
  edit/reschedule/cancel, which fan out to every copy via `resultingEventIds`.
- [ADR 0011](docs/adr/0011-tentative-holds.md): pending hangouts appear as
  **participant-scoped** tentative holds, derived at read time by
  `deriveHangoutHolds`. Shown only when both the calendar owner and the viewer
  are parties; never counted as busy; invisible to third parties.
- [ADR 0013](docs/adr/0013-floating-and-open-to-conflict.md): floating hangouts
  (book occurrences on demand within a period).
- [ADR 0015](docs/adr/0015-overlap-by-default-and-drag-to-create.md): events
  **overlap by default** (`exclusive` opt-out routes to `busy`, else
  `openBlocks` — never fold one into the other); accepted hangouts are exclusive;
  overlapping events lay out in columns; drag a free slot to create.
- [ADR 0016](docs/adr/0016-cross-calendar-drag-and-multi-day-events.md): the drag
  gesture works on **any** calendar — your own creates an event, a friend's opens
  a hangout request (the grid never writes to a calendar itself). Every interval
  is placed by `placeSpan` (one segment per day it touches), so **multi-day
  events** draw as a continuous band. If you touch grid geometry, `placeSpan` is
  the one placement helper.
- Notifications are **records, not pushes** ([ADR 0012](docs/adr/0012-hangout-lifecycle.md)) —
  written for the recipient to find, never delivered in real time.

**Client rules.** `apps/web` renders what the server sent and never re-derives
a visibility decision. If you find yourself wanting the sharing rules on the
client to compute what someone can see, stop — that is a second implementation
of the security model, and it will drift. Ask the server
(`/v1/me/calendar/preview`).

**Deliberately absent, each with an ADR:** persistence
([0004](docs/adr/0004-persistence.md)), authentication
([0006](docs/adr/0006-authentication-deferred.md)), web client, notifications,
rate limiting, moderation.

The API refuses to boot with `NODE_ENV=production` because no real authenticator
exists. That is intentional. Do not work around it — implement
[ADR 0006](docs/adr/0006-authentication-deferred.md).
