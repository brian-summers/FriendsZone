import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories, type MemorySeed } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, DAVE, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

/** A slot a few days out, in local time (matches the seed's reckoning). */
function futureSlot(offsetDays = 2) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start);
  end.setHours(19, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function weekWindowQs() {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 14);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(
    end.toISOString(),
  )}`;
}

describe('hangout requests', () => {
  let app: FastifyInstance;

  const boot = async (seed: MemorySeed = createDemoSeed()) => {
    app = await createServer({ config, repos: createMemoryRepositories(seed) });
    await app.ready();
    return app;
  };

  beforeEach(async () => {
    await boot();
  });

  describe('sending', () => {
    it('lets a friend propose a hangout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: BOB, title: 'Dinner', proposedSlots: [futureSlot()] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ proposerId: ALICE, inviteeIds: [BOB], status: 'PENDING' });
      // The server supplies an expiry even though the client sent none.
      expect(typeof body.expiresAt).toBe('string');
    });

    it('refuses to send to a non-friend', async () => {
      // Alice and Mallory: a block exists. This must not become a channel.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: MALLORY, title: 'Hi', proposedSlots: [futureSlot()] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses to send to yourself', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: ALICE, title: 'Me time', proposedSlots: [futureSlot()] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('ignores a proposerId smuggled in the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: {
          inviteeId: BOB,
          proposerId: CAROL,
          title: 'Sneaky',
          proposedSlots: [futureSlot()],
        },
      });
      expect(res.json().proposerId).toBe(ALICE);
    });

    it('requires a session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        payload: { inviteeId: BOB, title: 'X', proposedSlots: [futureSlot()] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('inbox and outbox', () => {
    it('shows a recipient the requests sent to them, and no others', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/hangouts/received', headers: as(ALICE) });
      expect(res.statusCode).toBe(200);
      const requests = res.json().requests as Array<{ proposerId: string; inviteeIds: string[] }>;
      expect(requests.length).toBeGreaterThan(0);
      // Every request in Alice's inbox actually lists Alice as an invitee.
      expect(requests.every((r) => r.inviteeIds.includes(ALICE))).toBe(true);
    });

    it('shows a proposer their own sent requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/hangouts/sent', headers: as(ALICE) });
      const requests = res.json().requests as Array<{ proposerId: string }>;
      expect(requests.every((r) => r.proposerId === ALICE)).toBe(true);
    });
  });

  describe('accepting', () => {
    it('books the hangout onto both calendars and marks it accepted', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: {
            inviteeId: BOB,
            title: 'Board games',
            location: "Bob's place",
            proposedSlots: [futureSlot(3)],
          },
        })
        .then((r) => r.json());

      const accepted = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'ACCEPT', slotIndex: 0 },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().status).toBe('ACCEPTED');

      // The event now appears on *both* calendars, in full to each participant.
      for (const person of [ALICE, BOB]) {
        const cal = await app.inject({
          method: 'GET',
          url: `/v1/users/${person}/calendar?${weekWindowQs()}`,
          headers: as(person),
        });
        expect(cal.body).toContain('Board games');
      }
    });

    it('lets only an invitee respond', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Walk', proposedSlots: [futureSlot()] },
        })
        .then((r) => r.json());

      // Carol is neither proposer nor invitee.
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(CAROL),
        payload: { decision: 'ACCEPT', slotIndex: 0 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects an out-of-range slot index', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Walk', proposedSlots: [futureSlot()] },
        })
        .then((r) => r.json());

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'ACCEPT', slotIndex: 5 },
      });
      expect(res.statusCode).toBe(409);
    });

    it('cannot be responded to twice', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Walk', proposedSlots: [futureSlot()] },
        })
        .then((r) => r.json());

      const first = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'DECLINE' },
      });
      expect(first.json().status).toBe('DECLINED');

      const second = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'ACCEPT', slotIndex: 0 },
      });
      // No longer PENDING → the transition is refused.
      expect(second.statusCode).toBe(409);
    });
  });

  describe('withdrawing', () => {
    it('lets the proposer withdraw a pending request', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Walk', proposedSlots: [futureSlot()] },
        })
        .then((r) => r.json());

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/withdraw`,
        headers: as(ALICE),
        payload: {},
      });
      expect(res.json().status).toBe('WITHDRAWN');
    });

    it('does not let an invitee withdraw', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Walk', proposedSlots: [futureSlot()] },
        })
        .then((r) => r.json());

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/withdraw`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('tentative holds on the calendar', () => {
    const calUrl = (owner: string) => `/v1/users/${owner}/calendar?${weekWindowQs()}`;

    it('shows a pending request as tentative holds on both participants’ calendars', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: {
            inviteeId: BOB,
            title: 'Tentative dinner',
            proposedSlots: [futureSlot(2), futureSlot(4)],
          },
        })
        .then((r) => r.json());

      // On Alice's own calendar: two holds, role PROPOSER.
      const aliceCal = await app.inject({ method: 'GET', url: calUrl(ALICE), headers: as(ALICE) });
      const aHolds = aliceCal.json().holds as Array<{ requestId: string; role: string }>;
      const mine = aHolds.filter((h) => h.requestId === created.id);
      expect(mine).toHaveLength(2);
      expect(mine.every((h) => h.role === 'PROPOSER')).toBe(true);

      // On Bob's own calendar: the same request, role INVITEE.
      const bobCal = await app.inject({ method: 'GET', url: calUrl(BOB), headers: as(BOB) });
      const bHolds = (bobCal.json().holds as Array<{ requestId: string; role: string }>).filter(
        (h) => h.requestId === created.id,
      );
      expect(bHolds).toHaveLength(2);
      expect(bHolds.every((h) => h.role === 'INVITEE')).toBe(true);
    });

    it('does not show a hold to a third party who can see the calendar', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Private plan', proposedSlots: [futureSlot(2)] },
        })
        .then((r) => r.json());

      // Carol is Alice's friend and can see her calendar, but is not a party to
      // the Alice↔Bob request. She must not see the hold.
      const carolView = await app.inject({ method: 'GET', url: calUrl(ALICE), headers: as(CAROL) });
      const holds = carolView.json().holds as Array<{ requestId: string }>;
      expect(holds.some((h) => h.requestId === created.id)).toBe(false);
      expect(carolView.body).not.toContain('Private plan');
    });

    it('is not counted as busy — a maybe is not a commitment', async () => {
      const availUrl = `/v1/users/${ALICE}/availability?${weekWindowQs()}`;
      const before = await app.inject({ method: 'GET', url: availUrl, headers: as(ALICE) });

      await app.inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: BOB, title: 'Maybe', proposedSlots: [futureSlot(2)] },
      });

      const after = await app.inject({ method: 'GET', url: availUrl, headers: as(ALICE) });
      // Adding a pending hold changes nothing about free/busy…
      expect(after.json().busy).toEqual(before.json().busy);
      // …and availability never carries holds at all.
      expect(Object.keys(after.json()).sort()).toEqual(['busy', 'ownerId', 'window']);
    });

    it('clears the hold once the request is accepted, leaving a firm event', async () => {
      const created = await app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: { inviteeId: BOB, title: 'Firm soon', proposedSlots: [futureSlot(2)] },
        })
        .then((r) => r.json());

      await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${created.id}/respond`,
        headers: as(BOB),
        payload: { decision: 'ACCEPT', slotIndex: 0 },
      });

      const aliceCal = await app.inject({ method: 'GET', url: calUrl(ALICE), headers: as(ALICE) });
      const body = aliceCal.json();
      // No hold left for the request…
      expect(
        (body.holds as Array<{ requestId: string }>).some((h) => h.requestId === created.id),
      ).toBe(false);
      // …but a firm (CONFIRMED) event is now on the calendar.
      const firm = (body.details as Array<{ title: string; status: string }>).find(
        (d) => d.title === 'Firm soon',
      );
      expect(firm?.status).toBe('CONFIRMED');
    });
  });

  describe('expiry', () => {
    it('treats a past-due pending request as expired and refuses responses', async () => {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const seed = createDemoSeed();
      seed.hangouts = [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-0000000000aa' as never,
          proposerId: CAROL as never,
          inviteeIds: [ALICE as never],
          title: 'Overdue',
          proposedSlots: [futureSlot()],
          status: 'PENDING',
          responses: [],
          expiresAt: past,
          createdAt: past,
          updatedAt: past,
        } as never,
      ];
      await boot(seed);

      const inbox = await app.inject({ method: 'GET', url: '/v1/hangouts/received', headers: as(ALICE) });
      expect(inbox.json().requests[0].status).toBe('EXPIRED');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/eeeeeeee-eeee-4eee-8eee-0000000000aa/respond`,
        headers: as(ALICE),
        payload: { decision: 'ACCEPT', slotIndex: 0 },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // ── New management operations ──────────────────────────────────────────
  const propose = (title: string) =>
    app
      .inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: BOB, title, proposedSlots: [futureSlot(3)] },
      })
      .then((r) => r.json());

  const accept = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/hangouts/${id}/respond`,
      headers: as(BOB),
      payload: { decision: 'ACCEPT', slotIndex: 0 },
    });

  describe('updating properties', () => {
    it('lets the organiser edit, and mirrors onto booked events', async () => {
      const req = await propose('Dinner');
      await accept(req.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/hangouts/${req.id}`,
        headers: as(ALICE),
        payload: { title: 'Dinner at Trellis', location: 'Trellis Cafe', notify: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe('Dinner at Trellis');

      // Both calendar copies now show the new title.
      const cal = await app.inject({
        method: 'GET',
        url: `/v1/users/${BOB}/calendar?${weekWindowQs()}`,
        headers: as(BOB),
      });
      expect(cal.body).toContain('Dinner at Trellis');
    });

    it('refuses a non-organiser', async () => {
      const req = await propose('Dinner');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/hangouts/${req.id}`,
        headers: as(BOB),
        payload: { title: 'Hijack' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('rescheduling', () => {
    it('swaps the slots of a still-pending request', async () => {
      const req = await propose('Walk');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/reschedule`,
        headers: as(ALICE),
        payload: { proposedSlots: [futureSlot(5)] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('PENDING');
      expect(body.proposedSlots[0].start).toBe(futureSlot(5).start);
    });

    it('re-books a confirmed hangout to a new time on both calendars', async () => {
      const req = await propose('Coffee');
      await accept(req.id);
      const newSlot = futureSlot(6);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/reschedule`,
        headers: as(ALICE),
        payload: { proposedSlots: [newSlot], notify: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ACCEPTED');

      // Bob's copy moved to the new time.
      const win = weekWindowQs();
      const cal = await app.inject({
        method: 'GET',
        url: `/v1/users/${BOB}/calendar?${win}`,
        headers: as(BOB),
      });
      const coffee = (cal.json().details as Array<{ title: string; timeRange: { start: string } }>).find(
        (d) => d.title === 'Coffee',
      );
      expect(coffee?.timeRange.start).toBe(newSlot.start);
    });
  });

  describe('cancelling', () => {
    it('cancels a confirmed hangout on both calendars and notifies', async () => {
      const req = await propose('Board games');
      await accept(req.id);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/cancel`,
        headers: as(ALICE),
        payload: { notify: true, reason: 'came down with a cold' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('CANCELLED');

      // Bob's own copy is now marked cancelled (he sees it struck through on
      // his own calendar; a third party would not see it at all).
      const cal = await app.inject({
        method: 'GET',
        url: `/v1/users/${BOB}/calendar?${weekWindowQs()}`,
        headers: as(BOB),
      });
      const games = (cal.json().details as Array<{ title: string; status: string }>).find(
        (d) => d.title === 'Board games',
      );
      expect(games?.status).toBe('CANCELLED');

      // A third party (Carol) does not see the cancelled hangout.
      const carolView = await app.inject({
        method: 'GET',
        url: `/v1/users/${BOB}/calendar?${weekWindowQs()}`,
        headers: as(CAROL),
      });
      expect(carolView.body).not.toContain('Board games');

      // Bob has a notification about it.
      const notes = await app.inject({ method: 'GET', url: '/v1/notifications', headers: as(BOB) });
      const list = notes.json().notifications as Array<{ kind: string; summary: string }>;
      expect(list.some((n) => n.kind === 'HANGOUT_CANCELLED' && n.summary.includes('cold'))).toBe(true);
    });

    it('refuses to cancel a pending (not yet confirmed) hangout', async () => {
      const req = await propose('Not yet');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/cancel`,
        headers: as(ALICE),
        payload: { notify: false },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a non-participant', async () => {
      const req = await propose('Private');
      await accept(req.id);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/cancel`,
        headers: as(CAROL),
        payload: { notify: false },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('floating hangouts', () => {
    const floatPeriod = () => {
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 10);
      end.setHours(21, 0, 0, 0);
      return { start: start.toISOString(), end: end.toISOString() };
    };

    const createFloating = () =>
      app
        .inject({
          method: 'POST',
          url: '/v1/hangouts',
          headers: as(ALICE),
          payload: {
            inviteeId: BOB,
            kind: 'FLOATING',
            title: 'Dog walks',
            period: floatPeriod(),
            occurrenceMinutes: 60,
          },
        })
        .then((r) => r.json());

    it('creates a floating invitation and can be booked more than once', async () => {
      const req = await createFloating();
      expect(req.kind).toBe('FLOATING');
      expect(req.status).toBe('PENDING');

      const bookAt = (offsetDays: number) => {
        const s = new Date();
        s.setDate(s.getDate() + offsetDays);
        s.setHours(10, 0, 0, 0);
        return s.toISOString();
      };

      const first = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/book`,
        headers: as(BOB),
        payload: { start: bookAt(2) },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe('PENDING'); // still open
      expect(first.json().resultingEventIds).toHaveLength(2);

      const second = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/book`,
        headers: as(BOB),
        payload: { start: bookAt(4) },
      });
      expect(second.statusCode).toBe(200);
      // Two occurrences × two participants.
      expect(second.json().resultingEventIds).toHaveLength(4);
    });

    it('refuses a booking outside the period', async () => {
      const req = await createFloating();
      const wayOut = new Date();
      wayOut.setDate(wayOut.getDate() + 40);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/book`,
        headers: as(BOB),
        payload: { start: wayOut.toISOString() },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses booking on a FIXED hangout', async () => {
      const req = await propose('Fixed one');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/book`,
        headers: as(BOB),
        payload: { start: futureSlot(2).start },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('reading a single hangout', () => {
    it('lets a participant read it, and hides it from everyone else', async () => {
      const req = await propose('Readable');

      const asAlice = await app.inject({ method: 'GET', url: `/v1/hangouts/${req.id}`, headers: as(ALICE) });
      expect(asAlice.statusCode).toBe(200);
      expect(asAlice.json().title).toBe('Readable');

      const asBob = await app.inject({ method: 'GET', url: `/v1/hangouts/${req.id}`, headers: as(BOB) });
      expect(asBob.statusCode).toBe(200); // Bob is the invitee

      const asCarol = await app.inject({ method: 'GET', url: `/v1/hangouts/${req.id}`, headers: as(CAROL) });
      expect(asCarol.statusCode).toBe(404); // not a party — indistinguishable from missing
    });
  });

  describe('notifications', () => {
    it('are private to the recipient', async () => {
      const req = await propose('Lunch');
      await accept(req.id);
      await app.inject({
        method: 'POST',
        url: `/v1/hangouts/${req.id}/cancel`,
        headers: as(ALICE),
        payload: { notify: true },
      });

      // Bob (the recipient) has one; Carol (uninvolved) has none.
      const bob = await app.inject({ method: 'GET', url: '/v1/notifications', headers: as(BOB) });
      const carol = await app.inject({ method: 'GET', url: '/v1/notifications', headers: as(CAROL) });
      expect((bob.json().notifications as unknown[]).length).toBeGreaterThan(0);
      expect(carol.json().notifications).toEqual([]);
    });
  });
});
