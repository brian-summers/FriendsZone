import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, CLIMBING_CREW, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

function windowQs(): string {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 21);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
}

describe('circles', () => {
  let app: FastifyInstance;
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(async () => {
    repos = createMemoryRepositories(createDemoSeed());
    app = await createServer({ config, repos });
    await app.ready();
  });

  const list = (actor: string) =>
    app.inject({ method: 'GET', url: '/v1/me/circles', headers: as(actor) });

  const create = (actor: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/me/circles', headers: as(actor), payload });

  // ── Owner-only ─────────────────────────────────────────────────────
  describe('who can see a circle', () => {
    it('shows an owner their own circles', async () => {
      const res = await list(ALICE);
      expect(res.statusCode).toBe(200);
      expect(res.json().circles).toHaveLength(1);
      expect(res.json().circles[0].name).toBe('Climbing crew');
    });

    it('never tells a member they are in one', async () => {
      // The whole point. Bob is in Alice's climbing crew and must not learn
      // that the grouping exists, let alone what she called it.
      const res = await list(BOB);
      expect(res.json().circles).toEqual([]);
      expect(res.body).not.toContain('Climbing crew');
    });

    it('leaks no circle name through a friend’s calendar', async () => {
      // Bob can see the climbing event *because* of the circle. He must not
      // learn that is why, or what the grouping is called.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
        headers: as(BOB),
      });
      expect(res.body).toContain('Climbing at Vertigo');
      expect(res.body).not.toContain('Climbing crew');
      expect(res.body).not.toContain(CLIMBING_CREW);
    });

    it('refuses to edit a circle you do not own, like an unknown one', async () => {
      const mine = (await create(ALICE, { name: 'Book club' })).json();

      const notYours = await app.inject({
        method: 'PATCH',
        url: `/v1/me/circles/${mine.id}`,
        headers: as(BOB),
        payload: { name: 'Mine now' },
      });
      const unknown = await app.inject({
        method: 'PATCH',
        url: '/v1/me/circles/99999999-9999-4999-8999-999999999999',
        headers: as(BOB),
        payload: { name: 'Mine now' },
      });

      expect(notYours.statusCode).toBe(unknown.statusCode);
      expect(notYours.body).toBe(unknown.body);
      expect(notYours.statusCode).toBe(404);
    });

    it('requires a session', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/me/circles' })).statusCode).toBe(401);
    });
  });

  // ── Membership ─────────────────────────────────────────────────────
  describe('membership', () => {
    it('creates a circle owned by the session, not the body', async () => {
      const res = await create(ALICE, { name: 'Book club', memberIds: [CAROL], ownerId: BOB });
      expect(res.statusCode).toBe(200);
      expect(res.json().members.map((m: { userId: string }) => m.userId)).toEqual([CAROL]);

      // The smuggled ownerId was ignored: it is Alice's circle.
      expect((await list(ALICE)).json().circles).toHaveLength(2);
      expect((await list(BOB)).json().circles).toEqual([]);
    });

    it('drops non-friends rather than listing people who can never match', async () => {
      // Mallory is blocked; a roster containing her would lie to Alice about
      // who can see her calendar.
      const res = await create(ALICE, { name: 'Everyone', memberIds: [CAROL, MALLORY] });
      const ids = res.json().members.map((m: { userId: string }) => m.userId);
      expect(ids).toContain(CAROL);
      expect(ids).not.toContain(MALLORY);
    });

    it('marks a roster entry who is not a friend, rather than hiding them', async () => {
      /**
       * Seeded directly rather than by unfriending, because **there is no
       * unfriend endpoint yet** — so this state is currently unreachable
       * through the product. It is still the documented invariant (rosters
       * outlive friendships; `audienceMatches` re-checks at read time), and
       * this asserts the view tells the owner the truth when it happens.
       */
      const seed = createDemoSeed();
      const withStale = await createServer({
        config,
        repos: createMemoryRepositories({
          ...seed,
          circles: [
            {
              id: CLIMBING_CREW,
              ownerId: ALICE,
              name: 'Climbing crew',
              // Mallory is blocked by Alice — in the roster, not a friend.
              memberIds: [BOB, MALLORY],
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
      await withStale.ready();

      const members = (
        await withStale.inject({ method: 'GET', url: '/v1/me/circles', headers: as(ALICE) })
      ).json().circles[0].members;

      expect(members.find((m: { userId: string }) => m.userId === BOB).stillAFriend).toBe(true);
      const stale = members.find((m: { userId: string }) => m.userId === MALLORY);
      expect(stale).toBeDefined();
      expect(stale.stillAFriend).toBe(false);
    });

    it('makes a new circle usable as an audience immediately', async () => {
      // The adapter shares one array with the social graph; without that, an
      // audience would lag a request behind the edit that created it.
      const circle = (await create(ALICE, { name: 'Book club', memberIds: [CAROL] })).json();
      const shared = await repos.social.sharedCircles(CAROL, ALICE);
      expect(shared).toContain(circle.id);
    });

    it('renames without disturbing the roster', async () => {
      const circle = (await create(ALICE, { name: 'Book club', memberIds: [CAROL] })).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/me/circles/${circle.id}`,
        headers: as(ALICE),
        payload: { name: 'Reading group' },
      });
      expect(res.json().name).toBe('Reading group');
      expect(res.json().members).toHaveLength(1);
    });
  });

  // ── Deletion ───────────────────────────────────────────────────────
  describe('deletion', () => {
    it('removes the share rules that named it', async () => {
      // Alice's climbing event grants CIRCLE→FULL. Deleting the circle should
      // leave no rule pointing at a grouping that no longer exists.
      const before = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
        headers: as(ALICE),
      });
      expect(before.body).toContain(CLIMBING_CREW);

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/me/circles/${CLIMBING_CREW}`,
        headers: as(ALICE),
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
        headers: as(ALICE),
      });
      expect(after.body).not.toContain(CLIMBING_CREW);
    });

    it('narrows what a member could see, rather than widening it', async () => {
      /**
       * A fresh event with **no attendees**, because the attendee branch
       * returns FULL before rules are consulted — the seeded climbing event
       * has Bob as an attendee, so it would show him the location whether the
       * circle existed or not, and would prove nothing here.
       */
      const soon = new Date();
      soon.setDate(soon.getDate() + 2);
      soon.setHours(19, 0, 0, 0);
      const end = new Date(soon.getTime() + 3_600_000);

      await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: as(ALICE),
        payload: {
          title: 'Belay practice',
          location: 'The Warehouse, 3 Dock Rd',
          timeRange: { start: soon.toISOString(), end: end.toISOString() },
          shareRules: [
            { audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW }, level: 'FULL' },
            { audience: { kind: 'FRIENDS' }, level: 'TITLE' },
          ],
        },
      });

      const before = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
        headers: as(BOB),
      });
      expect(before.body).toContain('The Warehouse, 3 Dock Rd');

      await app.inject({
        method: 'DELETE',
        url: `/v1/me/circles/${CLIMBING_CREW}`,
        headers: as(ALICE),
        payload: {},
      });

      const after = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
        headers: as(BOB),
      });
      // Falls back to FRIENDS→TITLE: still the name, no longer the place.
      expect(after.body).toContain('Belay practice');
      expect(after.body).not.toContain('The Warehouse, 3 Dock Rd');
    });

    it('refuses deletion by anyone but the owner', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/me/circles/${CLIMBING_CREW}`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
