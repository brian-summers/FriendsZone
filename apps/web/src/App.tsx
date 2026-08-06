import { useEffect, useMemo, useState } from 'react';
import type { MeView, PublicProfile } from '@friendszone/contracts';
import { api } from './lib/api.js';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from './lib/theme.js';
import { linkProps, matchRoute, navigate, usePathname } from './lib/router.js';
import { WeekScreen } from './screens/WeekScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { ThingsScreen } from './screens/ThingsScreen.js';
import { SignInScreen } from './screens/SignInScreen.js';
import { ModerationScreen } from './screens/ModerationScreen.js';
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

const ROUTES = ['/', '/people/:id', '/inbox', '/things', '/settings', '/moderation'] as const;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

export function App() {
  /**
   * `null` until we know. Three states, not two: "checking", "signed out", and
   * "signed in" — collapsing the first two flashes the sign-in screen at
   * someone who is already signed in, on every load.
   */
  const [authState, setAuthState] = useState<'checking' | 'out' | 'in'>('checking');
  const [actorId, setActorId] = useState<string>(DEV_ACTORS[0]!.id);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());
  const [me, setMe] = useState<MeView | null>(null);
  const [people, setPeople] = useState<PublicProfile[]>([]);
  /** Bumped when a friendship is accepted, removed, or blocked away. */
  const [graph, setGraph] = useState(0);
  const [pendingInbox, setPendingInbox] = useState(0);
  // Bumped after any mutation so derived counts (the inbox badge) refresh
  // without each screen having to know about the shell.
  const [activity, setActivity] = useState(0);
  const bumpActivity = () => setActivity((n) => n + 1);

  const pathname = usePathname();
  const match = matchRoute(pathname, ROUTES);

  /**
   * Ask the server who we are, once, on load.
   *
   * The session is an HttpOnly cookie, so the client genuinely cannot know
   * whether it is signed in without asking — which is the point of the cookie
   * being HttpOnly.
   */
  useEffect(() => {
    const controller = new AbortController();
    api
      .me(null, controller.signal)
      .then((who) => {
        if (controller.signal.aborted) return;
        setActorId(who.id);
        setAuthState('in');
      })
      .catch(() => {
        if (!controller.signal.aborted) setAuthState('out');
      });
    return () => controller.abort();
  }, []);

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
  }, [actorId, graph]);

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

  // Only the week routes bring their own scroll container; the rest rely on
  // <main> to scroll for them. Getting this wrong is silent — the content is
  // clipped at the fold rather than erroring — so it is derived from the route
  // rather than set per screen.
  const weekManagesItsOwnScroll = match?.pattern === '/' || match?.pattern === '/people/:id';

  if (authState === 'checking') return <div className="app" />;

  if (authState === 'out') {
    return (
      <SignInScreen
        onSignedIn={(who) => {
          setActorId(who.userId);
          setAuthState('in');
        }}
      />
    );
  }

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
          {/* Hidden for everyone else, but hiding is not the control: the queue
              routes refuse anyone off the allowlist regardless of the nav. */}
          {me?.isModerator === true && (
            <a
              {...linkProps('/moderation')}
              aria-current={isActive('/moderation') ? 'page' : undefined}
            >
              Moderation
            </a>
          )}
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

          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              void api.logout().finally(() => setAuthState('out'));
            }}
          >
            Sign out
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

        <main className={weekManagesItsOwnScroll ? 'main' : 'main main-scroll'}>
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
            <ThingsScreen actorId={actorId} peopleById={peopleById} onActivity={bumpActivity} />
          )}

          {match?.pattern === '/moderation' && <ModerationScreen actorId={actorId} />}

          {match?.pattern === '/settings' && (
            <SettingsScreen
              me={me}
              people={people}
              actorId={actorId}
              theme={theme}
              onTheme={setTheme}
              onGraphChanged={() => setGraph((n) => n + 1)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
