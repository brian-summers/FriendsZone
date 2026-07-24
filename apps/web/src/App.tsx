import { useEffect, useMemo, useState } from 'react';
import type { PublicProfile } from '@friendszone/contracts';
import { api } from './lib/api.js';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from './lib/theme.js';
import { linkProps, matchRoute, navigate, usePathname } from './lib/router.js';
import { WeekScreen } from './screens/WeekScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { Placeholder } from './components/Placeholder.js';

/**
 * Development identity switcher.
 *
 * Hardcoded rather than fetched: an endpoint that enumerates accounts would be
 * a real one needing real access control. This is scaffolding that disappears
 * when ADR 0006 lands, so it leaves no route behind. Ids match
 * apps/api/src/seed.ts.
 */
const DEV_ACTORS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Alice (owner)' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Bob (friend, climbing circle)' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Carol (friend)' },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Dave (friend, shares nothing)' },
  { id: '55555555-5555-4555-8555-555555555555', name: 'Mallory (blocked by Alice)' },
];

const ROUTES = ['/', '/people/:id', '/inbox', '/things', '/settings'] as const;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

export function App() {
  const [actorId, setActorId] = useState<string>(DEV_ACTORS[0]!.id);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());
  const [me, setMe] = useState<PublicProfile | null>(null);
  const [people, setPeople] = useState<PublicProfile[]>([]);
  const [pendingInbox, setPendingInbox] = useState(0);
  // Bumped after any mutation so derived counts (the inbox badge) refresh
  // without each screen having to know about the shell.
  const [activity, setActivity] = useState(0);
  const bumpActivity = () => setActivity((n) => n + 1);

  const pathname = usePathname();
  const match = matchRoute(pathname, ROUTES);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // Identity change resets everything derived from it. Reusing a stale profile
  // or friend list across actors is the client-side form of the "one
  // ViewerContext reused across owners" bug the server guards against.
  useEffect(() => {
    const controller = new AbortController();
    setMe(null);
    setPeople([]);

    Promise.all([
      api.me(actorId, controller.signal).catch(() => null),
      api.people(actorId, controller.signal).catch(() => ({ people: [] })),
    ]).then(([profile, list]) => {
      if (controller.signal.aborted) return;
      setMe(profile);
      setPeople(list.people);
    });

    // A calendar being viewed may belong to the previous actor's friends;
    // returning home avoids showing a 404 for someone this actor can't see.
    navigate('/');

    return () => controller.abort();
  }, [actorId]);

  // The inbox count. A quiet number, never a red pulsing badge — a request that
  // demands to be dealt with now is the pressure this product removes (ADR 0007).
  useEffect(() => {
    const controller = new AbortController();
    api
      .received(actorId, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) {
          setPendingInbox(r.requests.filter((req) => req.status === 'PENDING').length);
        }
      })
      .catch(() => setPendingInbox(0));
    return () => controller.abort();
  }, [actorId, activity]);

  const peopleById = useMemo(() => {
    const map = new Map<string, PublicProfile>();
    if (me) map.set(me.id, me);
    for (const p of people) map.set(p.id, p);
    return map;
  }, [me, people]);

  const isActive = (to: string): boolean =>
    to === '/' ? pathname === '/' : pathname.startsWith(to);

  const viewingPersonId = match?.pattern === '/people/:id' ? match.params.id : null;

  return (
    <div className="app">
      <header className="topbar">
        <a className="wordmark-link" {...linkProps('/')}>
          <h1 className="wordmark">
            Friends<em>zone</em>
          </h1>
        </a>

        <nav className="nav" aria-label="Sections">
          <a {...linkProps('/')} aria-current={isActive('/') && !viewingPersonId ? 'page' : undefined}>
            Week
          </a>
          <a {...linkProps('/inbox')} aria-current={isActive('/inbox') ? 'page' : undefined}>
            Inbox
            {pendingInbox > 0 && <span className="nav-count">{pendingInbox}</span>}
          </a>
          <a {...linkProps('/things')} aria-current={isActive('/things') ? 'page' : undefined}>
            Things
          </a>
          <a {...linkProps('/settings')} aria-current={isActive('/settings') ? 'page' : undefined}>
            Settings
          </a>
        </nav>

        <div className="topbar-spacer" />

        <div className="topbar-right">
          <div className="devbar">
            <label htmlFor="actor">Dev · acting as</label>
            <select id="actor" value={actorId} onChange={(e) => setActorId(e.target.value)}>
              {DEV_ACTORS.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={() =>
              setTheme((c) => (c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system'))
            }
          >
            Theme: {theme}
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <p className="side-label">Calendars</p>
          <div className="people">
            <a
              className="person"
              aria-current={pathname === '/' || undefined}
              {...linkProps('/')}
            >
              <span className="avatar">{me ? initials(me.displayName) : '—'}</span>
              <span>{me?.displayName ?? 'Loading…'}</span>
            </a>

            {people.map((person) => (
              <a
                key={person.id}
                className="person"
                aria-current={viewingPersonId === person.id || undefined}
                {...linkProps(`/people/${person.id}`)}
              >
                <span className="avatar muted">{initials(person.displayName)}</span>
                <span>{person.displayName}</span>
              </a>
            ))}
          </div>

          {people.length === 0 && (
            <p className="side-note">No friends to show for this account.</p>
          )}

          <p className="side-label" style={{ marginTop: 'var(--space-lg)' }}>
            Try this
          </p>
          <p className="side-note">
            Switch who you’re “acting as” in the header, then open a calendar. The same week looks
            different to each person — that’s the whole product.
          </p>
        </aside>

        <main className="main">
          {match === null && (
            <Placeholder
              title="Not found"
              blurb="There’s nothing at this address."
              status=""
            />
          )}

          {match?.pattern === '/' && (
            <WeekScreen
              ownerId={actorId}
              actorId={actorId}
              me={me}
              people={people}
              ownerProfile={me}
              onActivity={bumpActivity}
            />
          )}

          {viewingPersonId && (
            <WeekScreen
              key={viewingPersonId}
              ownerId={viewingPersonId}
              actorId={actorId}
              me={me}
              people={people}
              ownerProfile={peopleById.get(viewingPersonId) ?? null}
              onActivity={bumpActivity}
            />
          )}

          {match?.pattern === '/inbox' && (
            <InboxScreen actorId={actorId} peopleById={peopleById} onActivity={bumpActivity} />
          )}

          {match?.pattern === '/things' && (
            <Placeholder
              title="Things"
              blurb="Offer something to friends, claim what you need, and schedule a handoff that books itself into both calendars as a Busy block."
              status="Not built yet. Listing, Claim, and Exchange are modelled and policy-covered; the exchange flow is gated on a reporting and moderation feature that must ship first."
            />
          )}

          {match?.pattern === '/settings' && (
            <SettingsScreen me={me} theme={theme} onTheme={setTheme} />
          )}
        </main>
      </div>
    </div>
  );
}
