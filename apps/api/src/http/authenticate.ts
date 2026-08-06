import { SESSION_COOKIE, UserId } from '@friendszone/contracts';
import type { Config } from '../config.js';
import { hashSessionToken, isExpired, readCookie } from '../auth/sessions.js';
import type { SessionPort } from '../repositories/ports.js';

/**
 * Resolve the calling principal.
 *
 * Two paths, in this order:
 *
 * 1. **The session cookie.** The real one. An opaque token, hashed before it is
 *    looked up, so the store never holds anything presentable
 *    (docs/adr/0024-authentication.md).
 * 2. **`x-dev-actor-id`**, and only when `NODE_ENV !== 'production'`.
 *
 * ADR 0006 made the *absence* of authentication undeployable by throwing here in
 * production. That throw is gone, because the thing it was waiting for now
 * exists. The property it protected is not: in production the dev header is
 * ignored entirely, whatever it contains, and `server.test.ts` asserts it.
 */
export type Authenticator = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
) => Promise<UserId | null>;

export const DEV_ACTOR_HEADER = 'x-dev-actor-id';

export function createAuthenticator(config: Config, sessions: SessionPort): Authenticator {
  const devHeaderAllowed = config.NODE_ENV !== 'production';

  return async (headers) => {
    // ── The session cookie ──────────────────────────────────────────
    const cookieHeader = headers['cookie'];
    if (typeof cookieHeader === 'string') {
      const token = readCookie(cookieHeader, SESSION_COOKIE);
      if (token !== null) {
        const session = await sessions.byTokenHash(hashSessionToken(token));
        if (session !== null) {
          if (isExpired(session)) {
            // Clean up on the way past. An expired row is not a credential and
            // keeping it only grows the store.
            await sessions.revoke(session.tokenHash);
          } else {
            return session.userId;
          }
        }
        /**
         * A cookie that did not resolve does **not** fall through to the dev
         * header. Presenting a bad session and getting someone else's identity
         * because a header happened to be set is the kind of surprise that
         * makes a test pass and a deployment leak.
         */
        return null;
      }
    }

    // ── Development shortcut ────────────────────────────────────────
    if (!devHeaderAllowed) return null;

    const raw = headers[DEV_ACTOR_HEADER];
    if (raw === undefined) return null;
    // A repeated header arrives as an array. Rather than picking one, refuse:
    // header smuggling relies on two parties disagreeing about which wins.
    if (typeof raw !== 'string') return null;

    // Even the development shortcut validates. A malformed id must not reach
    // the policy engine, where it would be compared against real owner ids.
    const parsed = UserId.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}
