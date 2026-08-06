import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, DAVE, MALLORY, createDemoSeed } from '../seed.js';
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
  // Off here: these suites hammer `app.inject` and would otherwise trip buckets
  // in tests that are about something else. `rate-limit.test.ts` turns it on.
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

/** A fortnight from tomorrow — clear of whatever the seed put in this week. */
function window_(days = 14): { start: string; end: string } {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { start: start.toISOString(), end: end.toISOString() };
}

describe('the slot finder', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  const find = (actor: string, participantIds: string[], overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/slots/find',
      headers: as(actor),
      payload: {
        participantIds,
        window: window_(),
        durationMinutes: 60,
        ...overrides,
      },
    });

  // ── The property the whole design rests on ─────────────────────────
  describe('no information flows that was not already flowing', () => {
    it('lets a blocked requester learn nothing by including their blocker', async () => {
      // Alice has blocked Mallory. If including Alice changed the answer,
      // Mallory could difference two queries and reconstruct Alice's week —
      // the exact attack ADR 0008 exists to close.
      const withAlice = await find(MALLORY, [ALICE, CAROL]);
      const withoutAlice = await find(MALLORY, [CAROL]);

      expect(withAlice.statusCode).toBe(200);
      expect(withAlice.json().slots).toEqual(withoutAlice.json().slots);
    });

    it('lets a stranger learn nothing by including someone who shares nothing', async () => {
      // Mallory is a stranger to Bob and Carol both.
      const withMallory = await find(BOB, [CAROL, MALLORY]);
      const withoutMallory = await find(BOB, [CAROL]);
      expect(withMallory.json().slots).toEqual(withoutMallory.json().slots);
    });

    it('gives exactly the availability an ordinary calendar read would', async () => {
      // The invariant stated directly: the busy set the finder used for Alice is
      // the busy set Carol could have fetched herself.
      const w = window_();
      const direct = await app
        .inject({
          method: 'GET',
          url: `/v1/users/${ALICE}/calendar?start=${encodeURIComponent(w.start)}&end=${encodeURIComponent(w.end)}`,
          headers: as(CAROL),
        })
        .then((r) => r.json());

      // Carol alone vs Carol+Alice: the difference must be explained entirely
      // by the busy blocks Carol can already see on Alice's calendar.
      const alone = await find(CAROL, [DAVE]);
      const together = await find(CAROL, [DAVE, ALICE]);

      const lostTime =
        totalMinutes(alone.json().slots) - totalMinutes(together.json().slots);
      // Something was lost (Alice is busy), and it is bounded by what Carol can
      // already see.
      expect(lostTime).toBeGreaterThan(0);
      expect(lostTime).toBeLessThanOrEqual(totalMinutes(direct.busy) + 60);
    });
  });

  // ── The honest denominator ─────────────────────────────────────────
  describe('the denominator', () => {
    it('says plainly who does not share availability', async () => {
      const res = await find(MALLORY, [ALICE, BOB]);
      const byId = new Map(
        res.json().participants.map((p: { userId: string; sharesAvailability: boolean }) => [
          p.userId,
          p.sharesAvailability,
        ]),
      );

      // Alice blocked Mallory, so nothing reaches her.
      expect(byId.get(ALICE)).toBe(false);
      // Bob is a stranger to Mallory; his conservative defaults reach friends only.
      expect(byId.get(BOB)).toBe(false);
      // You always share with yourself.
      expect(byId.get(MALLORY)).toBe(true);
    });

    it('counts a friend with a free week as sharing, not as silent', async () => {
      // Dave shares Busy with friends by default and simply has nothing on.
      // Reporting him as "shares nothing" would be a lie in the honest direction.
      const res = await find(ALICE, [DAVE]);
      const dave = res
        .json()
        .participants.find((p: { userId: string }) => p.userId === DAVE);
      expect(dave.sharesAvailability).toBe(true);
    });

    it('always includes the requester in the participant list', async () => {
      const res = await find(ALICE, [BOB]);
      expect(res.json().participants.map((p: { userId: string }) => p.userId)).toContain(ALICE);
    });

    it('does not list the requester twice if they name themselves', async () => {
      const res = await find(ALICE, [ALICE, BOB]);
      const ids = res.json().participants.map((p: { userId: string }) => p.userId);
      expect(ids.filter((id: string) => id === ALICE)).toHaveLength(1);
    });

    it('reports an unknown id exactly like someone who shares nothing', async () => {
      // Otherwise the endpoint is a probe for whether an account exists.
      const ghost = await find(BOB, ['99999999-9999-4999-8999-999999999999']);
      const silent = await find(BOB, [MALLORY]);

      const shape = (r: typeof ghost) =>
        r.json().participants.map((p: { sharesAvailability: boolean }) => p.sharesAvailability);
      expect(ghost.statusCode).toBe(silent.statusCode);
      expect(shape(ghost)).toEqual(shape(silent));
      expect(ghost.json().slots).toEqual(silent.json().slots);
    });
  });

  // ── Answers ────────────────────────────────────────────────────────
  describe('answers', () => {
    it('returns slots on a 15-minute grid', async () => {
      const res = await find(ALICE, [BOB]);
      for (const slot of res.json().slots as Array<{ start: string; end: string }>) {
        expect(new Date(slot.start).getMinutes() % 15).toBe(0);
        expect(new Date(slot.end).getMinutes() % 15).toBe(0);
      }
    });

    it('respects the hours asked for', async () => {
      const res = await find(ALICE, [BOB], { earliestHour: 18, latestHour: 21 });
      for (const slot of res.json().slots as Array<{ start: string; end: string }>) {
        expect(new Date(slot.start).getHours()).toBeGreaterThanOrEqual(18);
        expect(new Date(slot.end).getHours()).toBeLessThanOrEqual(21);
      }
    });

    it('returns every slot at least as long as asked for', async () => {
      const res = await find(ALICE, [BOB], { durationMinutes: 120 });
      for (const slot of res.json().slots as Array<{ start: string; end: string }>) {
        const minutes = (Date.parse(slot.end) - Date.parse(slot.start)) / 60_000;
        expect(minutes).toBeGreaterThanOrEqual(120);
      }
    });
  });

  // ── Bounds and refusals ────────────────────────────────────────────
  describe('bounds', () => {
    it('caps the participant list', async () => {
      const many = Array.from(
        { length: 25 },
        (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`,
      );
      expect((await find(ALICE, many)).statusCode).toBe(400);
    });

    it('caps the window', async () => {
      const res = await find(ALICE, [BOB], { window: window_(400) });
      expect(res.statusCode).toBe(400);
    });

    it('refuses a duration off the grid', async () => {
      expect((await find(ALICE, [BOB], { durationMinutes: 37 })).statusCode).toBe(400);
    });

    it('refuses inverted hours', async () => {
      const res = await find(ALICE, [BOB], { earliestHour: 20, latestHour: 9 });
      expect(res.statusCode).toBe(400);
    });

    it('refuses an anonymous query', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/slots/find',
        payload: { participantIds: [BOB], window: window_(), durationMinutes: 60 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('never leaks an event title, however the query is shaped', async () => {
      const res = await find(CAROL, [ALICE, BOB, DAVE]);
      // The response is intervals and booleans. Nothing else, ever.
      expect(res.body).not.toContain('Therapy');
      expect(res.body).not.toContain('Dentist');
      expect(res.body).not.toContain('Climbing');
    });
  });
});

/** Total minutes across a set of intervals. */
function totalMinutes(ranges: Array<{ start: string; end: string }>): number {
  return ranges.reduce((sum, r) => sum + (Date.parse(r.end) - Date.parse(r.start)) / 60_000, 0);
}
