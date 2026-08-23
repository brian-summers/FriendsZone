import { z } from 'zod';
import { CircleId, Handle, Instant, ShortText, UserId } from './primitives.js';

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

// ── Managing circles ──────────────────────────────────────────────────
//
// Circles are owner-only, and their *names* most of all. There is deliberately
// no endpoint answering "which circles am I in", for anyone. See
// docs/adr/0023-circle-management.md.

export const MAX_CIRCLES_PER_USER = 50;

export const CreateCircleInput = z.object({
  name: ShortText,
  /** Friends only. A roster of people who can never match lies to its owner. */
  memberIds: z.array(UserId).max(500).default([]),
});
export type CreateCircleInput = z.infer<typeof CreateCircleInput>;

export const UpdateCircleInput = z.object({
  name: ShortText.optional(),
  memberIds: z.array(UserId).max(500).optional(),
});
export type UpdateCircleInput = z.infer<typeof UpdateCircleInput>;

/**
 * One member of a circle, as its owner sees them.
 *
 * `stillAFriend: false` marks someone the owner has since unfriended.
 * Unfriending deliberately does not scrub rosters - `audienceMatches` re-checks
 * friendship at read time, so a stale entry grants nothing - but the owner is
 * shown the truth rather than a quietly edited list.
 */
export const CircleMemberView = z.object({
  userId: UserId,
  stillAFriend: z.boolean(),
});
export type CircleMemberView = z.infer<typeof CircleMemberView>;

/** A circle as its owner sees it. Nobody else ever receives this. */
export const CircleView = z.object({
  id: CircleId,
  name: ShortText,
  members: z.array(CircleMemberView),
  createdAt: Instant,
});
export type CircleView = z.infer<typeof CircleView>;

// ── Wire types ────────────────────────────────────────────────────────

/**
 * Someone you might befriend, as search returns them.
 *
 * `PublicProfile` plus how you already stand with them, so the interface can
 * render "Add friend" / "Requested" / "Accept" without a second call. There is
 * deliberately **no `BLOCKED` case**: a blocked pair never see each other in
 * search at all, and a status of "blocked" would be the oracle that omission
 * exists to close (docs/adr/0028-friend-requests-and-blocking.md).
 */
export const SearchResultStatus = z.enum([
  'NONE',
  /** You asked them. */
  'REQUESTED',
  /** They asked you. */
  'AWAITING_YOU',
  'FRIEND',
]);
export type SearchResultStatus = z.infer<typeof SearchResultStatus>;

export const PersonSearchResult = z.object({
  id: UserId,
  handle: Handle,
  displayName: ShortText,
  avatarUrl: z.string().url().max(2048).optional(),
  status: SearchResultStatus,
});
export type PersonSearchResult = z.infer<typeof PersonSearchResult>;

/** A friend request, as one of its two parties sees it. */
export const FriendRequestView = z.object({
  /** The other person. Never a stranger - they asked you or you asked them. */
  userId: UserId,
  handle: Handle,
  displayName: ShortText,
  avatarUrl: z.string().url().max(2048).optional(),
  /** True when you sent it, so the client renders "cancel" rather than "accept". */
  sentByYou: z.boolean(),
  createdAt: Instant,
});
export type FriendRequestView = z.infer<typeof FriendRequestView>;

export const RespondToFriendRequestInput = z.object({
  decision: z.enum(['ACCEPT', 'DECLINE']),
});
export type RespondToFriendRequestInput = z.infer<typeof RespondToFriendRequestInput>;

/** Bounded, like every list in this API. */
export const MAX_SEARCH_RESULTS = 20;
export const MIN_SEARCH_LENGTH = 2;
