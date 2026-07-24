import { z } from 'zod';
import { CircleId, Instant, ShortText, UserId } from './primitives.js';

/**
 * The viewer's relationship to the owner of whatever is being accessed.
 *
 * This is the single input that most authorization decisions turn on, so it is
 * an explicit closed union rather than a pile of booleans. `NONE` is the
 * default for anyone we know nothing about, including unauthenticated callers.
 */
export const RelationshipKind = z.enum([
  /** Viewer is the owner. */
  'SELF',
  /** Mutual, accepted friendship. */
  'FRIEND',
  /** A friend request exists in one direction but is not accepted. */
  'PENDING',
  /** Either party has blocked the other. Always terminal, always deny. */
  'BLOCKED',
  /** No relationship, or viewer is anonymous. */
  'NONE',
]);
export type RelationshipKind = z.infer<typeof RelationshipKind>;

/**
 * Friendship is stored as a single row with a canonical ordering of the two
 * user ids (lowUserId < highUserId) so that the pair is unique and cannot
 * drift into a half-accepted state visible only from one side.
 */
export const Friendship = z.object({
  lowUserId: UserId,
  highUserId: UserId,
  /** Who sent the original request; needed to render "accept" vs "cancel". */
  requestedBy: UserId,
  status: z.enum(['PENDING', 'ACCEPTED']),
  createdAt: Instant,
  acceptedAt: Instant.optional(),
});
export type Friendship = z.infer<typeof Friendship>;

/**
 * A block is intentionally *not* modelled as a friendship status. It is a
 * separate, directed record so that unblocking never silently restores a
 * friendship, and so that a block cannot be erased by a friendship state
 * transition.
 */
export const Block = z.object({
  blockerId: UserId,
  blockedId: UserId,
  createdAt: Instant,
});
export type Block = z.infer<typeof Block>;

/**
 * A named subset of a user's friends ("climbing crew", "work"), owned by and
 * visible only to its owner. Circles are the unit of calendar sharing: they let
 * a user be specific without publishing a taxonomy of their social life.
 */
export const Circle = z.object({
  id: CircleId,
  ownerId: UserId,
  name: ShortText,
  memberIds: z.array(UserId).max(500),
  createdAt: Instant,
});
export type Circle = z.infer<typeof Circle>;
