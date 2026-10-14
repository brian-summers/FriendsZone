import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CalendarEvent, EventId, UserId } from '@friendszone/contracts';
import type { Config } from '../../config.js';
import { createServer } from '../../server.js';
import type { Repositories } from '../ports.js';
import { asCrossOwner, runAsActor } from '../scope.js';
import { applySchema, createPgliteClient, type SqlClient } from './client.js';
import { createSqlRepositories } from './postgres.js';
import { assertRestrictedRole, provisionRequestRole } from './roles.js';

/**
 * The whole API, on Postgres, as a role that row-level security binds.
 *
 * Every other suite runs either on the memory adapter or on PGlite's default
 * role, which is a superuser - and a superuser bypasses row-level security.
 * Until ADR 0031 that hid an adapter that never told Postgres who was asking:
 * with `app.actor_id` unset, every policy is false, so a role the policies
 * actually bind can neither write nor read an owned row. Production did not
 * notice either, because its connection is not bound by them (ADR 0031).
 *
 * This suite builds production's posture (ADR 0033): the owner applies the
 * schema and provisions the request role exactly as boot does, and every
 * request then runs as that role - no attributes, no ownership, data grants
 * only - and walks the product's main flows over HTTP with real sessions. If a
 * handler writes across owners without `asCrossOwner`, a read policy is
 * narrowed so a friend can no longer read what the projection needs, or a new
 * table is missing a grant, it fails here rather than in production.
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

/**
 * Boot's two steps on one PGlite connection: migrate as the owner, then serve
 * as the request role. `set role` stands in for the second login, which an
 * in-process engine cannot make; the boot check runs against it all the same.
 */
async function rlsBoundDb(): Promise<SqlClient> {
  const db = await createPgliteClient();
  await applySchema(db);
  await provisionRequestRole(db, { user: 'friendszone_app', password: 'p'.repeat(24) });
  await db.query(`set role friendszone_app`);
  await assertRestrictedRole(db);
  return db;
}

function dayAt(daysAhead: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
const slot = (daysAhead: number, from: number, to: number) => ({
  start: dayAt(daysAhead, from),
  end: dayAt(daysAhead, to),
});

function windowQs(): string {
  return `start=${encodeURIComponent(dayAt(-1, 0))}&end=${encodeURIComponent(dayAt(13, 0))}`;
}

interface Person {
  id: UserId;
  handle: string;
  headers: { cookie: string };
}

describe('the API on Postgres as a role row-level security binds', () => {
  let db: SqlClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let alice: Person;
  let bob: Person;
  let carol: Person;

  const register = async (handle: string): Promise<Person> => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        handle,
        displayName: handle,
      },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return { id: me.json().id, handle, headers: { cookie } };
  };

  const befriend = async (a: Person, b: Person): Promise<void> => {
    const asked = await app.inject({
      method: 'POST',
      url: `/v1/people/${b.id}/friend-request`,
      headers: a.headers,
      payload: {},
    });
    expect(asked.statusCode).toBe(200);
    const answered = await app.inject({
      method: 'POST',
      url: `/v1/me/friend-requests/${a.id}`,
      headers: b.headers,
      payload: { decision: 'ACCEPT' },
    });
    expect(answered.statusCode).toBe(200);
  };

  const calendarOf = (owner: Person, viewer: Person) =>
    app.inject({
      method: 'GET',
      url: `/v1/users/${owner.id}/calendar?${windowQs()}`,
      headers: viewer.headers,
    });

  const createEvent = (owner: Person, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/events', headers: owner.headers, payload });

  beforeAll(async () => {
    db = await rlsBoundDb();
    repos = createSqlRepositories(db);
    app = await createServer({ config, repos });
    alice = await register('alice');
    bob = await register('bob');
    carol = await register('carol');
    // Alice is friends with both; Bob and Carol are strangers to each other.
    await befriend(alice, bob);
    await befriend(alice, carol);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it('lets an owner create, read, edit and delete their own event', async () => {
    const created = await createEvent(alice, { title: 'Dentist', timeRange: slot(1, 9, 10) });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;

    const own = await calendarOf(alice, alice);
    expect(own.statusCode).toBe(200);
    expect(own.json().details.map((e: { id: string }) => e.id)).toContain(id);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${id}`,
      headers: alice.headers,
      payload: { title: 'Dentist (moved)' },
    });
    expect(edited.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/events/${id}`,
      headers: alice.headers,
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
  });

  it("projects a friend's view from rows RLS lets them read, and nothing to a stranger", async () => {
    await createEvent(alice, { title: 'Pottery', timeRange: slot(2, 18, 20), exclusive: true });

    // Sharing defaults are read on Bob's behalf to project Alice's events.
    const defaults = await app.inject({
      method: 'PUT',
      url: '/v1/me/sharing-defaults',
      headers: alice.headers,
      payload: { rules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }] },
    });
    expect(defaults.statusCode).toBe(200);

    const asFriend = await calendarOf(alice, bob);
    expect(asFriend.statusCode).toBe(200);
    expect(asFriend.json().details.map((e: { title?: string }) => e.title)).toContain('Pottery');

    await createEvent(bob, { title: 'Bob only', timeRange: slot(2, 9, 10), exclusive: true });
    const asStranger = await calendarOf(bob, carol);
    expect(asStranger.json()).toMatchObject({ busy: [], details: [] });
  });

  it('saves quiet hours, shows them to friends, and refuses a proposal inside them', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/me/quiet-hours',
      headers: alice.headers,
      payload: { quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'UTC' } },
    });
    expect(saved.statusCode).toBe(200);

    const asFriend = await calendarOf(alice, bob);
    expect(asFriend.json().quietHours).toMatchObject({ startMinute: 1320, endMinute: 420 });

    const inside = await app.inject({
      method: 'POST',
      url: '/v1/hangouts',
      headers: bob.headers,
      payload: { inviteeId: alice.id, title: 'Late one', proposedSlots: [slot(3, 23, 24)] },
    });
    expect(inside.statusCode).toBe(400);

    await app.inject({
      method: 'PUT',
      url: '/v1/me/quiet-hours',
      headers: alice.headers,
      payload: { quietHours: null },
    });
  });

  it('lets a circle reach its members, and only them', async () => {
    const circle = await app.inject({
      method: 'POST',
      url: '/v1/me/circles',
      headers: alice.headers,
      payload: { name: 'Climbing crew', memberIds: [carol.id] },
    });
    expect(circle.statusCode).toBe(200);
    const circleId = circle.json().id as string;

    await createEvent(alice, {
      title: 'Bouldering',
      timeRange: slot(4, 18, 20),
      shareRules: [{ audience: { kind: 'CIRCLE', circleId }, level: 'FULL' }],
    });

    const member = await calendarOf(alice, carol);
    expect(member.json().details.map((e: { title?: string }) => e.title)).toContain('Bouldering');

    const nonMember = await calendarOf(alice, bob);
    expect(nonMember.body).not.toContain('Bouldering');
    expect(nonMember.body).not.toContain('Climbing crew');
  });

  it('books, moves and cancels a hangout on both calendars', async () => {
    const proposed = await app.inject({
      method: 'POST',
      url: '/v1/hangouts',
      headers: bob.headers,
      payload: { inviteeId: alice.id, title: 'Lunch', proposedSlots: [slot(5, 12, 13)] },
    });
    expect(proposed.statusCode).toBe(200);
    const id = proposed.json().id as string;

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/hangouts/${id}/respond`,
      headers: alice.headers,
      payload: { decision: 'ACCEPT', slotIndex: 0 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().resultingEventIds).toHaveLength(2);

    for (const who of [alice, bob]) {
      const view = await calendarOf(who, who);
      expect(view.json().details.map((e: { title?: string }) => e.title)).toContain('Lunch');
    }

    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/hangouts/${id}`,
      headers: bob.headers,
      payload: { title: 'Long lunch' },
    });
    expect(edited.statusCode).toBe(200);
    const aliceView = await calendarOf(alice, alice);
    expect(aliceView.json().details.map((e: { title?: string }) => e.title)).toContain('Long lunch');

    const moved = await app.inject({
      method: 'POST',
      url: `/v1/hangouts/${id}/reschedule`,
      headers: bob.headers,
      payload: { proposedSlots: [slot(6, 12, 13)] },
    });
    expect(moved.statusCode).toBe(200);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/hangouts/${id}/cancel`,
      headers: alice.headers,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
  });

  it('carries a first-come claim through a handoff that books both calendars', async () => {
    const listing = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: alice.headers,
      payload: {
        title: 'Step ladder',
        condition: 'GOOD',
        audience: { kind: 'FRIENDS' },
        claimMode: 'FIRST_COME',
      },
    });
    expect(listing.statusCode).toBe(200);
    const listingId = listing.json().id as string;

    // The claimant closes the owner's listing: a cross-owner write.
    const claimed = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/claims`,
      headers: bob.headers,
      payload: {},
    });
    expect(claimed.statusCode).toBe(200);

    const asOwner = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}`,
      headers: alice.headers,
    });
    expect(asOwner.json().status).toBe('CLAIMED');
    const claimId = asOwner.json().claims[0].id as string;

    const proposed = await app.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/exchange`,
      headers: bob.headers,
      payload: { timeRange: slot(7, 15, 16), location: 'Trellis Cafe' },
    });
    expect(proposed.statusCode).toBe(200);
    const exchangeId = proposed.json().id as string;

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/exchanges/${exchangeId}/respond`,
      headers: alice.headers,
      payload: { decision: 'ACCEPT' },
    });
    expect(accepted.statusCode).toBe(200);

    const completed = await app.inject({
      method: 'POST',
      url: `/v1/exchanges/${exchangeId}/complete`,
      headers: bob.headers,
      payload: {},
    });
    expect(completed.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}`,
      headers: alice.headers,
    });
    expect(after.json().status).toBe('EXCHANGED');
  });

  it('deletes an account without touching the counterparty’s copy of a shared plan', async () => {
    const dave = await register('dave');
    await befriend(alice, dave);

    const proposed = await app.inject({
      method: 'POST',
      url: '/v1/hangouts',
      headers: dave.headers,
      payload: { inviteeId: alice.id, title: 'Farewell coffee', proposedSlots: [slot(8, 10, 11)] },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/hangouts/${proposed.json().id}/respond`,
      headers: alice.headers,
      payload: { decision: 'ACCEPT', slotIndex: 0 },
    });
    expect(accepted.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'POST',
      url: '/v1/me/delete',
      headers: dave.headers,
      payload: { confirmHandle: dave.handle },
    });
    expect(deleted.statusCode).toBe(200);

    const kept = await calendarOf(alice, alice);
    expect(kept.json().details.map((e: { title?: string }) => e.title)).toContain('Farewell coffee');
  });

  describe('the policies themselves, through the adapter', () => {
    let n = 0;
    const event = (ownerId: UserId): CalendarEvent => {
      n += 1;
      return {
        id: `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}` as EventId,
        ownerId,
        timeRange: slot(9, 9, 10),
        title: 'Probe',
        status: 'CONFIRMED',
        visibilityCeiling: 'FULL',
        shareRules: [],
        attendeeIds: [],
        exclusive: true,
        createdAt: dayAt(0, 0),
        updatedAt: dayAt(0, 0),
      };
    };

    it('refuses a write made outside any request - fail closed', async () => {
      await expect(repos.calendar.create(event(alice.id))).rejects.toThrow(/row-level security/);
    });

    it("refuses one person's write to another's rows", async () => {
      await expect(
        runAsActor(bob.id, () => repos.calendar.create(event(alice.id))),
      ).rejects.toThrow(/row-level security/);
      await expect(
        runAsActor(bob.id, () =>
          repos.calendar.setQuietHours(alice.id, { startMinute: 0, endMinute: 60, timeZone: 'UTC' }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('admits a sanctioned cross-owner write, and only to the tables that have one', async () => {
      await runAsActor(bob.id, () => asCrossOwner(() => repos.calendar.create(event(alice.id))));

      // Sharing defaults, quiet hours and circles have no cross-owner write in
      // the product, so the flag does not open them.
      await expect(
        runAsActor(bob.id, () =>
          asCrossOwner(() => repos.calendar.setSharingDefaults(alice.id, { rules: [] })),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('shows a circle row to its owner and members, and to nobody else', async () => {
      const [circle] = await runAsActor(alice.id, () => repos.circles.ownedBy(alice.id));
      expect(circle).toBeDefined();

      const asMember = await runAsActor(carol.id, () => repos.circles.byId(circle!.id));
      expect(asMember?.id).toBe(circle!.id);

      const asOutsider = await runAsActor(bob.id, () => repos.circles.byId(circle!.id));
      expect(asOutsider).toBeNull();
    });
  });
});
