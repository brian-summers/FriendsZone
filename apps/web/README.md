# @friendszone/web

The React client. Run it with `npm run dev:web` from the repo root, alongside
`npm run dev:api`.

## The one rule

**This app renders projections. It never decides what a viewer may see.**

There is no copy of the visibility lattice here, no sharing rules on the client,
no "hide it in the UI" filtering. The server sends exactly what the viewer is
entitled to and the client draws it. Any code here that starts computing
visibility is a second implementation of the security model — it will drift from
`packages/policy`, and when it does it will be reassuring someone about a state
that is not true.

When the UI needs to know what another person can see — the sharing checkup —
it asks the server via `/v1/me/calendar/preview`, which runs the real engine.

## Layout

```
src/
  App.tsx                  shell: nav, sidebar, identity switcher, theme, routing
  screens/
    WeekScreen.tsx         your week and a friend's week (same component)
    InboxScreen.tsx        hangout requests: received + sent, respond/withdraw
    SettingsScreen.tsx     theme, sharing defaults (read-only), honest status
  components/
    WeekGrid.tsx           the calendar grid
    EventDrawer.tsx        one event's details; who-can-see-this for your own
    NewEventDialog.tsx     create an event via POST /v1/events
    RequestTimeDialog.tsx  propose times to a friend via POST /v1/hangouts
    SharingCheckup.tsx     "what does Bob see of my week?"
    Placeholder.tsx        honest stubs (Things, not-found)
  lib/
    api.ts                 typed client, same-origin via the Vite proxy
    router.ts              tiny History-API router (no dependency)
    time.ts                calendar geometry; the only place UTC becomes local
    visibility.ts          the four render channels; category hue
    sharePresets.ts        user-language sharing choices for the create form
    theme.ts               light / dark / system
  styles/
    tokens.css             mirrors @friendszone/design-tokens (drift-tested)
    app.css                component styles
```

## Routing

`lib/router.ts` is a ~40-line History-API router built on
`useSyncExternalStore` — no dependency, because the app has five routes and no
need for loaders or nested layouts. Real URLs (`/`, `/people/:id`, `/inbox`,
`/things`, `/settings`), working back/forward, deep-linkable. `matchRoute` is
unit-tested. If routing needs grow (query state, guards, nested layouts), this
is the moment to adopt a real router rather than extend this one.

## Two decisions worth knowing

**`tokens.css` is hand-written, not generated.** The palette has to exist before
any JavaScript runs or every cold load flashes the wrong theme. The duplication
is safe because `tokens.test.ts` parses this file and asserts every value
matches the TypeScript source — change one and CI fails.

**Requests go to `/api/*` and Vite proxies them.** Everything stays same-origin,
so there is no CORS configuration in the project at all, and therefore no
permissive `Access-Control-Allow-Origin` that can leak into production.

## Known gaps

- **Hangout requests are 1:1.** Proposing to a group needs a different
  resolution flow ([ADR 0010](../../docs/adr/0010-hangout-resolution.md)); the
  composer takes a single friend.
- **The per-event sharing editor is not built.** You choose sharing when you
  *create* an event (a short preset list, `lib/sharePresets.ts`), and you can
  preview any friend's view, but you cannot yet change an existing event's
  sharing or edit your defaults. This is the next screen.
- **No edit/delete/reschedule** of events, and no optimistic updates — a
  successful mutation refetches. Requests can be withdrawn or declined but not
  edited after sending.
- **Category colours are derived from the owner id**, because event categories
  are not modelled yet. Hue is deliberately independent of the visibility
  channels, so this cannot misrepresent who can see something.
- **No real auth.** The identity switcher is dev scaffolding that sends the
  `x-dev-actor-id` header the API accepts only outside production (ADR 0006).
