import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '@friendszone/contracts';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { hashSessionToken, readCookie } from '../auth/sessions.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

const base: Config = {
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

const GOOD = { email: 'nina@example.com', password: 'correct horse battery', handle: 'nina', displayName: 'Nina Okafor' };

/** Pull the session token out of a Set-Cookie header. */
const tokenFrom = (setCookie: string | string[] | undefined): string | null => {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return raw === undefined ? null : readCookie(raw.split(';')[0], SESSION_COOKIE);
};

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same input')).not.toBe(await hashPassword('same input'));
  });

  it('stores its algorithm and cost, so a future rehash can be staged', async () => {
    const hash = await hashPassword('x'.repeat(12));
    expect(hash.startsWith('scrypt$65536$8$1$')).toBe(true);
  });

  it('fails closed on a malformed or foreign hash rather than throwing', async () => {
    // A corrupt row must read as "wrong password", not as a distinguishable 500
    // telling an attacker they found something unusual.
    for (const bad of ['', 'nonsense', 'argon2id$x$y', 'scrypt$1$2$3', 'scrypt$a$b$c$d$e']) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });

  it('refuses absurd stored parameters rather than honouring them', async () => {
    // Otherwise a tampered row is a way to make us burn memory on demand.
    const absurd = `scrypt$${2 ** 24}$8$1$c2FsdA$aGFzaA`;
    await expect(verifyPassword('anything', absurd)).resolves.toBe(false);
  });
});

describe('auth', () => {
  let app: FastifyInstance;
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(async () => {
    repos = createMemoryRepositories(createDemoSeed());
    app = await createServer({ config: base, repos });
    await app.ready();
  });

  const register = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/v1/auth/register', payload: { ...GOOD, ...payload } });

  const login = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/auth/login', payload });

  // ── Registration ───────────────────────────────────────────────────
  describe('registration', () => {
    it('creates an account and signs you straight in', async () => {
      const res = await register();
      expect(res.statusCode).toBe(200);
      expect(res.json().handle).toBe('nina');

      const token = tokenFrom(res.headers['set-cookie']);
      expect(token).not.toBeNull();

      // The session works immediately.
      const me = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(me.json().handle).toBe('nina');
    });

    it('never stores the password, nor the session token', async () => {
      const res = await register();
      const token = tokenFrom(res.headers['set-cookie'])!;

      const identity = await repos.credentials.identity('PASSWORD', GOOD.email);
      expect(identity?.secretHash).toBeDefined();
      expect(identity?.secretHash).not.toContain(GOOD.password);

      // The store holds the hash; presenting it would not work.
      expect(await repos.sessions.byTokenHash(token)).toBeNull();
      expect(await repos.sessions.byTokenHash(hashSessionToken(token))).not.toBeNull();
    });

    it('refuses a duplicate email and a duplicate handle the same way', async () => {
      await register();
      const sameEmail = await register({ handle: 'someoneelse' });
      const sameHandle = await register({ email: 'other@example.com' });

      // One message for both, so a fresh handle does not cleanly answer
      // "does this email exist" (ADR 0024 — a narrowing, not a fix).
      expect(sameEmail.statusCode).toBe(sameHandle.statusCode);
      expect(sameEmail.body).toBe(sameHandle.body);
    });

    it('enforces a password length floor', async () => {
      expect((await register({ password: 'short' })).statusCode).toBe(400);
    });

    it('normalises the email, so one address cannot become two accounts', async () => {
      await register({ email: 'Nina@Example.COM ' });
      expect(await repos.credentials.identity('PASSWORD', 'nina@example.com')).not.toBeNull();
    });
  });

  // ── Login ──────────────────────────────────────────────────────────
  describe('login', () => {
    it('signs in with the right password', async () => {
      await register();
      const res = await login({ email: GOOD.email, password: GOOD.password });
      expect(res.statusCode).toBe(200);
      expect(tokenFrom(res.headers['set-cookie'])).not.toBeNull();
    });

    it('does not reveal whether an account exists', async () => {
      // The property the whole design turns on: account existence is social
      // information in this product.
      await register();
      const wrongPassword = await login({ email: GOOD.email, password: 'not the password' });
      const noSuchAccount = await login({ email: 'nobody@example.com', password: 'not the password' });

      expect(wrongPassword.statusCode).toBe(noSuchAccount.statusCode);
      expect(wrongPassword.body).toBe(noSuchAccount.body);
      expect(wrongPassword.statusCode).toBe(400);
    });

    it('pays for a hash even when the account does not exist', async () => {
      /**
       * Timing, asserted as a *ratio* rather than an absolute, because absolute
       * millisecond thresholds are how a test becomes flaky on a loaded CI box.
       * Without `verifyAgainstNobody` the unknown-account path returns in
       * microseconds and this ratio collapses.
       */
      await register();

      const time = async (fn: () => Promise<unknown>): Promise<number> => {
        const started = performance.now();
        await fn();
        return performance.now() - started;
      };

      const wrongPassword = await time(() =>
        login({ email: GOOD.email, password: 'not the password' }),
      );
      const unknown = await time(() =>
        login({ email: 'nobody@example.com', password: 'not the password' }),
      );

      // Same order of magnitude. A missing dummy hash shows up as ~100x.
      expect(unknown).toBeGreaterThan(wrongPassword / 5);
    });

    it('issues a fresh session on every login', async () => {
      await register();
      const first = tokenFrom((await login({ email: GOOD.email, password: GOOD.password })).headers['set-cookie']);
      const second = tokenFrom((await login({ email: GOOD.email, password: GOOD.password })).headers['set-cookie']);

      expect(first).not.toBe(second);
      // The earlier one still works — this is rotation on login, not a
      // single-session policy. Logging in on a phone must not sign out a laptop.
      expect(await repos.sessions.byTokenHash(hashSessionToken(first!))).not.toBeNull();
    });
  });

  // ── The cookie ─────────────────────────────────────────────────────
  describe('the session cookie', () => {
    it('is HttpOnly, SameSite=Lax, and path-scoped', async () => {
      const res = await register();
      const raw = String(res.headers['set-cookie']);
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Lax');
      expect(raw).toContain('Path=/');
    });

    it('is Secure when the origin is https, and not when it cannot be', async () => {
      // Tied to the origin rather than NODE_ENV: the question is whether this
      // connection can carry a secure cookie.
      expect(String((await register()).headers['set-cookie'])).not.toContain('Secure');

      const secure = await createServer({
        config: { ...base, PUBLIC_ORIGIN: 'https://friends-zone.app' },
        repos: createMemoryRepositories(createDemoSeed()),
      });
      await secure.ready();
      const res = await secure.inject({ method: 'POST', url: '/v1/auth/register', payload: GOOD });
      expect(String(res.headers['set-cookie'])).toContain('Secure');
    });

    it('ignores a repeated session cookie rather than picking one', async () => {
      // Smuggling depends on two parties disagreeing about which duplicate wins.
      const token = tokenFrom((await register()).headers['set-cookie']);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('does not fall through to the dev header when a cookie is present but bad', async () => {
      // Presenting a bad session and getting someone else's identity because a
      // header happened to be set is exactly the surprise to avoid.
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: {
          cookie: `${SESSION_COOKIE}=not-a-real-token`,
          [DEV_ACTOR_HEADER]: ALICE,
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────
  describe('logout', () => {
    it('revokes the session server-side, not just the cookie', async () => {
      const token = tokenFrom((await register()).headers['set-cookie'])!;
      const cookie = `${SESSION_COOKIE}=${token}`;

      const out = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { cookie },
        payload: {},
      });
      expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');

      // Replaying the token fails: clearing the cookie alone would leave a
      // working credential for anyone who kept a copy.
      const replay = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
      expect(replay.statusCode).toBe(401);
    });

    it('answers the same when there was no session', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: {} });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── The production guarantee ───────────────────────────────────────
  describe('in production', () => {
    it('ignores the dev header entirely', async () => {
      /**
       * ADR 0006 made the absence of auth undeployable by throwing here. That
       * throw is gone now that auth exists — but the property it protected is
       * not, and this is the test that keeps it.
       */
      const prod = await createServer({
        config: { ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://friends-zone.app' },
        repos: createMemoryRepositories(createDemoSeed()),
      });
      await prod.ready();

      const res = await prod.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { [DEV_ACTOR_HEADER]: ALICE },
      });
      expect(res.statusCode).toBe(401);
    });

    it('still boots — the deferral guard is satisfied, not bypassed', async () => {
      const prod = await createServer({
        config: { ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://friends-zone.app' },
        repos: createMemoryRepositories(createDemoSeed()),
      });
      await prod.ready();
      expect((await prod.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    });
  });

  // ── Deletion interacts with sessions ───────────────────────────────
  it('kills every session when the account is deleted', async () => {
    const token = tokenFrom((await register()).headers['set-cookie'])!;
    const cookie = `${SESSION_COOKIE}=${token}`;

    await app.inject({
      method: 'POST',
      url: '/v1/me/delete',
      headers: { cookie },
      payload: { confirmHandle: 'nina' },
    });

    // A deleted account must stop working immediately, not at expiry.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode).toBe(401);
    // …and must not be able to log back in.
    expect((await login({ email: GOOD.email, password: GOOD.password })).statusCode).toBe(400);
  });
});
