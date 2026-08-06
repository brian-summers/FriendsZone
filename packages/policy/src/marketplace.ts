import type { Instant, Listing } from '@friendszone/contracts';

/**
 * Marketplace rules that are pure functions of their arguments.
 *
 * This module deliberately imports nothing from the rest of the kernel, so that
 * `actions.ts` can use it without a cycle. The listing *projection* lives in
 * `projection.ts` with the others, because it needs `can()` and because keeping
 * every projection in one file keeps the "never spread a stored entity" rule
 * reviewable in one place.
 *
 * See docs/adr/0017-claim-modes-and-deadlines.md.
 */

/**
 * Has claiming closed?
 *
 * A listing with no `claimsCloseAt` never closes, so this is `false` — an offer
 * may legitimately stay open indefinitely. Note what that means for
 * `listing:draw`: a lottery with no deadline can never be drawn, which is the
 * intended reading rather than an oversight. Drawing whenever you like is not a
 * draw, it is picking.
 *
 * The comparison is `>=`, so the deadline instant itself is closed. A boundary
 * has to fall on one side or the other, and "closes at 5pm" reading as "5pm is
 * too late" is what people expect from a deadline.
 */
export function areClaimsClosed(
  listing: Pick<Listing, 'claimsCloseAt'>,
  now: Instant,
): boolean {
  if (listing.claimsCloseAt === undefined) return false;
  return Date.parse(now) >= Date.parse(listing.claimsCloseAt);
}

/**
 * Pick one entry at random.
 *
 * `unitInterval` must come from the caller, in `[0, 1)`. The kernel does not
 * read a random source any more than it reads the clock, and threading the
 * number through is what makes a draw reproducible in a test: given the same
 * entries and the same number, the same entry wins, every time.
 *
 * Callers must supply a *cryptographic* source. The draw is not a security
 * boundary in the strict sense — nothing is protected by the outcome — but a
 * sequence an entrant could predict from earlier draws would hollow out the one
 * property the feature is sold on.
 */
export function drawWinner<T>(entries: readonly T[], unitInterval: number): T | null {
  if (entries.length === 0) return null;
  if (!Number.isFinite(unitInterval) || unitInterval < 0 || unitInterval >= 1) {
    throw new RangeError('drawWinner: unitInterval must be in [0, 1)');
  }
  // `min` guards the case where a value just under 1 rounds up to length after
  // multiplication, which would index off the end.
  const index = Math.min(Math.floor(unitInterval * entries.length), entries.length - 1);
  return entries[index] ?? null;
}
