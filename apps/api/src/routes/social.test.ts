import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories, type MemorySeed } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, CLIMBING_CREW, DAVE, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

/**
 * Friend requests, unfriending, blocking, and search - at the HTTP boundary.
 *
 * The assertions that matter most here are the *negative* ones, and they are
 * negative in a specific way: not "this is refused" but "this is refused in a
 * way that is indistinguishable from the request never having been possible".
 *
 * See docs/adr/0028-friend-requests-and-blocking.md.
 */

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

/** A well-formed id belonging to nobody. */
const NOBODY = '99999999-9999-4999-8999-999999999999';

describe('friend requests and blocking', () => {
  let app: FastifyInstance;

  const boot = async (seed: MemorySeed = createDemoSeed()) => {
    app = await createServer({ config, repos: createMemoryRepositories(seed) });
    await app.ready();
    return app;
  };

  beforeEach(async () => {
    await boot();
  });

  const request = (from: string, to: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/people/${to}/friend-request`,
      headers: as(from),
      payload: {},
    });

  const respond = (from: string, to: string, decision: 'ACCEPT' | 'DECLINE') =>
    app.inject({
      method: 'POST',
      url: `/v1/me/friend-requests/${to}`,
      headers: as(from),
      payload: { decision },
    });

  const block = (from: string, to: string) =>
    app.inject({ method: 'PUT', url: `/v1/people/${to}/block`, headers: as(from), payload: {} });

  const unblock = (from: string, to: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/people/${to}/block`,
      headers: as(from),
      payload: {},
    });

  const unfriend = (from: string, to: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/people/${to}/friendship`,
      headers: as(from),
      payload: {},
    });

  const search = (from: string, q: string) =>
    app.inject({ method: 'GET', url: `/v1/people/search?q=${encodeURIComponent(q)}`, headers: as(from) });

  const friendIds = async (of: string): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: '/v1/people', headers: as(of) });
    return res.json().people.map((p: { id: string }) => p.id);
  };

  describe('sending a request', () => {
    it('creates a pending request that both parties can see', async () => {
      // MALLORY is a stranger to BOB in the seed.
      const res = await request(BOB, MALLORY);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ userId: MALLORY, sentByYou: true });

      const inbox = await app.inject({
        method: 'GET',
        url: '/v1/me/friend-requests',
        headers: as(MALLORY),
      });
      expect(inbox.json().requests).toMatchObject([{ userId: BOB, sentByYou: false }]);
    });

    it('does not make them friends yet', async () => {
      await request(BOB, MALLORY);
      expect(await friendIds(BOB)).not.toContain(MALLORY);
      // The one that would actually hurt: a pending request must not open a
      // calendar. `/v1/people` is the list of people you can ask about.
      expect(await friendIds(MALLORY)).not.toContain(BOB);
    });

    it('refuses a second request to the same person', async () => {
      // 409, not 404: re-asking is refused only *after* the identity check
      // passed, so the caller demonstrably already knows this person exists.
      await request(BOB, MALLORY);
      expect((await request(BOB, MALLORY)).statusCode).toBe(409);
    });

    it('refuses a request to someone who is already a friend', async () => {
      expect((await request(ALICE, BOB)).statusCode).toBe(409);
    });

    it('refuses a request to yourself', async () => {
      expect((await request(ALICE, ALICE)).statusCode).toBe(404);
    });

    it('answers a blocked target exactly as it answers a nonexistent one', async () => {
      // ALICE blocked MALLORY in the seed. If these two differed in status,
      // body, or shape, MALLORY could probe for the block.
      const blocked = await request(MALLORY, ALICE);
      const missing = await request(MALLORY, NOBODY);

      expect(blocked.statusCode).toBe(missing.statusCode);
      expect(blocked.body).toBe(missing.body);
      expect(blocked.statusCode).toBe(404);
    });

    it('refuses an anonymous request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/people/${BOB}/friend-request`,
        payload: {},
      });
      // 401 rather than 404: telling an unauthenticated caller to sign in
      // reveals nothing they could not learn by signing in.
      expect(res.statusCode).toBe(401);
    });
  });

  describe('answering a request', () => {
    it('makes them friends on accept, both ways', async () => {
      await request(BOB, MALLORY);
      const res = await respond(MALLORY, BOB, 'ACCEPT');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'FRIEND' });

      expect(await friendIds(BOB)).toContain(MALLORY);
      expect(await friendIds(MALLORY)).toContain(BOB);
    });

    it('refuses to let the sender accept their own request', async () => {
      await request(BOB, MALLORY);
      expect((await respond(BOB, MALLORY, 'ACCEPT')).statusCode).toBe(404);
      expect(await friendIds(BOB)).not.toContain(MALLORY);
    });

    it('leaves no trace on decline, so "not yet" and "no" look the same', async () => {
      await request(BOB, MALLORY);
      expect((await respond(MALLORY, BOB, 'DECLINE')).json()).toEqual({ status: 'NONE' });

      // Nothing in BOB's outbox says he was turned down…
      const outbox = await app.inject({
        method: 'GET',
        url: '/v1/me/friend-requests',
        headers: as(BOB),
      });
      expect(outbox.json().requests).toEqual([]);
      expect(outbox.body).not.toContain('DECLINE');

      // …and asking again is an ordinary request, not a special case.
      expect((await request(BOB, MALLORY)).statusCode).toBe(200);
    });

    it('refuses to answer a request that does not exist', async () => {
      expect((await respond(MALLORY, BOB, 'ACCEPT')).statusCode).toBe(404);
    });

    it('refuses to answer on behalf of two other people', async () => {
      await request(BOB, MALLORY);
      // CAROL is party to neither side. The route is addressed by *the other
      // party*, so there is no id she could supply that names someone else's
      // request - she can only ever look up a row she is on.
      expect((await respond(CAROL, MALLORY, 'ACCEPT')).statusCode).toBe(404);

      const inbox = await app.inject({
        method: 'GET',
        url: '/v1/me/friend-requests',
        headers: as(MALLORY),
      });
      expect(inbox.json().requests).toHaveLength(1);
    });
  });

  describe('unfriending', () => {
    it('removes the friendship for both parties', async () => {
      expect((await unfriend(ALICE, BOB)).statusCode).toBe(200);

      expect(await friendIds(ALICE)).not.toContain(BOB);
      expect(await friendIds(BOB)).not.toContain(ALICE);
    });

    it('withdraws a request you sent', async () => {
      await request(BOB, MALLORY);
      await unfriend(BOB, MALLORY);

      const inbox = await app.inject({
        method: 'GET',
        url: '/v1/me/friend-requests',
        headers: as(MALLORY),
      });
      expect(inbox.json().requests).toEqual([]);
    });

    it('leaves the circle roster alone, and the roster grants nothing', async () => {
      /**
       * ADR 0023: unfriending deliberately does not scrub rosters, because the
       * friendship re-check in `audienceMatches` makes a stale entry inert.
       * This is the test that proves the re-check does the work.
       *
       * Written against a *fresh* event rather than the seed's climbing night,
       * because BOB is an attendee there and the attendee branch returns FULL
       * before any rule is consulted - it would stay visible after unfriending
       * for a reason that has nothing to do with the circle.
       */
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(20, 0, 0, 0);
      const end = new Date(start);
      end.setHours(21, 0, 0, 0);

      const created = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: as(ALICE),
        payload: {
          title: 'Route setting',
          location: '9 Quarry Lane',
          timeRange: { start: start.toISOString(), end: end.toISOString() },
          shareRules: [{ audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW }, level: 'FULL' }],
        },
      });
      expect(created.statusCode).toBe(200);

      // BOB is in the climbing crew, so the circle rule reaches him.
      const before = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${weekWindow()}`,
        headers: as(BOB),
      });
      expect(before.body).toContain('Quarry Lane');

      await unfriend(ALICE, BOB);

      const after = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?${weekWindow()}`,
        headers: as(BOB),
      });
      // He is still on the roster, and it buys him nothing - not the location,
      // not the title, not the fact that the hour is occupied.
      expect(after.body).not.toContain('Quarry Lane');
      expect(after.body).not.toContain('Route setting');

      // …and ALICE is shown the truth about her own roster rather than a
      // quietly edited list.
      const circles = await app.inject({
        method: 'GET',
        url: '/v1/me/circles',
        headers: as(ALICE),
      });
      expect(circles.json().circles[0].members).toMatchObject([
        { userId: BOB, stillAFriend: false },
      ]);
    });

    it('refuses when there is no friendship to remove', async () => {
      expect((await unfriend(BOB, MALLORY)).statusCode).toBe(404);
    });
  });

  describe('blocking', () => {
    it('severs an existing friendship', async () => {
      expect((await block(ALICE, BOB)).statusCode).toBe(200);
      expect(await friendIds(ALICE)).not.toContain(BOB);
      expect(await friendIds(BOB)).not.toContain(ALICE);
    });

    it('cancels a pending request in either direction', async () => {
      await request(BOB, MALLORY);
      await block(MALLORY, BOB);

      const outbox = await app.inject({
        method: 'GET',
        url: '/v1/me/friend-requests',
        headers: as(BOB),
      });
      expect(outbox.json().requests).toEqual([]);
    });

    it('succeeds against a stranger and a nonexistent id alike', async () => {
      // "That user does not exist" in response to a block attempt is an
      // existence oracle, and blocking is the worst moment to hand one out.
      expect((await block(CAROL, MALLORY)).statusCode).toBe(200);
      expect((await block(CAROL, NOBODY)).statusCode).toBe(200);
    });

    it('refuses to let you block yourself', async () => {
      expect((await block(ALICE, ALICE)).statusCode).toBe(404);
    });

    it('lists who you blocked, and never who blocked you', async () => {
      await block(ALICE, BOB);

      const mine = await app.inject({ method: 'GET', url: '/v1/me/blocks', headers: as(ALICE) });
      // MALLORY is blocked in the seed; BOB is the one just added.
      expect(mine.json().blocked.map((p: { id: string }) => p.id).sort()).toEqual(
        [BOB, MALLORY].sort(),
      );

      // BOB has been blocked by ALICE and by nobody else. His own list is empty
      // and his response body must not name her.
      const theirs = await app.inject({ method: 'GET', url: '/v1/me/blocks', headers: as(BOB) });
      expect(theirs.json().blocked).toEqual([]);
      expect(theirs.body).not.toContain(ALICE);
    });

    it('lets a blocked party still block back', async () => {
      // `block:*` is block-exempt for exactly this: an abuser must not be able
      // to block someone out of defending themselves.
      await block(ALICE, MALLORY); // already seeded, but stated here explicitly
      expect((await block(MALLORY, ALICE)).statusCode).toBe(200);
    });
  });

  describe('unblocking', () => {
    it('restores visibility when only one side had blocked', async () => {
      // CAROL and DAVE are strangers in the seed, so this pair starts clean.
      await block(CAROL, DAVE);
      expect((await search(CAROL, 'dave')).json().results).toEqual([]);

      expect((await unblock(CAROL, DAVE)).statusCode).toBe(200);
      expect((await search(CAROL, 'dave')).json().results).toHaveLength(1);
    });

    it('does NOT lift the other party’s block', async () => {
      /**
       * The reason `blocks` is directed (ADR 0028). With a single canonical row
       * per pair, ALICE unblocking MALLORY would clear MALLORY's block on ALICE
       * too - handing the person MALLORY wanted away from her the power to undo
       * her protection. This is the regression test for that whole class.
       */
      await block(MALLORY, ALICE); // ALICE→MALLORY is already in the seed
      await unblock(ALICE, MALLORY);

      // ALICE's own row is gone…
      const hers = await app.inject({ method: 'GET', url: '/v1/me/blocks', headers: as(ALICE) });
      expect(hers.json().blocked).toEqual([]);

      // …MALLORY's stands, and they remain invisible to each other.
      const theirs = await app.inject({
        method: 'GET',
        url: '/v1/me/blocks',
        headers: as(MALLORY),
      });
      expect(theirs.json().blocked.map((p: { id: string }) => p.id)).toEqual([ALICE]);

      expect((await search(ALICE, 'mallory')).json().results).toEqual([]);
      expect((await search(MALLORY, 'alice')).json().results).toEqual([]);
    });

    it('does not restore the friendship the block severed', async () => {
      await block(ALICE, BOB);
      await unblock(ALICE, BOB);
      expect(await friendIds(ALICE)).not.toContain(BOB);
    });

    it('is idempotent', async () => {
      expect((await unblock(CAROL, DAVE)).statusCode).toBe(200);
      expect((await unblock(CAROL, DAVE)).statusCode).toBe(200);
    });
  });

  describe('discoverability', () => {
    const setDiscoverability = (of: string, value: string) =>
      app.inject({
        method: 'PUT',
        url: '/v1/me/discoverability',
        headers: as(of),
        payload: { discoverability: value },
      });

    it('defaults to EVERYONE and is reported on /v1/me', async () => {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: as(ALICE) });
      expect(me.json().discoverability).toBe('EVERYONE');
    });

    it('hides a NOBODY account from search entirely', async () => {
      expect((await search(MALLORY, 'carol')).json().results).toHaveLength(1);
      expect((await setDiscoverability(CAROL, 'NOBODY')).statusCode).toBe(200);
      expect((await search(MALLORY, 'carol')).json().results).toEqual([]);
      expect((await search(MALLORY, 'Mensah')).json().results).toEqual([]);
    });

    it('makes NOBODY indistinguishable from a handle nobody has', async () => {
      // The whole point: opting out must not be detectable, or the setting
      // becomes a signal about the person who chose it.
      await setDiscoverability(CAROL, 'NOBODY');
      const hidden = await search(MALLORY, 'carol');
      const missing = await search(MALLORY, 'zzzznobody');
      expect(hidden.statusCode).toBe(missing.statusCode);
      expect(hidden.body).toBe(missing.body);
    });

    it('EXACT_HANDLE answers a full handle and nothing shorter', async () => {
      await setDiscoverability(CAROL, 'EXACT_HANDLE');
      expect((await search(MALLORY, 'car')).json().results).toEqual([]);
      expect((await search(MALLORY, 'Mensah')).json().results).toEqual([]);
      expect((await search(MALLORY, 'carol')).json().results).toMatchObject([{ handle: 'carol' }]);
    });

    it('never reports anyone else’s setting', async () => {
      await setDiscoverability(CAROL, 'EXACT_HANDLE');
      // Not in a search hit, and not on the public profile: "why can't I find
      // them" is itself an answer about them.
      const hit = await search(MALLORY, 'carol');
      expect(hit.body).not.toContain('discoverability');

      const profile = await app.inject({
        method: 'GET',
        url: `/v1/people/${CAROL}`,
        headers: as(ALICE),
      });
      expect(profile.body).not.toContain('discoverability');
    });

    it('leaves existing friendships alone', async () => {
      // Being unfindable is not being unfriended. ALICE and CAROL are friends
      // in the seed and stay so.
      await setDiscoverability(CAROL, 'NOBODY');
      const res = await app.inject({ method: 'GET', url: '/v1/people', headers: as(ALICE) });
      expect(res.json().people.map((p: { id: string }) => p.id)).toContain(CAROL);
    });

    it('refuses an unknown value, and an anonymous caller', async () => {
      expect((await setDiscoverability(ALICE, 'FRIENDS_OF_FRIENDS')).statusCode).toBe(400);
      const anon = await app.inject({
        method: 'PUT',
        url: '/v1/me/discoverability',
        payload: { discoverability: 'NOBODY' },
      });
      expect(anon.statusCode).toBe(401);
    });
  });

  describe('search', () => {
    it('finds someone by handle prefix and by display name', async () => {
      expect((await search(MALLORY, 'car')).json().results).toMatchObject([{ handle: 'carol' }]);
      expect((await search(MALLORY, 'Mensah')).json().results).toMatchObject([
        { handle: 'carol' },
      ]);
    });

    it('reports how you stand with each result', async () => {
      const friend = (await search(ALICE, 'bob')).json().results[0];
      expect(friend).toMatchObject({ status: 'FRIEND' });

      await request(BOB, MALLORY);
      expect((await search(BOB, 'mallory')).json().results[0]).toMatchObject({
        status: 'REQUESTED',
      });
      expect((await search(MALLORY, 'bob')).json().results[0]).toMatchObject({
        status: 'AWAITING_YOU',
      });
    });

    it('hides a blocked pair from each other, in both directions', async () => {
      // ALICE blocked MALLORY. Neither can find the other, and neither result
      // differs from searching for a handle nobody has.
      expect((await search(ALICE, 'mallory')).json().results).toEqual([]);
      expect((await search(MALLORY, 'alice')).json().results).toEqual([]);
      expect((await search(ALICE, 'zzz')).json().results).toEqual([]);
    });

    it('never returns you to yourself', async () => {
      expect((await search(ALICE, 'alice')).json().results).toEqual([]);
    });

    it('refuses a query too short to be a search', async () => {
      // A one-character query is directory enumeration wearing a hat.
      expect((await search(ALICE, 'a')).statusCode).toBe(400);
    });

    it('refuses an anonymous search', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/people/search?q=alice' });
      expect(res.statusCode).toBe(401);
    });

    it('returns nothing beyond handle, name, and status', async () => {
      const [result] = (await search(MALLORY, 'carol')).json().results;
      expect(Object.keys(result).sort()).toEqual(['displayName', 'handle', 'id', 'status']);
    });
  });
});

function weekWindow(): string {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 21);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(
    end.toISOString(),
  )}`;
}
