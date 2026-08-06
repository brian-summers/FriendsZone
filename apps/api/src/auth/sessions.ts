import { SESSION_COOKIE, SESSION_TTL_DAYS, type Session } from '@friendszone/contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens and the cookie that carries them.
 *
 * The rule this file exists to enforce: **the token is never stored.** What goes
 * in the session store is its SHA-256 hash, so reading the store yields values
 * that cannot be presented as credentials. A session token is a bearer
 * credential and deserves what a password gets (ADR 0024).
 */

/** 256 bits. Guessing is not a threat we need to think about again. */
export const mintSessionToken = (): string => randomBytes(32).toString('base64url');

/**
 * SHA-256, not scrypt.
 *
 * A password is low-entropy and needs a slow, memory-hard hash to survive an
 * offline attack on the store. A 256-bit random token has nothing to grind, so
 * the only job here is to make the stored value non-presentable — and a fast
 * hash is correct, because this runs on **every authenticated request**.
 */
export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const sessionExpiry = (from: Date = new Date()): string =>
  new Date(from.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString();

export const isExpired = (session: Session, now: Date = new Date()): boolean =>
  Date.parse(session.expiresAt) <= now.getTime();

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than a dependency: this is the whole of what we need from
 * cookie parsing, and the auth path is the last place to add a package for
 * fifteen lines.
 *
 * A **repeated** cookie name is refused rather than resolved, for the same
 * reason `authenticate` refuses a repeated header: smuggling depends on two
 * parties disagreeing about which duplicate wins.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  let found: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null; // repeated — refuse
    found = part.slice(eq + 1).trim();
  }
  return found === null || found === '' ? null : found;
}

/**
 * Constant-time compare for token hashes.
 *
 * The stored value is already a hash, so this is belt-and-braces — but a
 * lookup that short-circuits on the first differing character is a habit worth
 * not having anywhere near session handling.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Build the `Set-Cookie` value.
 *
 * `Secure` is tied to `PUBLIC_ORIGIN` being https rather than to `NODE_ENV`:
 * the question is whether this connection can carry a secure cookie, and the
 * origin is the honest answer to that. A local http dev server still works; a
 * deployment over https always gets the flag.
 */
export function sessionCookie(opts: {
  token: string;
  publicOrigin: string;
  maxAgeSeconds?: number;
}): string {
  const secure = opts.publicOrigin.startsWith('https://');
  const maxAge = opts.maxAgeSeconds ?? SESSION_TTL_DAYS * 86_400;

  return [
    `${SESSION_COOKIE}=${opts.token}`,
    'Path=/',
    // Unreadable to JavaScript, so an XSS cannot lift the session.
    'HttpOnly',
    // Blocks cookie-bearing cross-site POSTs. Paired with the JSON content-type
    // requirement, that covers CSRF without a token round-trip (ADR 0024).
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Expire the cookie immediately. Used on logout. */
export const clearedSessionCookie = (publicOrigin: string): string =>
  sessionCookie({ token: '', publicOrigin, maxAgeSeconds: 0 });
