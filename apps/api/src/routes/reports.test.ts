import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, DAVE, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

/**
 * BOB reports ALICE. DAVE is the moderator — deliberately someone with no
 * special relationship to either of them.
 */
const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [DAVE],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  // Off here: these suites hammer `app.inject` and would otherwise trip buckets
  // in tests that are about something else. `rate-limit.test.ts` turns it on.
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DETAIL = 'He keeps messaging me about the bike after I asked him to stop.';

describe('reporting and moderation', () => {
  let app: FastifyInstance;
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(async () => {
    repos = createMemoryRepositories(createDemoSeed());
    app = await createServer({ config, repos });
    await app.ready();
  });

  const offer = (body: Record<string, unknown> = {}, actor = ALICE) =>
    app
      .inject({
        method: 'POST',
        url: '/v1/listings',
        headers: as(actor),
        payload: {
          title: 'Free bike, message me',
          condition: 'GOOD',
          audience: { kind: 'FRIENDS' },
          claimMode: 'FIRST_COME',
          ...body,
        },
      })
      .then((r) => r.json());

  const file = (payload: Record<string, unknown>, actor = BOB) =>
    app.inject({ method: 'POST', url: '/v1/reports', headers: as(actor), payload });

  const reportListing = async (extra: Record<string, unknown> = {}) => {
    const listing = await offer();
    const res = await file({
      subject: { kind: 'LISTING', listingId: listing.id },
      reason: 'HARASSMENT',
      detail: DETAIL,
      ...extra,
    });
    return { listing, report: res.json(), res };
  };

  const modNote = (id: string, audience: 'REPORTER' | 'SUBJECT', body: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/moderation/reports/${id}/notes`,
      headers: as(DAVE),
      payload: { audience, body },
    });

  // ── Filing ─────────────────────────────────────────────────────────
  describe('filing', () => {
    it('files a report and returns the reporter’s own view', async () => {
      const { res, report } = await reportListing();
      expect(res.statusCode).toBe(200);
      expect(report.reason).toBe('HARASSMENT');
      expect(report.status).toBe('OPEN');
      expect(report.subjectKind).toBe('LISTING');
    });

    it('sends a content-free pointer to the moderation address', async () => {
      const { listing } = await reportListing();
      const notifier = repos.notifier as unknown as {
        sent: Array<Record<string, string>>;
      };

      expect(notifier.sent).toHaveLength(1);
      const [pointer] = notifier.sent;
      // Reason and kind only. Nothing that identifies a person or quotes them.
      expect(Object.keys(pointer!).sort()).toEqual(['reason', 'reportId', 'subjectKind']);
      const serialised = JSON.stringify(pointer);
      expect(serialised).not.toContain(BOB);
      expect(serialised).not.toContain(ALICE);
      expect(serialised).not.toContain(listing.title);
      expect(serialised).not.toContain(DETAIL);
    });

    it('refuses to report material you cannot see, indistinguishably from a bad id', async () => {
      // Carol is a friend of Alice but not in the climbing circle.
      const hidden = await offer({
        audience: { kind: 'CIRCLE', circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      });

      const unseen = await file(
        { subject: { kind: 'LISTING', listingId: hidden.id }, reason: 'SPAM' },
        CAROL,
      );
      const missing = await file(
        {
          subject: { kind: 'LISTING', listingId: '99999999-9999-4999-8999-999999999999' },
          reason: 'SPAM',
        },
        CAROL,
      );

      // Identical, or POST /v1/reports is a probe for whether an id exists.
      expect(unseen.statusCode).toBe(missing.statusCode);
      expect(unseen.body).toBe(missing.body);
      expect(unseen.statusCode).toBe(404);
    });

    it('lets someone report a user they are blocked with', async () => {
      // Alice has blocked Mallory. Mallory must still be able to report her:
      // an abuser must not be able to block their way out of a report.
      const res = await file(
        { subject: { kind: 'USER', userId: ALICE }, reason: 'HARASSMENT' },
        MALLORY,
      );
      expect(res.statusCode).toBe(200);
    });

    it('still refuses a blocked reporter any of the subject’s content', async () => {
      const listing = await offer();
      const res = await file(
        { subject: { kind: 'LISTING', listingId: listing.id }, reason: 'SPAM' },
        MALLORY,
      );
      // Filing is not seeing: the material is projected first, and Mallory
      // cannot see it, so there is nothing to capture.
      expect(res.statusCode).toBe(404);
    });

    it('refuses a report about yourself', async () => {
      const res = await file({ subject: { kind: 'USER', userId: BOB }, reason: 'SPAM' }, BOB);
      expect(res.statusCode).toBe(404);
    });

    it('allows one live report per pair', async () => {
      await reportListing();
      const second = await file({ subject: { kind: 'USER', userId: ALICE }, reason: 'SPAM' });
      expect(second.statusCode).toBe(409);
    });

    it('refuses an anonymous report', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/reports',
        payload: { subject: { kind: 'USER', userId: ALICE }, reason: 'SPAM' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── The anonymity guarantee ────────────────────────────────────────
  describe('keeping the parties apart', () => {
    it('tells the subject nothing until a moderator makes contact', async () => {
      const { report } = await reportListing();

      const before = await app.inject({
        method: 'GET',
        url: '/v1/reports/about-me',
        headers: as(ALICE),
      });
      expect(before.json().reports).toEqual([]);

      // Reading it directly is refused too — not a different error, just gone.
      const direct = await app.inject({
        method: 'GET',
        url: `/v1/moderation/reports/${report.id}`,
        headers: as(ALICE),
      });
      expect(direct.statusCode).toBe(404);
    });

    it('never reveals the reporter to the subject, once contacted', async () => {
      const { report } = await reportListing();
      await modNote(report.id, 'SUBJECT', 'We had a report about a listing. Please review.');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/reports/about-me',
        headers: as(ALICE),
      });

      expect(res.json().reports).toHaveLength(1);
      // The whole feature, asserted on the serialised body.
      expect(res.body).not.toContain(BOB);
      expect(res.body).not.toContain(DETAIL);
      expect(res.body).not.toContain('reporterId');
    });

    it('keeps the two threads from ever crossing', async () => {
      const { report } = await reportListing();
      await modNote(report.id, 'REPORTER', 'Thanks — can you tell us when this started?');
      await modNote(report.id, 'SUBJECT', 'Please review our conduct guidance.');

      await app.inject({
        method: 'POST',
        url: `/v1/reports/${report.id}/reply`,
        headers: as(BOB),
        payload: { body: 'It started last Tuesday.' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/reports/${report.id}/reply`,
        headers: as(ALICE),
        payload: { body: 'I did not know it was unwelcome.' },
      });

      const reporterSide = await app.inject({
        method: 'GET',
        url: '/v1/reports',
        headers: as(BOB),
      });
      const subjectSide = await app.inject({
        method: 'GET',
        url: '/v1/reports/about-me',
        headers: as(ALICE),
      });

      // Each sees their own two messages and neither of the other's.
      expect(reporterSide.body).toContain('when this started');
      expect(reporterSide.body).toContain('last Tuesday');
      expect(reporterSide.body).not.toContain('conduct guidance');
      expect(reporterSide.body).not.toContain('I did not know');

      expect(subjectSide.body).toContain('conduct guidance');
      expect(subjectSide.body).toContain('I did not know');
      expect(subjectSide.body).not.toContain('when this started');
      expect(subjectSide.body).not.toContain('last Tuesday');
    });

    it('never names which moderator is handling it', async () => {
      const { report } = await reportListing();
      await modNote(report.id, 'REPORTER', 'Looking into it.');

      const res = await app.inject({ method: 'GET', url: '/v1/reports', headers: as(BOB) });
      expect(res.body).not.toContain(DAVE);
      expect(res.json().reports[0].notes[0].fromModerator).toBe(true);
    });

    it('refuses a reply from an uninvolved user', async () => {
      const { report } = await reportListing();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reports/${report.id}/reply`,
        headers: as(CAROL),
        payload: { body: 'let me in' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses a reply from the subject before they have been contacted', async () => {
      const { report } = await reportListing();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reports/${report.id}/reply`,
        headers: as(ALICE),
        payload: { body: 'who said that?' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('does not list other people’s reports as your own', async () => {
      await reportListing();
      const res = await app.inject({ method: 'GET', url: '/v1/reports', headers: as(CAROL) });
      expect(res.json().reports).toEqual([]);
    });
  });

  // ── The queue ──────────────────────────────────────────────────────
  describe('the moderation queue', () => {
    it('is invisible to everyone not on the allowlist', async () => {
      await reportListing();
      for (const who of [ALICE, BOB, CAROL]) {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/moderation/reports',
          headers: as(who),
        });
        expect(res.statusCode).toBe(404);
      }
      expect(
        (await app.inject({ method: 'GET', url: '/v1/moderation/reports' })).statusCode,
      ).toBe(401);
    });

    it('gives a moderator the case file, both threads, and the evidence', async () => {
      const { report } = await reportListing();
      await modNote(report.id, 'REPORTER', 'Thanks.');
      await modNote(report.id, 'SUBJECT', 'Please review.');

      const res = await app.inject({
        method: 'GET',
        url: `/v1/moderation/reports/${report.id}`,
        headers: as(DAVE),
      });
      const body = res.json();

      expect(body.reporterId).toBe(BOB);
      expect(body.subjectUserId).toBe(ALICE);
      expect(body.detail).toBe(DETAIL);
      expect(body.evidence.fields[0].value).toBe('Free bike, message me');
      // Two arrays, never one merged list.
      expect(body.reporterNotes).toHaveLength(1);
      expect(body.subjectNotes).toHaveLength(1);
      expect(body.notes).toBeUndefined();
    });

    it('keeps the evidence after the material is deleted', async () => {
      const { listing, report } = await reportListing();
      await app.inject({
        method: 'POST',
        url: `/v1/listings/${listing.id}/withdraw`,
        headers: as(ALICE),
        payload: {},
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/moderation/reports/${report.id}`,
        headers: as(DAVE),
      });
      expect(res.json().evidence.fields[0].value).toBe('Free bike, message me');
    });

    it('does not give a moderator a master key to the calendar', async () => {
      // The power is scoped to reports. Dave shares no circle with Alice, so
      // her circle-only events stay hidden from him exactly as before.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${ALICE}/calendar?start=${encodeURIComponent(new Date().toISOString())}&end=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`,
        headers: as(DAVE),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Therapy');
    });

    it('serves an evidence photo only through its own report', async () => {
      const key = (
        await app.inject({
          method: 'POST',
          url: '/v1/photos',
          headers: as(ALICE),
          payload: { data: PNG_BASE64 },
        })
      ).json().key;

      const listing = await offer({ photoKeys: [key] });
      const report = (
        await file({ subject: { kind: 'LISTING', listingId: listing.id }, reason: 'SEXUAL_CONTENT' })
      ).json();

      const ok = await app.inject({
        method: 'GET',
        url: `/v1/moderation/reports/${report.id}/photos/${key}`,
        headers: as(DAVE),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toContain('image/png');

      // A key not in *this* report's snapshot is refused, so the moderation
      // role is not a read-anything capability over the photo store.
      const otherKey = (
        await app.inject({
          method: 'POST',
          url: '/v1/photos',
          headers: as(ALICE),
          payload: { data: PNG_BASE64 },
        })
      ).json().key;

      const refused = await app.inject({
        method: 'GET',
        url: `/v1/moderation/reports/${report.id}/photos/${otherKey}`,
        headers: as(DAVE),
      });
      expect(refused.statusCode).toBe(404);
    });
  });

  // ── Disposition ────────────────────────────────────────────────────
  describe('disposition', () => {
    it('upholds a report and takes the listing down', async () => {
      const { listing, report } = await reportListing();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${report.id}/dispose`,
        headers: as(DAVE),
        payload: { status: 'UPHELD', resolutionNote: 'Removed.', takeDown: true },
      });
      expect(res.json().status).toBe('UPHELD');

      const gone = await app.inject({
        method: 'GET',
        url: `/v1/listings/${listing.id}`,
        headers: as(ALICE),
      });
      expect(gone.json().status).toBe('WITHDRAWN');
    });

    it('dismisses without touching the material', async () => {
      const { listing, report } = await reportListing();
      await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${report.id}/dispose`,
        headers: as(DAVE),
        payload: { status: 'DISMISSED' },
      });

      const still = await app.inject({
        method: 'GET',
        url: `/v1/listings/${listing.id}`,
        headers: as(ALICE),
      });
      expect(still.json().status).toBe('AVAILABLE');
    });

    it('refuses a takedown that would silently do nothing', async () => {
      // Ticking "take down" on a dismissal must not appear to work.
      const { report } = await reportListing();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${report.id}/dispose`,
        headers: as(DAVE),
        payload: { status: 'DISMISSED', takeDown: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses to dispose twice', async () => {
      const { report } = await reportListing();
      const dispose = () =>
        app.inject({
          method: 'POST',
          url: `/v1/moderation/reports/${report.id}/dispose`,
          headers: as(DAVE),
          payload: { status: 'DISMISSED' },
        });
      expect((await dispose()).statusCode).toBe(200);
      expect((await dispose()).statusCode).toBe(409);
    });

    it('closes the reply channel once the case is closed', async () => {
      const { report } = await reportListing();
      await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${report.id}/dispose`,
        headers: as(DAVE),
        payload: { status: 'DISMISSED' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/reports/${report.id}/reply`,
        headers: as(BOB),
        payload: { body: 'but wait' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses disposition by a non-moderator', async () => {
      const { report } = await reportListing();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/moderation/reports/${report.id}/dispose`,
        headers: as(ALICE),
        payload: { status: 'DISMISSED' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
