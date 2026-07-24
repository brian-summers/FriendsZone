import { z } from 'zod';
import { CircleId } from './primitives.js';

/**
 * How much of an event a given viewer may learn.
 *
 * This is a totally ordered lattice, and the ordering is load-bearing: the
 * engine takes the *maximum* of everything a viewer is granted, then clamps it
 * with the *minimum* against the event's own ceiling. Adding a level in the
 * middle later means revisiting `VISIBILITY_RANK` and every projection.
 *
 * Normative spec: docs/architecture/visibility-and-privacy.md
 */
export const VisibilityLevel = z.enum([
  /** The event does not exist as far as this viewer is concerned. */
  'HIDDEN',
  /** An opaque "unavailable" block. No title, no location, no attendees. */
  'BUSY',
  /** Busy, plus the title and confirmed/tentative status. */
  'TITLE',
  /** Everything, including description, location, and attendee list. */
  'FULL',
]);
export type VisibilityLevel = z.infer<typeof VisibilityLevel>;

export const VISIBILITY_RANK: Readonly<Record<VisibilityLevel, number>> = Object.freeze({
  HIDDEN: 0,
  BUSY: 1,
  TITLE: 2,
  FULL: 3,
});

export const maxVisibility = (a: VisibilityLevel, b: VisibilityLevel): VisibilityLevel =>
  VISIBILITY_RANK[a] >= VISIBILITY_RANK[b] ? a : b;

export const minVisibility = (a: VisibilityLevel, b: VisibilityLevel): VisibilityLevel =>
  VISIBILITY_RANK[a] <= VISIBILITY_RANK[b] ? a : b;

export const atLeast = (level: VisibilityLevel, floor: VisibilityLevel): boolean =>
  VISIBILITY_RANK[level] >= VISIBILITY_RANK[floor];

/**
 * Who a sharing rule applies to.
 *
 * There is no "everyone except X" audience by design. Negative audiences are
 * where privacy models go to die: they are hard to reason about, and a bug in
 * the exclusion list fails *open*. Every audience here fails closed — if the
 * viewer does not affirmatively match, they get nothing.
 */
export const Audience = z.discriminatedUnion('kind', [
  /** Only the owner. Useful for an explicit "this stays private" rule. */
  z.object({ kind: z.literal('SELF') }),
  /** Members of one of the owner's circles who are also accepted friends. */
  z.object({ kind: z.literal('CIRCLE'), circleId: CircleId }),
  /** All accepted friends. */
  z.object({ kind: z.literal('FRIENDS') }),
  /**
   * Anyone, including unauthenticated callers. Reserved for genuinely public
   * events. The UI must treat selecting this as a deliberate, confirmed act.
   */
  z.object({ kind: z.literal('PUBLIC') }),
]);
export type Audience = z.infer<typeof Audience>;

/** "This audience may see this much." */
export const ShareRule = z.object({
  audience: Audience,
  level: VisibilityLevel,
});
export type ShareRule = z.infer<typeof ShareRule>;

/**
 * A user's baseline sharing policy, applied to events that carry no rules of
 * their own. Defaults are the most important security control in the product,
 * because almost nobody changes them.
 */
export const SharingDefaults = z.object({
  rules: z.array(ShareRule).max(50),
});
export type SharingDefaults = z.infer<typeof SharingDefaults>;

/** Friends see that you are busy, and nothing else. Strangers see nothing. */
export const CONSERVATIVE_SHARING_DEFAULTS: SharingDefaults = Object.freeze({
  rules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
});
