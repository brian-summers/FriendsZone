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

// ── Account-level presets ─────────────────────────────────────────────
//
// Almost nobody changes defaults, so the default *is* the privacy control.
// These are the short list of choices a person can hold in their head; the
// lattice underneath stays available per event and through custom rules.
// See docs/adr/0021-sharing-presets.md.

export const SharingPresetName = z.enum(['PRIVATE', 'BUSY_TO_FRIENDS', 'OPEN_TO_FRIENDS']);
export type SharingPresetName = z.infer<typeof SharingPresetName>;

/** What the stored rules resolve to, including "none of the above". */
export const SharingPresetOrCustom = z.enum([...SharingPresetName.options, 'CUSTOM']);
export type SharingPresetOrCustom = z.infer<typeof SharingPresetOrCustom>;

/**
 * The presets, ordered most private first so scanning down reads as
 * "revealing progressively more".
 *
 * **There is deliberately no `FULL` preset and no `PUBLIC` preset.** `FULL`
 * shares description, location, and guests; as a choice about one event that is
 * fine, and the per-event editor offers it. As an account default it is a
 * standing grant over every event you will ever create — the stalking abuse case
 * written as a settings row. Widening past `TITLE` stays possible and costs a
 * deliberate act (ADR 0021).
 */
export const SHARING_PRESETS: Readonly<
  Record<SharingPresetName, { rules: ShareRule[]; consequence: string }>
> = Object.freeze({
  PRIVATE: {
    rules: [],
    consequence: 'Nobody sees anything on your calendar.',
  },
  BUSY_TO_FRIENDS: {
    rules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
    consequence: 'Friends see that you’re busy — no name, place, or guests.',
  },
  OPEN_TO_FRIENDS: {
    rules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }],
    consequence: 'Friends see what it’s called, but not where or with whom.',
  },
});

/**
 * Friends see that you are busy, and nothing else. Strangers see nothing.
 *
 * The same value as the `BUSY_TO_FRIENDS` preset, defined once: the fallback
 * for a user who has never chosen and the preset they would pick must never
 * drift into disagreeing.
 */
export const CONSERVATIVE_SHARING_DEFAULTS: SharingDefaults = Object.freeze({
  rules: SHARING_PRESETS.BUSY_TO_FRIENDS.rules,
});

/**
 * Which preset these rules are, or `CUSTOM`.
 *
 * Order-insensitive, so a stored rule set that happens to be serialised
 * differently is still recognised. Returns `CUSTOM` rather than rounding to the
 * nearest preset — someone who composed something specific should be told their
 * configuration is specific, not shown a preset they did not choose.
 */
export function presetOf(defaults: SharingDefaults): SharingPresetOrCustom {
  const canonical = (rules: readonly ShareRule[]): string =>
    rules
      .map((r) => `${r.audience.kind}:${'circleId' in r.audience ? r.audience.circleId : ''}:${r.level}`)
      .sort()
      .join('|');

  const mine = canonical(defaults.rules);
  for (const name of SharingPresetName.options) {
    if (canonical(SHARING_PRESETS[name].rules) === mine) return name;
  }
  return 'CUSTOM';
}

/**
 * Your sharing defaults, as the settings screen reads them.
 *
 * `chosen: false` means no explicit choice has ever been saved — the user is
 * running on the conservative fallback. The flag makes that state legible; it
 * does not make it less safe, and the fallback stays `BUSY_TO_FRIENDS` because
 * an absent row is not consent to share more.
 */
export const SharingDefaultsView = z.object({
  rules: z.array(ShareRule).max(50),
  preset: SharingPresetOrCustom,
  chosen: z.boolean(),
});
export type SharingDefaultsView = z.infer<typeof SharingDefaultsView>;
