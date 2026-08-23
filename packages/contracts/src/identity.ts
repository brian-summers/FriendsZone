import { z } from 'zod';
import { Handle, Instant, ShortText, TimeZone, UserId } from './primitives.js';

/**
 * How findable you are in people search.
 *
 * Three values, and the missing fourth is the point. There is deliberately no
 * `FRIENDS_OF_FRIENDS`: answering it requires walking the graph one hop out
 * from the searcher, and the threat model relies on that traversal being
 * impossible. A setting that reads as a privacy *restriction* would have
 * quietly built the graph-walking endpoint the rest of the design refuses.
 *
 * `EXACT_HANDLE` is the interesting one. It keeps you out of substring and
 * display-name results while leaving you reachable by someone who already
 * knows your handle - which is how you are found by a person you actually
 * gave it to, rather than by someone scrolling a directory.
 */
export const Discoverability = z.enum([
  /** Anyone signed in can find you by handle or display name. */
  'EVERYONE',
  /** Only an exact, complete handle match finds you. */
  'EXACT_HANDLE',
  /** Search never returns you at all. */
  'NOBODY',
]);
export type Discoverability = z.infer<typeof Discoverability>;

/**
 * The default for a new account.
 *
 * `EVERYONE`, because a social product whose users cannot find each other is
 * broken, and because `PublicProfile` is deliberately minimal enough that
 * being found costs you a handle and a display name. Someone who wants less
 * has two strictly tighter options and a settings screen that explains them.
 */
export const DEFAULT_DISCOVERABILITY: Discoverability = 'EVERYONE';

/**
 * The account record.
 *
 * Note what is absent: no password hash, no email, no phone. Those live in a
 * separate credential store that the application layer cannot read casually
 * (see docs/security/data-classification.md). `User` is the shape that is safe
 * to load into ordinary business logic.
 */
export const User = z.object({
  id: UserId,
  handle: Handle,
  displayName: ShortText,
  /** Used to render times and to interpret quiet hours. Never an authz input. */
  timeZone: TimeZone,
  avatarUrl: z.string().url().max(2048).optional(),
  /**
   * Private configuration, never projected. `PublicProfile` picks its fields
   * explicitly, so this cannot leak by being added here.
   */
  discoverability: Discoverability.default(DEFAULT_DISCOVERABILITY),
  createdAt: Instant,
});
export type User = z.infer<typeof User>;

/**
 * What a viewer is allowed to learn about a user they are not friends with.
 * Deliberately minimal so that handle enumeration yields nothing of value.
 */
export const PublicProfile = User.pick({
  id: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
});
export type PublicProfile = z.infer<typeof PublicProfile>;

/**
 * Your own profile, as returned by `/v1/me` and nowhere else.
 *
 * `isModerator` lives here rather than on `PublicProfile` deliberately: the
 * latter is what other people receive, and "who are the moderators" is not a
 * question this API answers. Telling *you* that you are one reveals nothing you
 * could not learn by opening the queue.
 */
export const MeView = PublicProfile.extend({
  isModerator: z.boolean(),
  /** Your own setting. Nobody else is ever told how findable you are. */
  discoverability: Discoverability,
});
export type MeView = z.infer<typeof MeView>;

export const UpdateDiscoverabilityInput = z.object({
  discoverability: Discoverability,
});
export type UpdateDiscoverabilityInput = z.infer<typeof UpdateDiscoverabilityInput>;
