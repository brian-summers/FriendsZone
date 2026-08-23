import {
  atLeast,
  maxVisibility,
  minVisibility,
  type Audience,
  type CalendarEvent,
  type SharingDefaults,
  type ShareRule,
  type VisibilityLevel,
} from '@friendszone/contracts';
import { assertNever, isSelf, type ViewerContext } from './viewer.js';

/**
 * Does this audience include this viewer?
 *
 * Every branch must return `true` only on an affirmative match. There is no
 * fallback that grants access, which is what makes the default deny real rather
 * than aspirational.
 */
export function audienceMatches(audience: Audience, viewer: ViewerContext): boolean {
  switch (audience.kind) {
    case 'SELF':
      // Owner access is decided before rules are consulted, so a SELF rule can
      // only ever match someone who is not the owner - i.e. nobody.
      return false;

    case 'FRIENDS':
      return viewer.relationship === 'FRIEND';

    case 'CIRCLE':
      // Membership alone is not enough. A circle can outlive the friendship
      // that justified it (unfriend does not scrub circle rosters), so the
      // friendship is re-checked here rather than trusted from the roster.
      return (
        viewer.relationship === 'FRIEND' && viewer.sharedCircleIds.includes(audience.circleId)
      );

    case 'PUBLIC':
      return true;

    default:
      return assertNever(audience, 'audienceMatches');
  }
}

/** Highest level any matching rule grants. HIDDEN when nothing matches. */
function grantedLevel(rules: readonly ShareRule[], viewer: ViewerContext): VisibilityLevel {
  let granted: VisibilityLevel = 'HIDDEN';
  for (const rule of rules) {
    if (audienceMatches(rule.audience, viewer)) {
      granted = maxVisibility(granted, rule.level);
    }
  }
  return granted;
}

/**
 * Resolve how much of `event` this viewer may see.
 *
 * The normative specification of this function, including the worked examples
 * that the unit tests mirror, is docs/architecture/visibility-and-privacy.md.
 * If you change the behaviour here, change that document in the same commit.
 *
 * Order of evaluation is deliberate and must not be rearranged:
 *
 *   1. Owner - always FULL. Nothing can hide your own calendar from you.
 *   2. Block - always HIDDEN, and checked before any grant is considered, so
 *      that no sharing rule (not even PUBLIC) can be used to route around it.
 *   3. Attendee - FULL, bypassing the ceiling. Someone invited to a thing
 *      already knows where and when it is; withholding it from them would be
 *      theatre, not privacy.
 *   4. Rules - per-event if present, otherwise the owner's defaults.
 *   5. Ceiling - clamps whatever step 4 produced.
 */
export function resolveEventVisibility(
  event: Pick<
    CalendarEvent,
    'ownerId' | 'attendeeIds' | 'shareRules' | 'visibilityCeiling'
  >,
  viewer: ViewerContext,
  ownerDefaults: SharingDefaults,
): VisibilityLevel {
  if (isSelf(viewer, event.ownerId)) {
    return 'FULL';
  }

  if (viewer.relationship === 'BLOCKED') {
    return 'HIDDEN';
  }

  if (viewer.viewerId !== null && event.attendeeIds.includes(viewer.viewerId)) {
    return 'FULL';
  }

  const rules = event.shareRules.length > 0 ? event.shareRules : ownerDefaults.rules;
  return minVisibility(grantedLevel(rules, viewer), event.visibilityCeiling);
}

/**
 * The widest level any *other* person could see for this event - the answer to
 * "who can see this?" that the owner sees at a glance on their own calendar.
 *
 * This is a summary for the owner's benefit, never a grant. It is the maximum
 * over the effective rules, clamped by the ceiling - i.e. the most that the
 * most-privileged audience gets. `SELF`-only rules contribute nothing, so an
 * event shared with no one summarises as `HIDDEN` ("only you"), which is
 * exactly what we want to surface.
 *
 * It deliberately ignores attendees: an attendee seeing FULL is a property of
 * that person, not of the sharing posture, and folding it in would make a
 * private event with one guest read as "everyone can see this".
 */
export function widestSharedLevel(
  event: Pick<CalendarEvent, 'shareRules' | 'visibilityCeiling'>,
  ownerDefaults: SharingDefaults,
): VisibilityLevel {
  const rules = event.shareRules.length > 0 ? event.shareRules : ownerDefaults.rules;

  let widest: VisibilityLevel = 'HIDDEN';
  for (const rule of rules) {
    // SELF never widens: it grants only the owner, who is not "someone else".
    if (rule.audience.kind === 'SELF') continue;
    widest = maxVisibility(widest, rule.level);
  }

  return minVisibility(widest, event.visibilityCeiling);
}

/**
 * Does this owner's baseline sharing reach this viewer at all?
 *
 * The honest denominator behind "4 of 6 friends share availability with you"
 * (ADR 0008). Exported as its own named concept rather than by making
 * `grantedLevel` public: callers should be asking this question, not helping
 * themselves to the rule evaluator and drawing their own conclusions.
 *
 * Deliberately reads *defaults* only. Per-event rules can widen access for a
 * particular event, but "do they share availability with me" is a property of
 * how someone has configured their calendar, not of what happens to be on it
 * this week - and answering from events would make the reply wobble as their
 * week changed.
 */
export function sharesAvailabilityWith(
  ownerDefaults: SharingDefaults,
  viewer: ViewerContext,
): boolean {
  return atLeast(grantedLevel(ownerDefaults.rules, viewer), 'BUSY');
}
