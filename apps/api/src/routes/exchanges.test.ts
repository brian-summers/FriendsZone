import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, DAVE, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

/**
 * ALICE offers a skillet; BOB claims it; they arrange a handoff.
 *
 * CAROL is a friend of both and a party to neither — she is how every
 * third-party leak is tested.
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
  // Off here: these suites hammer `app.inject` and would otherwise trip buckets
  // in tests that are about something else. `rate-limit.test.ts` turns it on.
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

const LOCATION = 'Trellis Cafe, 8 Bridge St';
const TITLE = 'Cast iron skillet';

function slot(daysAhead = 3): { start: string; end: string } {
  const start = new Date();
  start.setDate(start.getDate() + daysAhead);
  start.setHours(15, 0, 0, 0);
  const end = new Date(start);
  end.setHours(16, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function windowQs(): string {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
}

describe('the handoff', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  /** Alice offers, Bob claims first-come (so the claim is ACCEPTED at once). */
  async function acceptedClaim(): Promise<{ listingId: string; claimId: string }> {
    const listing = await app
      .inject({
        method: 'POST',
        url: '/v1/listings',
        headers: as(ALICE),
        payload: {
          title: TITLE,
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

    const asOwner = await app
      .inject({ method: 'GET', url: `/v1/listings/${listing.id}`, headers: as(ALICE) })
      .then((r) => r.json());

    return { listingId: listing.id, claimId: asOwner.claims[0].id };
  }

  const propose = (claimId: string, actor: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/exchange`,
      headers: as(actor),
      payload: { timeRange: slot(), location: LOCATION, ...extra },
    });

  const respond = (id: string, actor: string, decision: 'ACCEPT' | 'DECLINE') =>
    app.inject({
      method: 'POST',
      url: `/v1/exchanges/${id}/respond`,
      headers: as(actor),
      payload: { decision },
    });

  const calendarOf = (ownerId: string, viewer: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/users/${ownerId}/calendar?${windowQs()}`,
      headers: as(viewer),
    });

  async function scheduled() {
    const { listingId, claimId } = await acceptedClaim();
    const exchange = (await propose(claimId, ALICE)).json();
    await respond(exchange.id, BOB, 'ACCEPT');
    return { listingId, claimId, exchangeId: exchange.id };
  }

  // ── Proposing ──────────────────────────────────────────────────────
  describe('proposing', () => {
    it('lets either party propose a time and place', async () => {
      const { claimId } = await acceptedClaim();

      const byOwner = await propose(claimId, ALICE);
      expect(byOwner.statusCode).toBe(200);
      expect(byOwner.json().status).toBe('PROPOSED');
      expect(byOwner.json().location).toBe(LOCATION);
      expect(byOwner.json().proposedBy).toBe(ALICE);

      // Haggling is the normal case: the claimant may counter-propose.
      const byClaimant = await propose(claimId, BOB, { location: 'The library steps' });
      expect(byClaimant.json().proposedBy).toBe(BOB);
      expect(byClaimant.json().location).toBe('The library steps');
    });

    it('refuses a handoff before the claim is accepted', async () => {
      const listing = await app
        .inject({
          method: 'POST',
          url: '/v1/listings',
          headers: as(ALICE),
          payload: {
            title: 'Ladder',
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
        payload: {},
      });
      const claimId = (
        await app
          .inject({ method: 'GET', url: `/v1/listings/${listing.id}`, headers: as(ALICE) })
          .then((r) => r.json())
      ).claims[0].id;

      // Still PENDING under OWNER_SELECTS.
      expect((await propose(claimId, ALICE)).statusCode).toBe(409);
    });

    it('refuses a non-party, indistinguishably from an unknown claim', async () => {
      const { claimId } = await acceptedClaim();
      const outsider = await propose(claimId, CAROL);
      const missing = await propose('99999999-9999-4999-8999-999999999999', CAROL);

      expect(outsider.statusCode).toBe(missing.statusCode);
      expect(outsider.body).toBe(missing.body);
      expect(outsider.statusCode).toBe(404);
    });

    it('refuses a time in the past or absurdly far ahead', async () => {
      const { claimId } = await acceptedClaim();
      const past = { start: '2020-01-01T10:00:00.000Z', end: '2020-01-01T11:00:00.000Z' };
      expect((await propose(claimId, ALICE, { timeRange: past })).statusCode).toBe(409);
      expect((await propose(claimId, ALICE, { timeRange: slot(400) })).statusCode).toBe(409);
    });

    it('refuses an anonymous proposal', async () => {
      const { claimId } = await acceptedClaim();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/claims/${claimId}/exchange`,
        payload: { timeRange: slot(), location: LOCATION },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Accepting ──────────────────────────────────────────────────────
  describe('accepting', () => {
    it('books both calendars, and only on acceptance', async () => {
      const { claimId } = await acceptedClaim();
      const exchange = (await propose(claimId, ALICE)).json();

      // Nothing booked yet — a proposal is not a commitment.
      expect((await calendarOf(ALICE, ALICE)).body).not.toContain('Handoff');

      const accepted = await respond(exchange.id, BOB, 'ACCEPT');
      expect(accepted.json().status).toBe('SCHEDULED');

      // One copy each, owned by each party.
      expect((await calendarOf(ALICE, ALICE)).body).toContain('Handoff');
      expect((await calendarOf(BOB, BOB)).body).toContain('Handoff');
    });

    it('refuses to let the proposer accept their own proposal', async () => {
      const { claimId } = await acceptedClaim();
      const exchange = (await propose(claimId, ALICE)).json();
      // Agreeing with yourself is not agreement.
      expect((await respond(exchange.id, ALICE, 'ACCEPT')).statusCode).toBe(404);
    });

    it('returns a declined proposal to “nothing arranged”, and lets it be re-proposed', async () => {
      const { claimId } = await acceptedClaim();
      const first = (await propose(claimId, ALICE)).json();
      expect((await respond(first.id, BOB, 'DECLINE')).json().status).toBe('CANCELLED');

      const second = await propose(claimId, BOB, { location: 'The park bench' });
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe('PROPOSED');
    });

    it('refuses a second acceptance', async () => {
      const { exchangeId } = await scheduled();
      expect((await respond(exchangeId, BOB, 'ACCEPT')).statusCode).toBe(409);
    });
  });

  // ── The part that matters ──────────────────────────────────────────
  describe('what a third party can see', () => {
    it('shows an outsider a busy block and nothing else', async () => {
      await scheduled();

      const carolSees = await calendarOf(ALICE, CAROL);
      expect(carolSees.statusCode).toBe(200);

      // The whole safety story, asserted on the serialised body: Carol learns
      // Alice is occupied and not one thing more.
      expect(carolSees.body).not.toContain(LOCATION);
      expect(carolSees.body).not.toContain('Handoff');
      expect(carolSees.body).not.toContain(TITLE);
      expect(carolSees.body).not.toContain(BOB);
      expect(carolSees.json().busy.length).toBeGreaterThan(0);
    });

    it('shows a friend who shares nothing back exactly the same', async () => {
      await scheduled();
      const daveSees = await calendarOf(ALICE, DAVE);
      expect(daveSees.body).not.toContain(LOCATION);
      expect(daveSees.body).not.toContain(BOB);
    });

    it('still shows each participant their own copy in full', async () => {
      await scheduled();

      const alice = await calendarOf(ALICE, ALICE);
      const bob = await calendarOf(BOB, BOB);
      expect(alice.body).toContain(LOCATION);
      expect(bob.body).toContain(LOCATION);
    });

    it('shows each participant the other’s copy in full, as an attendee', async () => {
      // The attendee branch returns FULL before the ceiling clamp, which is
      // what lets two people meeting both see the address.
      await scheduled();
      const bobViewingAlice = await calendarOf(ALICE, BOB);
      expect(bobViewingAlice.body).toContain(LOCATION);
    });

    it('caps the owner’s own “most anyone else can see” badge at Busy', async () => {
      // Will look like a bug to anyone who has not read ADR 0019. It is not.
      await scheduled();
      const alice = (await calendarOf(ALICE, ALICE)).json();
      const handoff = alice.details.find((e: { title?: string }) =>
        e.title?.startsWith('Handoff'),
      );
      expect(handoff.sharedAs).toBe('BUSY');
    });
  });

  // ── Cancelling and completing ──────────────────────────────────────
  describe('cancelling', () => {
    it('removes the booking from both calendars entirely', async () => {
      const { exchangeId } = await scheduled();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/exchanges/${exchangeId}/cancel`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.json().status).toBe('CANCELLED');

      // Deleted, not marked cancelled: a slot that frees up at short notice is
      // itself information, so the handoff leaves no trace on either week.
      expect((await calendarOf(ALICE, ALICE)).body).not.toContain('Handoff');
      expect((await calendarOf(BOB, BOB)).body).not.toContain('Handoff');
    });

    it('lets either party cancel', async () => {
      for (const who of [ALICE, BOB]) {
        const { exchangeId } = await scheduled();
        const res = await app.inject({
          method: 'POST',
          url: `/v1/exchanges/${exchangeId}/cancel`,
          headers: as(who),
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('refuses cancellation by an outsider', async () => {
      const { exchangeId } = await scheduled();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/exchanges/${exchangeId}/cancel`,
        headers: as(CAROL),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('completing', () => {
    it('marks the listing exchanged and keeps the calendar record', async () => {
      const { listingId, exchangeId } = await scheduled();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/exchanges/${exchangeId}/complete`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.json().status).toBe('COMPLETED');

      const listing = await app
        .inject({ method: 'GET', url: `/v1/listings/${listingId}`, headers: as(ALICE) })
        .then((r) => r.json());
      expect(listing.status).toBe('EXCHANGED');

      // It happened; each owner's past week is theirs to keep.
      expect((await calendarOf(ALICE, ALICE)).body).toContain('Handoff');
    });

    it('refuses to complete something never scheduled', async () => {
      const { claimId } = await acceptedClaim();
      const exchange = (await propose(claimId, ALICE)).json();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/exchanges/${exchange.id}/complete`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // ── How it reaches the client ──────────────────────────────────────
  describe('on the listing', () => {
    it('rides along on the claim, for parties only', async () => {
      const { listingId } = await scheduled();

      const forOwner = await app
        .inject({ method: 'GET', url: `/v1/listings/${listingId}`, headers: as(ALICE) })
        .then((r) => r.json());
      expect(forOwner.claims[0].exchange.location).toBe(LOCATION);

      const forClaimant = await app
        .inject({ method: 'GET', url: `/v1/listings/${listingId}`, headers: as(BOB) })
        .then((r) => r.json());
      expect(forClaimant.yourClaim.exchange.location).toBe(LOCATION);
    });

    it('is invisible to a friend who is not a party', async () => {
      const { listingId } = await scheduled();
      const forCarol = await app.inject({
        method: 'GET',
        url: `/v1/listings/${listingId}`,
        headers: as(CAROL),
      });
      expect(forCarol.body).not.toContain(LOCATION);
      expect(forCarol.json().claims).toBeUndefined();
      expect(forCarol.json().yourClaim).toBeUndefined();
    });
  });
});
