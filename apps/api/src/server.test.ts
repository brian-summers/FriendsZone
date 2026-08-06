import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CONSERVATIVE_SHARING_DEFAULTS } from '@friendszone/contracts';
import { ALICE, BOB, CAROL, DAY, event, hours, rule } from '@friendszone/policy/testing';
import type { Config } from './config.js';
import { DEV_ACTOR_HEADER } from './http/authenticate.js';
import { createMemoryRepositories } from './repositories/memory.js';
import {
  ALICE as SEED_ALICE,
  BOB as SEED_BOB,
  MALLORY as SEED_MALLORY,
  createDemoSeed,
} from './seed.js';
import { createServer } from './server.js';

const testConfig: Config = {
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

const calendarUrl = (ownerId: string, window = DAY) =>
  `/v1/users/${ownerId}/calendar?start=${encodeURIComponent(window.start)}&end=${encodeURIComponent(window.end)}`;

describe('GET /v1/users/:ownerId/calendar', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const repos = createMemoryRepositories({
      friendships: [[ALICE, BOB]],
      blocks: [[ALICE, CAROL]],
      sharingDefaults: [[ALICE, CONSERVATIVE_SHARING_DEFAULTS]],
      events: [
        event({ ownerId: ALICE, timeRange: hours(9, 10), title: 'Dentist' }),
        event({
          ownerId: ALICE,
          timeRange: hours(14, 15),
          title: 'Climbing',
          shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
        }),
      ],
    });
    app = await createServer({ config: testConfig, repos });
    await app.ready();
  });

  it('serves health without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('sets hardening headers, including no-store on calendar data', async () => {
    const response = await app.inject({ method: 'GET', url: calendarUrl(ALICE) });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns an empty calendar to an anonymous caller, not an error', async () => {
    const response = await app.inject({ method: 'GET', url: calendarUrl(ALICE) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ busy: [], details: [] });
  });

  it('gives a friend busy blocks and only the events shared with them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: calendarUrl(ALICE),
      headers: { [DEV_ACTOR_HEADER]: BOB },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.busy).toHaveLength(2);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({ visibility: 'TITLE', title: 'Climbing' });
    // The dentist appointment is BUSY-only under the conservative defaults.
    expect(response.body).not.toContain('Dentist');
  });

  it('gives a blocked viewer exactly what a stranger gets', async () => {
    const blocked = await app.inject({
      method: 'GET',
      url: calendarUrl(ALICE),
      headers: { [DEV_ACTOR_HEADER]: CAROL },
    });
    const anonymous = await app.inject({ method: 'GET', url: calendarUrl(ALICE) });

    expect(blocked.statusCode).toBe(anonymous.statusCode);
    expect(blocked.json()).toEqual(anonymous.json());
  });

  it('shows the owner their own full calendar', async () => {
    const response = await app.inject({
      method: 'GET',
      url: calendarUrl(ALICE),
      headers: { [DEV_ACTOR_HEADER]: ALICE },
    });
    const body = response.json();
    expect(body.details).toHaveLength(2);
    expect(response.body).toContain('Dentist');
  });

  it('does not leak titles through the availability endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/users/${ALICE}/availability?start=${encodeURIComponent(DAY.start)}&end=${encodeURIComponent(DAY.end)}`,
      headers: { [DEV_ACTOR_HEADER]: BOB },
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['busy', 'ownerId', 'window']);
    expect(response.body).not.toContain('Climbing');
  });

  it('rejects an oversized window', async () => {
    const response = await app.inject({
      method: 'GET',
      url: calendarUrl(ALICE, { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' }),
      headers: { [DEV_ACTOR_HEADER]: BOB },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('rejects a malformed owner id without revealing why', async () => {
    const response = await app.inject({ method: 'GET', url: calendarUrl('not-a-uuid') });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('ignores a repeated dev actor header rather than picking one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: calendarUrl(ALICE),
      headers: { [DEV_ACTOR_HEADER]: [BOB, CAROL] as unknown as string },
    });
    expect(response.json()).toMatchObject({ busy: [], details: [] });
  });

  it('returns a bare 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});

describe('identity and preview endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer({
      config: testConfig,
      repos: createMemoryRepositories(createDemoSeed()),
    });
    await app.ready();
  });

  const win = () => {
    // Reach back a week so the current week's Monday-anchored seed events are in
    // range whatever weekday the suite runs on.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 21);
    return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  };

  it('returns the signed-in profile', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handle: 'alice' });
  });

  it('refuses /v1/me without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('lists your friends but never someone else’s', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/people',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(res.statusCode).toBe(200);
    const handles = res.json().people.map((p: { handle: string }) => p.handle);
    // Bob, Carol, Dave — not Mallory, who is blocked.
    expect(handles.sort()).toEqual(['bob', 'carol', 'dave']);
  });

  it('hides a stranger’s profile behind the same 404 as a missing one', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    const stranger = await app.inject({
      method: 'GET',
      url: `/v1/people/${SEED_MALLORY}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    const nonexistent = await app.inject({
      method: 'GET',
      url: `/v1/people/${missing}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(stranger.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(stranger.json()).toEqual(nonexistent.json());
  });

  it('previews your own calendar through a friend’s eyes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/calendar/preview?${win()}&viewerId=${SEED_BOB}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ownerId).toBe(SEED_ALICE);
    // Bob is in the climbing circle and attends, so he sees that in full.
    expect(res.body).toContain('Climbing at Vertigo');
    // He is not entitled to the therapy appointment at any level.
    expect(res.body).not.toContain('Therapy');
  });

  it('previews as a stranger without leaking anything private', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/calendar/preview?${win()}&viewerId=${SEED_MALLORY}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(res.statusCode).toBe(200);
    // Mallory is blocked: the preview must show Alice an empty week.
    expect(res.json()).toMatchObject({ busy: [], details: [] });
  });

  it('cannot be turned into a way to read someone else’s calendar', async () => {
    // The endpoint takes "whose eyes", never "whose calendar". Bob asking to
    // preview as Alice gets *Bob's* calendar as Alice sees it — his own data,
    // which he is entitled to — and never Alice's.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/calendar/preview?${win()}&viewerId=${SEED_ALICE}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_BOB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownerId).toBe(SEED_BOB);
    expect(res.body).not.toContain('Dentist');
  });

  it('refuses a preview without a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/calendar/preview?${win()}&viewerId=${SEED_BOB}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/events', () => {
  const window = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      qs: `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(
        end.toISOString(),
      )}`,
    };
  };

  const draft = (title: string) => {
    const w = window();
    const s = new Date(w.start);
    s.setDate(s.getDate() + 1);
    s.setHours(15, 0, 0, 0);
    const e = new Date(s);
    e.setHours(16, 0, 0, 0);
    return {
      title,
      timeRange: { start: s.toISOString(), end: e.toISOString() },
      visibilityCeiling: 'FULL' as const,
      shareRules: [{ audience: { kind: 'FRIENDS' as const }, level: 'TITLE' as const }],
    };
  };

  const server = () =>
    createServer({ config: testConfig, repos: createMemoryRepositories(createDemoSeed()) });

  it('creates an event and returns it as an owner FULL view', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
      payload: draft('Coffee with Priya'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ visibility: 'FULL', title: 'Coffee with Priya', ownerId: SEED_ALICE });
    // The owner-only annotation is present and reflects the FRIENDS→TITLE rule.
    expect(body.sharedAs).toBe('TITLE');
  });

  it('persists the event so a subsequent read returns it', async () => {
    const app = await server();
    await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
      payload: draft('Coffee with Priya'),
    });
    const read = await app.inject({
      method: 'GET',
      url: `/v1/users/${SEED_ALICE}/calendar?${window().qs}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
    });
    expect(read.body).toContain('Coffee with Priya');
  });

  it('ignores an ownerId smuggled into the body', async () => {
    // The single most important test for this endpoint: the owner comes from
    // the session. A body that names Bob must still create on Alice's calendar.
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
      payload: { ...draft('Sneaky'), ownerId: SEED_BOB, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownerId).toBe(SEED_ALICE);

    // And nothing landed on Bob's calendar.
    const bobWeek = await app.inject({
      method: 'GET',
      url: `/v1/users/${SEED_BOB}/calendar?${window().qs}`,
      headers: { [DEV_ACTOR_HEADER]: SEED_BOB },
    });
    expect(bobWeek.body).not.toContain('Sneaky');
  });

  it('rejects a malformed body with a bare 400', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { [DEV_ACTOR_HEADER]: SEED_ALICE },
      payload: { title: '', timeRange: { start: 'nonsense', end: 'nonsense' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses to create without a session', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/v1/events', payload: draft('X') });
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticator', () => {
  /**
   * This block used to assert that the server **refused to boot** in
   * production, because no real authenticator existed
   * ([ADR 0006](../../../docs/adr/0006-authentication-deferred.md)).
   *
   * One now does ([ADR 0024](../../../docs/adr/0024-authentication.md)), so the
   * refusal is gone — that was the entire point of it. The *property* it
   * protected is not gone, and is asserted here and in `auth.test.ts`: in
   * production the development header does nothing at all.
   */
  it('boots in production, now that a real authenticator exists', async () => {
    const app = await createServer({
      config: { ...testConfig, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://friends-zone.app' },
      repos: createMemoryRepositories(createDemoSeed()),
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('ignores the development header in production', async () => {
    const app = await createServer({
      config: { ...testConfig, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://friends-zone.app' },
      repos: createMemoryRepositories(createDemoSeed()),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-dev-actor-id': ALICE },
    });
    expect(res.statusCode).toBe(401);
  });
});
