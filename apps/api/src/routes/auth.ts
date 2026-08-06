import {
  LoginInput,
  RegisterInput,
  SESSION_COOKIE,
  type AuthIdentity,
  type AuthResult,
  type PublicProfile,
  type Session,
  type UserId,
} from '@friendszone/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, verifyAgainstNobody, verifyPassword } from '../auth/password.js';
import {
  clearedSessionCookie,
  hashSessionToken,
  mintSessionToken,
  readCookie,
  sessionCookie,
  sessionExpiry,
} from '../auth/sessions.js';
import type { Config } from '../config.js';
import { ValidationError } from '../http/errors.js';
import { defineRoute, withCookie } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Register, log in, log out.
 *
 * Two properties this file exists to hold, both easy to lose in a refactor:
 *
 * 1. **Login never reveals whether an account exists.** Same status, same body,
 *    and — via `verifyAgainstNobody` — the same wall-clock cost whether the
 *    email is unknown or the password is wrong. Account existence is social
 *    information in this product, so the timing side is not optional.
 *
 * 2. **The session token is never stored.** Only its hash reaches the port.
 *
 * See docs/adr/0024-authentication.md.
 */

/** Deliberately identical for both login failures. Never says which. */
const BAD_CREDENTIALS = { error: 'invalid_credentials' } as const;

export function buildAuthRoutes(repos: Repositories, config: Config) {
  /** Mint a session and the cookie that carries it. */
  const startSession = async (userId: UserId): Promise<string> => {
    const token = mintSessionToken();
    const session: Session = {
      // Hashed here, so the raw token exists only in this function and the
      // cookie. Nothing downstream can log what it never receives.
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: sessionExpiry(),
    };
    await repos.sessions.create(session);
    return sessionCookie({ token, publicOrigin: config.PUBLIC_ORIGIN });
  };

  return [
    /**
     * Create an account.
     *
     * Handle collisions are reported — handles exist to be searched for, so the
     * directory already answers whether one is taken. **Email collisions are
     * not distinguished** in the message, which narrows but does not close the
     * enumeration gap; the real fix is a verification email, and it is recorded
     * as a known gap in the threat model rather than glossed (ADR 0024).
     */
    defineRoute({
      method: 'POST',
      url: '/v1/auth/register',
      authz: {
        kind: 'PUBLIC',
        justification:
          'Creating an account cannot require an account. Guarded by the tightest rate-limit class and by password rules; it establishes the very identity every other route authorises against.',
      },
      rateLimit: 'UPLOAD',
      params: z.object({}),
      query: z.object({}),
      body: RegisterInput,
      handler: async (ctx) => {
        const { email, password, handle, displayName } = ctx.body;

        const [existingIdentity, handleTaken] = await Promise.all([
          repos.credentials.identity('PASSWORD', email),
          repos.directory.handleTaken(handle),
        ]);

        if (existingIdentity !== null || handleTaken) {
          // One message for both, so a caller supplying a fresh handle cannot
          // read "taken" as "that email exists" quite so cleanly.
          throw new ValidationError(['email_or_handle_taken']);
        }

        const userId = randomUUID() as UserId;
        const profile: PublicProfile = { id: userId, handle, displayName };
        await repos.directory.create(profile);

        const identity: AuthIdentity = {
          userId,
          provider: 'PASSWORD',
          subject: email,
          secretHash: await hashPassword(password),
          createdAt: new Date().toISOString(),
        };
        await repos.credentials.create(identity);

        const result: AuthResult = { userId, handle, displayName };
        return withCookie(result, await startSession(userId));
      },
    }),

    /**
     * Log in.
     *
     * The shape below is the whole point: both failure paths cost a scrypt
     * verification and return byte-identical responses.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/auth/login',
      authz: {
        kind: 'PUBLIC',
        justification:
          'Logging in cannot require being logged in. Both failure modes are indistinguishable in body, status, and timing, and the route draws from the tightest rate-limit class.',
      },
      rateLimit: 'UPLOAD',
      params: z.object({}),
      query: z.object({}),
      body: LoginInput,
      handler: async (ctx) => {
        const identity = await repos.credentials.identity('PASSWORD', ctx.body.email);

        if (identity?.secretHash === undefined) {
          /**
           * No such account — and we still pay for a hash.
           *
           * Returning here immediately would make "no such account" answer in
           * microseconds while "wrong password" takes ~100 ms, which is a
           * perfectly good account-existence oracle.
           */
          await verifyAgainstNobody(ctx.body.password);
          throw new ValidationError([BAD_CREDENTIALS.error]);
        }

        const ok = await verifyPassword(ctx.body.password, identity.secretHash);
        if (!ok) throw new ValidationError([BAD_CREDENTIALS.error]);

        const profile = await repos.directory.profile(identity.userId);
        // A credential with no profile is a broken account, not a login.
        if (profile === null) throw new ValidationError([BAD_CREDENTIALS.error]);

        /**
         * A fresh session per login, never a reused one — rotation on
         * authentication is what stops a token fixed before login from being
         * valid after it (ADR 0006's constraint list, ADR 0024's implementation).
         */
        const result: AuthResult = {
          userId: identity.userId,
          handle: profile.handle,
          displayName: profile.displayName,
        };
        return withCookie(result, await startSession(identity.userId));
      },
    }),

    /**
     * Log out.
     *
     * Revokes server-side *and* clears the cookie. Clearing the cookie alone
     * would leave a token that still works if anyone kept a copy — which is the
     * scenario logout exists for.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/auth/logout',
      authz: {
        kind: 'PUBLIC',
        justification:
          'Logging out must work even when the session is already invalid, so it cannot require one. It reads nothing and reveals nothing: the response is identical whether a session was revoked or there was none.',
      },
      rateLimit: 'WRITE',
      params: z.object({}),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx) => {
        const token = readCookie(ctx.cookieHeader, SESSION_COOKIE);
        if (token !== null) await repos.sessions.revoke(hashSessionToken(token));

        // Same answer either way — logging out of nothing is not an error and
        // not a signal.
        return withCookie({ ok: true }, clearedSessionCookie(config.PUBLIC_ORIGIN));
      },
    }),
  ];
}
