import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, DAVE, createDemoSeed } from '../seed.js';
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

function futureSlot(offsetDays = 2) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(15, 0, 0, 0);
  const end = new Date(start);
  end.setHours(16, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function windowQs() {
  // Reach back a week so the current week's Monday-anchored seed events are in
  // range whatever day the test runs.
  const start = new Date();
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 21);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
}

describe('event editing', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  const create = (body: Record<string, unknown>) =>
    app
      .inject({ method: 'POST', url: '/v1/events', headers: as(ALICE), payload: body })
      .then((r) => r.json());

  it('returns the event’s own rules to its owner, for editing', async () => {
    const ev = await create({
      title: 'Gym',
      timeRange: futureSlot(),
      shareRules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
    });
    expect(ev.shareRules).toEqual([{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }]);
    expect(ev.ownVisibilityCeiling).toBe('FULL');
  });

  it('changes an event’s sharing rules', async () => {
    const ev = await create({ title: 'Therapy', timeRange: futureSlot() });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${ev.id}`,
      headers: as(ALICE),
      payload: { shareRules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shareRules).toEqual([{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }]);

    // Bob now sees the title where before he saw nothing.
    const bobView = await app.inject({
      method: 'GET',
      url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
      headers: as(BOB),
    });
    expect(bobView.body).toContain('Therapy');
  });

  it('edits title, time, and the exclusive flag', async () => {
    const ev = await create({ title: 'Draft', timeRange: futureSlot() });
    expect(ev.exclusive).toBe(false); // events overlap by default
    const moved = futureSlot(4);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${ev.id}`,
      headers: as(ALICE),
      payload: { title: 'Final', timeRange: moved, exclusive: true },
    });
    const body = res.json();
    expect(body.title).toBe('Final');
    expect(body.timeRange.start).toBe(moved.start);
    expect(body.exclusive).toBe(true);
  });

  it('refuses to edit an event you do not own', async () => {
    const ev = await create({ title: 'Mine', timeRange: futureSlot() });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${ev.id}`,
      headers: as(BOB),
      payload: { title: 'Hijack' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to edit a hangout-origin event directly', async () => {
    // Alice proposes, Bob accepts → a hangout event appears on both calendars.
    const req = await app
      .inject({
        method: 'POST',
        url: '/v1/hangouts',
        headers: as(ALICE),
        payload: { inviteeId: BOB, title: 'Dinner', proposedSlots: [futureSlot(3)] },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/v1/hangouts/${req.id}/respond`,
      headers: as(BOB),
      payload: { decision: 'ACCEPT', slotIndex: 0 },
    });
    const aliceCal = await app
      .inject({ method: 'GET', url: `/v1/users/${ALICE}/calendar?${windowQs()}`, headers: as(ALICE) })
      .then((r) => r.json());
    const dinner = (aliceCal.details as Array<{ id: string; title: string }>).find(
      (d) => d.title === 'Dinner',
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${dinner!.id}`,
      headers: as(ALICE),
      payload: { title: 'Renamed' },
    });
    expect(res.statusCode).toBe(409); // manage through the hangout instead
  });

  it('deletes an event you own', async () => {
    const ev = await create({ title: 'Temp', timeRange: futureSlot() });
    const del = await app.inject({ method: 'DELETE', url: `/v1/events/${ev.id}`, headers: as(ALICE), payload: {} });
    expect(del.statusCode).toBe(200);

    const view = await app
      .inject({ method: 'GET', url: `/v1/users/${ALICE}/calendar?${windowQs()}`, headers: as(ALICE) })
      .then((r) => r.json());
    expect((view.details as Array<{ title: string }>).some((d) => d.title === 'Temp')).toBe(false);
  });
});

describe('sharing defaults', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  it('reads and replaces your own defaults, changing what friends see', async () => {
    const before = await app.inject({ method: 'GET', url: '/v1/me/sharing-defaults', headers: as(ALICE) });
    expect(before.json().rules).toEqual([{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }]);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/me/sharing-defaults',
      headers: as(ALICE),
      payload: { rules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }] },
    });
    expect(put.statusCode).toBe(200);

    // The seeded 'Dentist' has no own rules, so it follows the defaults. Bob
    // now sees its title where the conservative default showed only Busy.
    const bobView = await app.inject({
      method: 'GET',
      url: `/v1/users/${ALICE}/calendar?${windowQs()}`,
      headers: as(BOB),
    });
    expect(bobView.body).toContain('Dentist');
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/sharing-defaults' });
    expect(res.statusCode).toBe(401);
  });

  // ── Presets and onboarding (ADR 0021) ────────────────────────────
  const read = (actor: string) =>
    app.inject({ method: 'GET', url: '/v1/me/sharing-defaults', headers: as(actor) });

  const write = (actor: string, rules: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/v1/me/sharing-defaults',
      headers: as(actor),
      payload: { rules },
    });

  it('reports an unconfigured user as not having chosen', async () => {
    // DAVE has no seeded defaults row. He is on the conservative fallback and
    // has never said so himself — the distinction onboarding needs.
    const res = await read(DAVE);
    expect(res.json().chosen).toBe(false);
    expect(res.json().preset).toBe('BUSY_TO_FRIENDS');
    // Not sharing *more* than before: the flag makes the state legible only.
    expect(res.json().rules).toEqual([{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }]);
  });

  it('counts saving the very same rules as having chosen', async () => {
    expect((await read(DAVE)).json().chosen).toBe(false);
    await write(DAVE, [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }]);
    const after = await read(DAVE);
    expect(after.json().chosen).toBe(true);
    expect(after.json().preset).toBe('BUSY_TO_FRIENDS');
  });

  it('names the preset the stored rules match', async () => {
    await write(ALICE, []);
    expect((await read(ALICE)).json().preset).toBe('PRIVATE');

    await write(ALICE, [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }]);
    expect((await read(ALICE)).json().preset).toBe('OPEN_TO_FRIENDS');
  });

  it('says CUSTOM rather than rounding an unusual configuration', async () => {
    await write(ALICE, [
      { audience: { kind: 'FRIENDS' }, level: 'BUSY' },
      { audience: { kind: 'PUBLIC' }, level: 'TITLE' },
    ]);
    expect((await read(ALICE)).json().preset).toBe('CUSTOM');
  });

  it('still accepts a wider configuration through custom rules', async () => {
    // No *preset* grants FULL, but the lattice underneath is unchanged — the
    // refusal is about one-tap defaults, not about capability.
    const res = await write(ALICE, [{ audience: { kind: 'FRIENDS' }, level: 'FULL' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().preset).toBe('CUSTOM');
  });
});
