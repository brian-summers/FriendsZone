import { z } from 'zod';
import { Handle, Instant, ShortText, UserId } from './primitives.js';

/**
 * Authentication.
 *
 * Two shapes matter here and both are about what is *not* in them:
 *
 *  - `AuthIdentity` is keyed by `(provider, subject)` rather than being a
 *    password column on `User`, so adding Google or Apple later is a new
 *    provider rather than a migration.
 *  - Email lives on the identity, never on `User`. `User`'s own comment
 *    promises "no password hash, no email, no phone", and that promise is what
 *    stops an accidentally-serialised `User` from being a contact leak.
 *
 * See docs/adr/0024-authentication.md.
 */

export const AuthProvider = z.enum([
  /** Email and password. `subject` is the normalised email. */
  'PASSWORD',
  // Not built. Listed so the shape is visibly ready and a reviewer can see
  // that adding one changes nothing downstream (ADR 0024).
  'GOOGLE',
  'APPLE',
]);
export type AuthProvider = z.infer<typeof AuthProvider>;

/**
 * Email, normalised for comparison.
 *
 * Lower-cased and trimmed so `Alice@Example.com` and `alice@example.com` cannot
 * become two accounts. Deliberately *not* stripping dots or `+tags`: that is
 * Gmail-specific behaviour, and applying it to every provider silently merges
 * addresses that their owners consider distinct.
 */
export const Email = z.string().trim().toLowerCase().email().max(254);
export type Email = z.infer<typeof Email>;

/**
 * A way of proving you are a particular user.
 *
 * 🔴 Restricted. `secretHash` never leaves the process, is never logged, and is
 * never projected - there is no view type that includes it, which is the point.
 */
export const AuthIdentity = z.object({
  userId: UserId,
  provider: AuthProvider,
  /** Normalised email for `PASSWORD`; the provider's subject id otherwise. */
  subject: z.string().min(1).max(254),
  /**
   * Self-describing hash: `scrypt$N$r$p$salt$hash`.
   *
   * The algorithm and its parameters travel with the hash so a future move to
   * Argon2id can verify old hashes and re-hash on next successful login,
   * without a flag day (ADR 0024).
   */
  secretHash: z.string().max(512).optional(),
  createdAt: Instant,
});
export type AuthIdentity = z.infer<typeof AuthIdentity>;

/**
 * A logged-in session.
 *
 * `tokenHash`, not the token. A session token is a bearer credential and gets
 * the same treatment a password does: what is stored cannot be presented.
 */
export const Session = z.object({
  tokenHash: z.string().length(64),
  userId: UserId,
  createdAt: Instant,
  expiresAt: Instant,
});
export type Session = z.infer<typeof Session>;

/**
 * Password rules.
 *
 * A length floor and nothing else. Composition rules ("one uppercase, one
 * symbol") measurably push people towards `Password1!` and are recommended
 * against by NIST; length is what actually helps. The 200-character ceiling is
 * a denial-of-service bound, not a security opinion - scrypt on an unbounded
 * input is a free way to burn our CPU.
 */
export const Password = z.string().min(12).max(200);
export type Password = z.infer<typeof Password>;

export const RegisterInput = z.object({
  email: Email,
  password: Password,
  handle: Handle,
  displayName: ShortText,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: Email,
  /**
   * Not `Password` - a login must accept any string and fail, rather than
   * rejecting a too-short one at the schema and thereby answering "that is not
   * even the right shape for this account's password".
   */
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

/** What a successful register or login returns. No token: it is in the cookie. */
export const AuthResult = z.object({
  userId: UserId,
  handle: Handle,
  displayName: ShortText,
});
export type AuthResult = z.infer<typeof AuthResult>;

/** The session cookie's name. One definition, used by server and tests. */
export const SESSION_COOKIE = 'fz_session';

/** Absolute session lifetime. Not sliding - see ADR 0024. */
export const SESSION_TTL_DAYS = 30;
