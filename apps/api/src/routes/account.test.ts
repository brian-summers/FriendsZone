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
  MODERATOR_IDS: [DAVE],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

const DETAIL = 'He keeps messaging me after I asked him to stop.';

function windowQs(): string {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
}

describe('export and deletion', () => {
  let app: FastifyInstance;
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(async () => {
    repos = createMemoryRepositories(createDemoSeed());
    app = await createServer({ config, repos });
    await app.ready();
  });

  const exportFor = (actor: string) =>
    app.inject({ method: 'GET', url: '/v1/me/export', headers: as(actor) });

  const deleteAccount = (actor: string, confirmHandle: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/delete',
      headers: as(actor),
      payload: { confirmHandle },
    });

  // ── Export ─────────────────────────────────────────────────────────
  describe('export', () => {
    it('gives you your own calendar in full', async () => {
      const res = await exportFor(ALICE);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profile.id).toBe(ALICE);
      // Her own events, including the ones nobody else can see.
      expect(res.body).toContain('Therapy');
      expect(body.sharingDefaults.rules).toBeDefined();
    });

    it('never tells a reported person who reported them', async () => {
      // The single most important assertion in this file. Bob reports Alice, a
      // moderator opens a thread with her, and Alice exports her data.
      await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: as(BOB),
        payload: { subject: { kind: 'USER', userId: ALICE }, reason: 'HARASSMENT', detail: DETAIL },
      });
      const reportId = (await repos.reports.queue(10))[0]!.id;
      await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${reportId}/notes`,
        headers: as(DAVE),
        payload: { audience: 'SUBJECT', body: 'Please review our guidance.' },
      });

      const res = await exportFor(ALICE);
      expect(res.json().reportsAboutYou).toHaveLength(1);

      /**
       * Scoped to the report section, and asserted on *its* serialised form.
       *
       * Not the whole file: Bob legitimately appears elsewhere in Alice's
       * export as an attendee of her own climbing event, which she has always
       * been able to see. The claim being tested is narrower and sharper - that
       * a report about you never carries who filed it.
       */
      const reportSection = JSON.stringify(res.json().reportsAboutYou);
      expect(reportSection).not.toContain(BOB);
      expect(reportSection).not.toContain('reporterId');
      expect(reportSection).toContain('Please review our guidance.');

      // The reporter's own words identify them and must not appear anywhere.
      expect(res.body).not.toContain(DETAIL);
    });

    it('gives a reporter their own report, with their own words', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: as(BOB),
        payload: { subject: { kind: 'USER', userId: ALICE }, reason: 'HARASSMENT', detail: DETAIL },
      });

      const res = await exportFor(BOB);
      expect(res.json().reportsYouFiled).toHaveLength(1);
      expect(res.body).toContain(DETAIL);
    });

    it('does not include other people’s claims on your listing', async () => {
      // Carol claims Alice's skillet; Carol exports. She gets her own claim and
      // nothing about the listing's other interest.
      const listing = await app
        .inject({
          method: 'POST',
          url: '/v1/listings',
          headers: as(ALICE),
          payload: {
            title: 'Skillet',
            condition: 'GOOD',
            audience: { kind: 'FRIENDS' },
            claimMode: 'OWNER_SELECTS',
          },
        })
        .then((r) => r.json());

      await app.inject({
        method: 'POST',
        url: `/v1/listings/${listing.id}/claims`,
        headers: as(BOB),
        payload: { message: 'bob wants it' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/listings/${listing.id}/claims`,
        headers: as(CAROL),
        payload: { message: 'carol wants it' },
      });

      const res = await exportFor(CAROL);
      expect(res.body).toContain('carol wants it');
      expect(res.body).not.toContain('bob wants it');
      expect(res.body).not.toContain(BOB);
    });

    it('carries a readme saying what is deliberately missing', async () => {
      const res = await exportFor(ALICE);
      expect(res.json().readme).toContain('Who reported you');
    });

    it('requires a session', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/me/export' })).statusCode).toBe(401);
    });
  });

  // ── Deletion ───────────────────────────────────────────────────────
  describe('deletion', () => {
    it('requires your own handle typed correctly', async () => {
      expect((await deleteAccount(ALICE, 'bob')).statusCode).toBe(409);
      expect((await deleteAccount(ALICE, 'alice')).statusCode).toBe(200);
    });

    it('empties the profile but keeps the id resolvable', async () => {
      await deleteAccount(ALICE, 'alice');

      expect(await repos.directory.isTombstoned(ALICE)).toBe(true);
      const profile = await repos.directory.profile(ALICE);
      // Present - every hangout and moderation case still resolves it - and empty.
      expect(profile).not.toBeNull();
      expect(profile?.displayName).toBe('A former member');
      expect(profile?.handle).not.toBe('alice');
    });

    it('destroys their calendar, listings, and photos', async () => {
      const key = (
        await app.inject({
          method: 'POST',
          url: '/v1/photos',
          headers: as(ALICE),
          payload: {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        })
      ).json().key;
      await app.inject({
        method: 'POST',
        url: '/v1/listings',
        headers: as(ALICE),
        payload: {
          title: 'Skillet',
          condition: 'GOOD',
          audience: { kind: 'FRIENDS' },
          claimMode: 'FIRST_COME',
          photoKeys: [key],
        },
      });

      await deleteAccount(ALICE, 'alice');

      expect(await repos.calendar.eventsInWindow(ALICE, {
        start: new Date(0).toISOString(),
        end: new Date(Date.now() + 8.64e10).toISOString(),
      })).toEqual([]);
      expect(await repos.listings.recent(100)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ ownerId: ALICE })]),
      );
      // The bytes go too, not just the reference.
      expect(await repos.photos.get(key)).toBeNull();
    });

    it('leaves a block standing', async () => {
      // Alice blocked Mallory. If deleting cleared it, delete-and-rejoin would
      // be a documented route back to someone who blocked you (ADR 0004).
      await deleteAccount(ALICE, 'alice');
      expect(await repos.social.relationship(MALLORY, ALICE)).toBe('BLOCKED');
    });

    it('does not delete the counterparty’s copy of a shared plan', async () => {
      // Alice and Bob agree a handoff; Alice deletes. Bob's calendar entry is
      // his record of his own week, not hers to remove.
      const listing = await app
        .inject({
          method: 'POST',
          url: '/v1/listings',
          headers: as(ALICE),
          payload: {
            title: 'Skillet',
            condition: 'GOOD',
            audience: { kind: 'FRIENDS' },
            claimMode: 'FIRST_COME',
          },
        })
        .then((r) => r.json());
      await app.inject({
        method: 'POST',
        url: `/v1/listings/${listing.id}/claims`,
        headers: as(BOB),
        payload: {},
      });
      const claimId = (await repos.listings.claimsFor(listing.id))[0]!.id;

      const soon = new Date();
      soon.setDate(soon.getDate() + 3);
      const end = new Date(soon.getTime() + 3_600_000);
      const exchange = await app
        .inject({
          method: 'POST',
          url: `/v1/claims/${claimId}/exchange`,
          headers: as(ALICE),
          payload: {
            timeRange: { start: soon.toISOString(), end: end.toISOString() },
            location: 'Trellis Cafe',
          },
        })
        .then((r) => r.json());
      await app.inject({
        method: 'POST',
        url: `/v1/exchanges/${exchange.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'ACCEPT' },
      });

      await deleteAccount(ALICE, 'alice');

      const bobWeek = await app.inject({
        method: 'GET',
        url: `/v1/users/${BOB}/calendar?${windowQs()}`,
        headers: as(BOB),
      });
      expect(bobWeek.body).toContain('Handoff');
      // …and it no longer names her.
      expect(bobWeek.body).not.toContain(ALICE);
    });

    it('keeps a live moderation case about them', async () => {
      // Otherwise deletion is an escape hatch: harass, get reported, delete.
      await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: as(BOB),
        payload: { subject: { kind: 'USER', userId: ALICE }, reason: 'HARASSMENT' },
      });
      await deleteAccount(ALICE, 'alice');

      const queue = await app.inject({
        method: 'GET',
        url: '/v1/moderation/reports',
        headers: as(DAVE),
      });
      expect(queue.json().reports).toHaveLength(1);
    });

    it('erases a closed case once they leave', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: as(BOB),
        payload: { subject: { kind: 'USER', userId: ALICE }, reason: 'SPAM' },
      });
      const reportId = (await repos.reports.queue(10))[0]!.id;
      await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${reportId}/dispose`,
        headers: as(DAVE),
        payload: { status: 'DISMISSED' },
      });

      await deleteAccount(ALICE, 'alice');
      expect(await repos.reports.queue(10)).toEqual([]);
    });

    it('tells the user plainly what was kept', async () => {
      const res = await deleteAccount(ALICE, 'alice');
      const retained: string[] = res.json().retained;
      expect(retained.join(' ')).toContain('Blocks');
      expect(retained.join(' ')).toContain('moderation');
    });

    it('requires a session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/delete',
        payload: { confirmHandle: 'alice' },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
