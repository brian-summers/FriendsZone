import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from './authenticate.js';
import { consume, createRateLimiter, RATE_LIMITS } from './rate-limit.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';

/** The one suite that runs with limiting *on*. Everything else opts out. */
const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  RATE_LIMIT_ENABLED: true,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

describe('the token bucket', () => {
  const spec = { capacity: 3, refillPerSecond: 1 };

  it('allows a burst up to capacity, then refuses', () => {
    const bucket = { tokens: spec.capacity, lastRefillMs: 0 };
    expect(consume(bucket, spec, 0).allowed).toBe(true);
    expect(consume(bucket, spec, 0).allowed).toBe(true);
    expect(consume(bucket, spec, 0).allowed).toBe(true);
    expect(consume(bucket, spec, 0).allowed).toBe(false);
  });

  it('refills over time', () => {
    const bucket = { tokens: 0, lastRefillMs: 0 };
    expect(consume(bucket, spec, 500).allowed).toBe(false);
    // One second buys exactly one token.
    expect(consume(bucket, spec, 1_000).allowed).toBe(true);
  });

  it('never accrues beyond capacity while idle', () => {
    // Otherwise a caller who waits an hour gets an hour's worth of burst, and
    // the limit stops bounding anything.
    const bucket = { tokens: 0, lastRefillMs: 0 };
    consume(bucket, spec, 3_600_000);
    expect(bucket.tokens).toBeLessThanOrEqual(spec.capacity);
  });

  it('reports how long to wait, always at least a second', () => {
    const bucket = { tokens: 0, lastRefillMs: 0 };
    const verdict = consume(bucket, spec, 0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('keeps classes and keys in separate buckets', () => {
    const limiter = createRateLimiter({
      ...RATE_LIMITS,
      WRITE: { capacity: 1, refillPerSecond: 0 },
    });
    expect(limiter.check('WRITE', 'alice', 0).allowed).toBe(true);
    expect(limiter.check('WRITE', 'alice', 0).allowed).toBe(false);
    // A different person is unaffected…
    expect(limiter.check('WRITE', 'bob', 0).allowed).toBe(true);
    // …and so is a different class for the same person.
    expect(limiter.check('READ', 'alice', 0).allowed).toBe(true);
  });
});

describe('config', () => {
  it('refuses to start in production with limiting disabled', () => {
    // Same posture as the authenticator: a control that can be quietly turned
    // off in production is one that eventually is.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost:5432/x',
        SESSION_SECRET: 'y'.repeat(48),
        PUBLIC_ORIGIN: 'https://friends-zone.app',
        RATE_LIMIT_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    ).toThrow(/RATE_LIMIT_ENABLED/);
  });

  it('is on by default', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost:5432/x',
      SESSION_SECRET: 'y'.repeat(48),
      PUBLIC_ORIGIN: 'http://localhost:5173',
    } as NodeJS.ProcessEnv);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
  });
});

describe('enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  const upload = (actor: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/photos',
      headers: as(actor),
      payload: { data: 'not-an-image' },
    });

  it('refuses with 429 and a Retry-After once the bucket is empty', async () => {
    // UPLOAD is the tightest class, so it is the cheapest to exhaust.
    const capacity = RATE_LIMITS.UPLOAD.capacity;
    for (let i = 0; i < capacity; i += 1) {
      // These 400 on the payload, which is fine - a refused-for-content request
      // still spent a token, which is the behaviour we want.
      expect((await upload(ALICE)).statusCode).toBe(400);
    }

    const limited = await upload(ALICE);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('limits each actor separately', async () => {
    for (let i = 0; i < RATE_LIMITS.UPLOAD.capacity; i += 1) await upload(ALICE);
    expect((await upload(ALICE)).statusCode).toBe(429);

    // Bob's budget is his own. Sharing one would let any user deny service to
    // every other user.
    expect((await upload(BOB)).statusCode).not.toBe(429);
  });

  it('does not let an exhausted class block a different one', async () => {
    for (let i = 0; i < RATE_LIMITS.UPLOAD.capacity + 1; i += 1) await upload(ALICE);
    expect((await upload(ALICE)).statusCode).toBe(429);

    // Reads are a different bucket, so Alice can still use the product.
    const read = await app.inject({ method: 'GET', url: '/v1/me', headers: as(ALICE) });
    expect(read.statusCode).toBe(200);
  });

  it('limits the slot finder harder than ordinary reads', async () => {
    // ADR 0008 asks for this explicitly: one call fans out to as many as twenty
    // calendar projections.
    expect(RATE_LIMITS.EXPENSIVE.capacity).toBeLessThan(RATE_LIMITS.READ.capacity);
    expect(RATE_LIMITS.EXPENSIVE.refillPerSecond).toBeLessThan(RATE_LIMITS.READ.refillPerSecond);
  });

  it('still carries the standard security headers on a 429', async () => {
    for (let i = 0; i < RATE_LIMITS.UPLOAD.capacity; i += 1) await upload(ALICE);
    const limited = await upload(ALICE);

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['x-content-type-options']).toBe('nosniff');
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('leaves every other route working while one is exhausted', async () => {
    for (let i = 0; i < RATE_LIMITS.UPLOAD.capacity + 1; i += 1) await upload(ALICE);
    const listings = await app.inject({ method: 'GET', url: '/v1/listings', headers: as(ALICE) });
    expect(listings.statusCode).toBe(200);
  });
});
