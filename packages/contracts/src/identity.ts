import { z } from 'zod';
import { Handle, Instant, ShortText, TimeZone, UserId } from './primitives.js';

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
});
export type MeView = z.infer<typeof MeView>;
