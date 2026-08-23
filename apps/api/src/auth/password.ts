import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from `node:crypto`, not Argon2id. That is a deliberate deviation from
 * ADR 0006's constraint list, argued in docs/adr/0024-authentication.md: every
 * Argon2id implementation for Node is a native module, and this repo has three
 * runtime dependencies in total.
 *
 * **The parameters below are load-bearing on rate limiting.** At `N=2^16` each
 * hash costs roughly 64 MB, which is itself a denial-of-service surface; the
 * credential routes draw from a tight bucket to bound how many can run at once.
 * If that limiter is ever removed, these numbers become a liability.
 */

/** OWASP's second tier. See the ADR for why not `2^17`. */
const PARAMS = { N: 2 ** 16, r: 8, p: 1 } as const;

/** Headroom over `128 * N * r` (~64 MiB) so a valid hash never hits the cap. */
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * `scrypt$N$r$p$salt$hash`, base64url throughout.
 *
 * Self-describing on purpose: the algorithm and its cost travel with the hash,
 * so raising the parameters - or moving to Argon2id - can verify old hashes and
 * re-hash on next successful login rather than needing a flag day.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` for a malformed or unknown-algorithm hash rather than
 * throwing: a corrupt row must fail closed as "wrong password", not surface a
 * distinguishable 500 that tells an attacker they found something unusual.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A stored row claiming absurd parameters would be a way to make us burn
  // memory on demand. Bound what we are willing to honour.
  if (N > 2 ** 20 || r > 32 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashRaw!, 'base64url');
    actual = await scrypt(password, Buffer.from(saltRaw!, 'base64url'), expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }

  if (expected.length !== actual.length) return false;
  // Constant-time. A byte-by-byte early exit leaks the hash prefix.
  return timingSafeEqual(expected, actual);
}

/**
 * A hash of a value nobody knows, for the unknown-account path.
 *
 * Computed once at boot and verified against when a login names an email we do
 * not have. Without this, "no such account" returns in microseconds while
 * "wrong password" takes ~100 ms, and that difference is a perfectly good
 * account-existence oracle - which matters more here than in most products,
 * because account existence is social information.
 */
let dummyHash: Promise<string> | null = null;

export function primeDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

/**
 * Burn the same time an unsuccessful real verification would.
 *
 * Always returns `false`. The return value exists so call sites read as an
 * ordinary verification rather than as a special case that a future edit might
 * "optimise" away.
 */
export async function verifyAgainstNobody(password: string): Promise<boolean> {
  await verifyPassword(password, await primeDummyHash());
  return false;
}
