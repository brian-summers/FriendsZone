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
8. **Bound every list and range.** Unbounded is a bulk-export vector. Bound
   *repetition* too — every route names a `rateLimit` class.
9. **A circle never leaves its owner.** Names and rosters go to the owner and
   nobody else. There is no "circles you're in", anywhere, for anyone.
10. **Moderation is not a master key.** `ViewerContext.isModerator` unlocks the
   report queue and the evidence snapshots on reports. It must never appear in
   `visibility.ts` or `projection.ts`, and the reporter's identity must never
   reach the subject at any status.
11. **Visibility is never encoded by colour alone.** Every level renders four
   channels — fill, border, glyph, label — at every breakpoint and density.
   Dropping one is a safety regression, not a visual tweak.
12. **Never hard-code a colour.** Use tokens from `@friendszone/design-tokens`.
    Button text uses `onVerdigris`; a filled event chip uses `--on-hue`. `#fff`
    is unreadable on dark-theme verdigris, and on five of Signal's six hues.
    A theme is a **palette** × a **mode**; every palette declares all four
    combinations, and category hues are gated on colour-vision separation.
13. **On writes, the server owns identity.** `ownerId` (and any id) comes from
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
- Account deletion does not touch the counterparty's calendar copy → their
  record of their own week is not the deleting user's to remove.
- The slot finder calls `projectCalendar` per participant instead of reading
  events directly → the indirection is the security argument, not overhead.
- Slot suggestions round start *up* and end *down* → outward rounding would
  suggest busy time; one-sided rounding still leaks a boundary.
- Handoff events use a `BUSY` ceiling while hangouts use `FULL` → a hangout is a
  social plan, a handoff is an address. The owner's own "who can see this" badge
  therefore reads *Busy* on a handoff, which is correct, not a bug.
- Cancelling a handoff *deletes* its calendar copies instead of marking them
  cancelled → the lingering slot is the disclosure.
- `projectListing` gates on `can()` rather than testing the audience inline → an
  inline `audienceMatches` would drop the block check that sits above the switch.
- A listing photo is re-authorized through its listing on every fetch → a key is
  not a capability, so a leaked one is not a permanent public URL.
- `blocks` has no `on delete cascade` and `eraseUser` skips it → clearing a
  block would make delete-and-rejoin a route back to someone who blocked you.
- `blocks` is keyed `(blocker_id, blocked_id)` with **no canonical ordering**,
  unlike `friendships` right beside it → a mutual block is two rows on purpose.
  One row would make Alice's unblock delete Bob's protection too.
- Declining a friend request **deletes the row** instead of storing `DECLINED` →
  a stored decline answers "did they say no, or have they not looked yet?".
- `MemoryDirectory.friendsOf` reads through `MemorySocialGraph` rather than
  keeping its own list → the two drifted once, and an accepted request stopped
  producing a friend.
- Search over-fetches `MAX_SEARCH_RESULTS * 2` and *then* filters blocks → a
  limit applied after filtering makes a short page a block oracle.
- `events.span` is `[start, end)` and queried with `&&` → a closed range would
  make every back-to-back pair look like a clash.
- `verifyAgainstNobody` runs on a login for an email that does not exist → the
  absence of a ~300 ms hash is a perfectly good account-existence oracle.
- The scrypt parameters are load-bearing on the rate limiter → each hash costs
  ~64 MB, and the tight `UPLOAD` bucket on the credential routes is what bounds
  how many run at once.
- Report routes build their context with `viewerFor(actorId)`, never the other
  party → a report is about a pair who have often blocked each other, and a
  context built against the counterparty would deny a victim their own case.
- `report:*` is in `BLOCK_EXEMPT_ACTIONS` → an abuser must not be able to block
  their victim into being unable to report them.
- `ReportNote.authorId` is `null` for moderators → a party learns that a
  moderator replied, never which one, and an id never recorded cannot leak.
- `ModeratorReportView` returns two note arrays rather than one merged list →
  a single sorted array is one careless `.map()` away from showing a subject the
  reporter's words.
- Visible events appear in `busy` *and* `details` → the redundancy keeps
  slot-finding correct.
- The authenticator throws in production → the auth gap must not be deployable.
- `assertNever` in every default branch → a new union member must break the
  build.
- `tokens.css` repeats all four palette-and-mode blocks per palette →
  `[data-theme]` and `[data-palette]` tie on specificity, so omitting one lets
  source order decide and pairs one palette's chrome with another's hues.
- A `v-FULL` chip's border is `color-mix(hue 65%, ink)` rather than the hue →
  a light hue cannot reach 3:1 against a light ground at all, so the edge, not
  the fill, is what makes the chip a distinguishable shape.
- Hue custom properties are numbered `--hue-1..6`, not named for colours →
  slot 4 is aqua in Verdigris and orange in Signal; a colour name would lie.

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
pane of glass** — everything but settings and Things happens there. **Things**
is real too: offer an item to an audience with photos, and give it away
**first-come**, by **draw**, or by **choosing**, against an optional closing
time, **report** anything you can see, and — if you are on the moderator
allowlist — work a **moderation queue** with frozen evidence and two threads that
never cross. The **handoff** is real too: propose a time and place, the other
party agrees, and it books both calendars while showing everyone else only
*busy*. The **slot finder** answers "when are we all free?" over per-viewer
projections. Every route draws from a **rate-limit bucket**, and sharing defaults ship as
three named **presets**. Accounts **export and delete**, and **circles** are manageable. Real
**authentication** ships: register, sign in, sign out, sessions in an
`HttpOnly` cookie, and everything is stored in **PostgreSQL**. The **social
graph is now buildable from inside the product**: search for someone, send a
friend request, accept or decline it, unfriend, and **block** — with blocks
stored as *directed* rows so lifting yours never lifts theirs. 586 tests.

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
- [ADR 0027](docs/adr/0027-deploy-on-aws.md): **one CloudFront distribution**
  serves the client and proxies `/api/*`, which is what keeps them same-origin —
  splitting the hostnames would need CORS and would break `SameSite=Lax` on the
  session cookie. Caching is **off** for `/api/*`; a CDN that cached one
  viewer's projection would defeat the whole model. Cloudflare is gone except
  possibly DNS. `TRUSTED_PROXY_HOPS` is a bounded count, never `true`.
- [ADR 0026](docs/adr/0026-sql-layer.md): **raw parameterised SQL**, no query
  builder — ADR 0004's own argument, that "the projection path benefits from
  queries a reviewer can read as SQL". Columns exist only for what is queried,
  indexed, or enforced on; everything else is `doc jsonb`, because a third
  description of each entity would drift from the Zod schemas. RLS expresses
  **ownership only** and is a *backstop*, never the control — the lattice stays
  in `packages/policy`. A sanctioned cross-owner write (accepting a hangout,
  booking a handoff) must set `app.cross_owner`, which makes it grep-able.
- [ADR 0024](docs/adr/0024-authentication.md): sessions are opaque tokens
  **stored hashed** — a dump of the session store yields nothing presentable.
  Passwords use **scrypt from `node:crypto`, not Argon2id**, a deliberate
  deviation from ADR 0006 argued there; the hash is self-describing so raising
  the parameters needs no flag day. **Login is non-enumerable in timing as well
  as in wording** — an unknown email still pays for a dummy hash, and deleting
  that call reopens the oracle. Registration enumeration is a *known open gap*
  pending email. Credentials are `(provider, subject)` so social login is a new
  provider, not a migration.
- [ADR 0028](docs/adr/0028-friend-requests-and-blocking.md): a friend request
  is the **friendship row with `status: 'PENDING'`**, not a second table — two
  tables are two places that can disagree about whether two people are friends.
  `PENDING` grants nothing (`audienceMatches` tests for `FRIEND` exactly).
  **Blocks are directed**, keyed `(blocker_id, blocked_id)`: `relationship()`
  still collapses either direction to `BLOCKED`, but `unblock` touches only the
  caller's row. Blocking severs the friendship and any pending request. Search
  is bounded, `EXPENSIVE`, and returns the same empty list for "no such handle"
  and "blocked either way".
- [ADR 0023](docs/adr/0023-circle-management.md): a circle is **owner-only, its
  name most of all**. No endpoint answers "which circles am I in" — not a
  profile line, not a checkup that explains *why* someone can see something.
  Rosters keep ex-friends (the friendship re-check makes them harmless) and the
  owner is shown them marked inactive. Deleting a circle scrubs the rules naming
  it.
- [ADR 0022](docs/adr/0022-export-and-deletion.md): **an export is a
  projection, not a dump** — every section is built with the same projection
  functions the API uses, so it can never contain more than the user could
  already read. `reportsAboutYou` runs through `projectReportForSubject`;
  exporting the stored `Report` would hand a reported person their reporter's
  identity in a downloadable file. Deletion **erases then tombstones** (id kept,
  fields emptied) and deliberately keeps blocks, live moderation cases, and the
  counterparty's copies of shared plans.
- [ADR 0021](docs/adr/0021-sharing-presets.md): three account presets, and
  **none of them grants `FULL` or reaches `PUBLIC`** — a default is a standing
  grant over every event you ever create, unlike a per-event choice. Widening
  stays possible via custom rules. `CONSERVATIVE_SHARING_DEFAULTS` *is* the
  `BUSY_TO_FRIENDS` preset, defined once. `chosen: false` means "never picked",
  which is a different state from "picked the conservative one".
- [ADR 0020](docs/adr/0020-rate-limiting.md): every route declares a named
  `rateLimit` class; omitting it means `DEFAULT`, never unlimited. Buckets are
  **per process**, so N instances means N× the limit — fix that before scaling
  out. Disabling it is a boot failure in production.
- [ADR 0008](docs/adr/0008-slot-finder-on-projections.md): the slot finder
  intersects **projections**, never stored events. Reading raw events would look
  like an obvious simplification, pass every single-query test, and reopen a
  differential attack that reconstructs a whole calendar from someone who shared
  nothing. There is deliberately **no `SCHEDULING` audience** — a grant only the
  finder honours *is* the privileged data the design removes.
- [ADR 0019](docs/adr/0019-the-handoff.md): the handoff books an event on
  **both** calendars with `visibilityCeiling: 'BUSY'` — third parties learn only
  that someone is occupied, while both participants still see the address via
  the attendee branch, which returns FULL *before* the ceiling clamp. Raising it
  to `FULL` (as hangouts use) publishes an address. **Cancelling deletes both
  copies** rather than marking them cancelled, because a slot that frees up at
  short notice is itself information. Nothing is booked until the *other* party
  accepts.
- [ADR 0018](docs/adr/0018-reporting-and-moderation.md): a report is an **in-app
  record**; the email to `reports@friends-zone.app` carries only an id, a reason,
  and a subject kind (`NotifierPort` has no parameter that could hold content).
  **Two one-way threads** (`ReportNote.audience`) mean the reporter and the
  reported never share an object — there is no `BOTH` and adding one collapses
  the guarantee. The subject is told **nothing** until a moderator opens a thread.
  Moderators come from `MODERATOR_IDS` in config → `ViewerContext.isModerator`,
  and that flag grants **no** visibility exemption: there is no moderator branch
  in `visibility.ts` or `projection.ts`, and there must never be one.
- [ADR 0017](docs/adr/0017-claim-modes-and-deadlines.md): a Thing is claimed by
  one of three **modes** against one `claimsCloseAt`. The kernel refuses to let
  an owner hand-pick a `LOTTERY` winner, and refuses a draw before the deadline —
  both are what make a draw a draw. `drawWinner` is pure and takes its randomness
  as an argument. **Claimants never learn about each other:** `claims` is absent,
  not empty, for anyone but the owner. The in-person **handoff is still
  unbuilt**, gated on moderation.

**Client rules.** `apps/web` renders what the server sent and never re-derives
a visibility decision. If you find yourself wanting the sharing rules on the
client to compute what someone can see, stop — that is a second implementation
of the security model, and it will drift. Ask the server
(`/v1/me/calendar/preview`).

**Deliberately absent, each with an ADR or a named reason:** field-level
encryption of 🟠 Sensitive columns and photo bytes in object storage (both named
in [0004](docs/adr/0004-persistence.md)); password reset and email
delivery; social login (the credential model is shaped for it,
[ADR 0024](docs/adr/0024-authentication.md)); MFA; digest notifications;
recurring events.

**The API boots in production now.** It refused to until a real authenticator
existed; [ADR 0024](docs/adr/0024-authentication.md) built one, so the guard has
served its purpose and is gone. What replaced it is a *property*, asserted by
`auth.test.ts` and `server.test.ts`: outside development the `x-dev-actor-id`
header does nothing at all, and a present-but-invalid session cookie never falls
through to it.

**PostgreSQL is real** ([ADR 0004](docs/adr/0004-persistence.md),
[ADR 0026](docs/adr/0026-sql-layer.md)). `DATABASE_URL` selects the store —
`postgres://`, `pglite://<dir>` (Postgres 18 in-process, nothing to install), or
`memory://`, which production refuses. The in-memory adapters remain for tests,
and one **conformance suite runs against both**, because two implementations of
twelve interfaces drift and that suite is the only thing that keeps them honest.

## AWS Guidance

Installed by the [Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws)
setup, verbatim from its `rules/aws-agent-rules.md`. Appended rather than
substituted: everything above is this repository's own working agreement and
takes precedence where the two ever disagree.

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

### Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

### Local specifics

- The AWS CLI that supports `login` and `agent-toolkit` is the **user-local**
  2.36.19 at `%LOCALAPPDATA%\Programs\Amazon\AWSCLIV2\aws.exe`. A system-wide
  2.15.19 in `C:\Program Files\Amazon\AWSCLIV2` still shadows it on PATH.
- Credentials live in the **`agent-toolkit` profile**, not `default` — pass
  `--profile agent-toolkit`. The existing `default` and `queryadmin` profiles
  were deliberately left alone.
- On Windows, `aws agent-toolkit list-available-skills` exits 255 printing skill
  descriptions: they contain `→`, which the cp1252 console encoder cannot
  encode. The call itself succeeds. Add `--query 'skills[].name'` or run
  `chcp 65001` first.
