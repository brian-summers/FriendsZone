import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_SHARING_DEFAULTS,
  presetOf,
  SHARING_PRESETS,
  SharingPresetName,
  type VisibilityLevel,
} from '@friendszone/contracts';
import { resolveEventVisibility, widestSharedLevel } from './visibility.js';
import {
  ALICE,
  asAnonymous,
  asBlocked,
  asFriend,
  asOwner,
  asStranger,
  BOB,
  CLIMBING_CREW,
  defaults,
  event,
  rule,
  WORK_CIRCLE,
} from './testing.js';

/**
 * These cases are the executable form of the table in
 * docs/architecture/visibility-and-privacy.md. If you change one, change both.
 */
describe('resolveEventVisibility', () => {
  it('always shows the owner their own event in full', () => {
    const own = event({ visibilityCeiling: 'HIDDEN', shareRules: [] });
    expect(resolveEventVisibility(own, asOwner(), defaults())).toBe<VisibilityLevel>('FULL');
  });

  it('hides everything from a blocked viewer, even a PUBLIC event', () => {
    const publicEvent = event({
      shareRules: [rule({ kind: 'PUBLIC' }, 'FULL')],
      visibilityCeiling: 'FULL',
    });
    expect(resolveEventVisibility(publicEvent, asBlocked(), defaults())).toBe('HIDDEN');
  });

  it('hides everything from a blocked viewer who is also an attendee', () => {
    // A block must outrank participation. Otherwise blocking someone you once
    // invited leaves them a permanent window into that event.
    const shared = event({ attendeeIds: [BOB] });
    expect(resolveEventVisibility(shared, asBlocked(), defaults())).toBe('HIDDEN');
  });

  it('denies by default when no rule matches', () => {
    const bare = event({ shareRules: [] });
    expect(resolveEventVisibility(bare, asStranger(), defaults())).toBe('HIDDEN');
    expect(resolveEventVisibility(bare, asFriend(), defaults())).toBe('HIDDEN');
  });

  it('falls back to the owner defaults only when the event has no rules', () => {
    const inherits = event({ shareRules: [] });
    expect(
      resolveEventVisibility(inherits, asFriend(), CONSERVATIVE_SHARING_DEFAULTS),
    ).toBe('BUSY');

    const overrides = event({ shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] });
    expect(
      resolveEventVisibility(overrides, asFriend(), CONSERVATIVE_SHARING_DEFAULTS),
    ).toBe('TITLE');
  });

  it('takes the most permissive matching rule', () => {
    const multi = event({
      shareRules: [
        rule({ kind: 'FRIENDS' }, 'BUSY'),
        rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL'),
      ],
    });
    expect(resolveEventVisibility(multi, asFriend([CLIMBING_CREW]), defaults())).toBe('FULL');
    expect(resolveEventVisibility(multi, asFriend([WORK_CIRCLE]), defaults())).toBe('BUSY');
  });

  it('clamps the result to the event ceiling', () => {
    const capped = event({
      shareRules: [rule({ kind: 'FRIENDS' }, 'FULL')],
      visibilityCeiling: 'BUSY',
    });
    expect(resolveEventVisibility(capped, asFriend(), defaults())).toBe('BUSY');
  });

  it('lets an attendee past the ceiling', () => {
    const capped = event({ visibilityCeiling: 'HIDDEN', attendeeIds: [BOB] });
    expect(resolveEventVisibility(capped, asFriend(), defaults())).toBe('FULL');
  });

  it('does not treat a pending friend request as friendship', () => {
    const friendsOnly = event({ shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] });
    const pending = asFriend();
    expect(
      resolveEventVisibility(friendsOnly, { ...pending, relationship: 'PENDING' }, defaults()),
    ).toBe('HIDDEN');
  });

  it('ignores circle membership once the friendship is gone', () => {
    // Circle rosters are not scrubbed on unfriend, so the friendship check has
    // to happen at read time. This is the regression test for that.
    const circleOnly = event({
      shareRules: [rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL')],
    });
    const exFriendStillInRoster = {
      viewerId: BOB,
      relationship: 'NONE' as const,
      sharedCircleIds: [CLIMBING_CREW],
      isModerator: false,
    };
    expect(resolveEventVisibility(circleOnly, exFriendStillInRoster, defaults())).toBe('HIDDEN');
  });

  it('grants PUBLIC rules to anonymous callers and nothing else', () => {
    const open = event({ shareRules: [rule({ kind: 'PUBLIC' }, 'TITLE')] });
    const closed = event({ shareRules: [rule({ kind: 'FRIENDS' }, 'FULL')] });
    expect(resolveEventVisibility(open, asAnonymous(), defaults())).toBe('TITLE');
    expect(resolveEventVisibility(closed, asAnonymous(), defaults())).toBe('HIDDEN');
  });

  it('never lets a SELF rule grant access to a non-owner', () => {
    const selfRule = event({ shareRules: [rule({ kind: 'SELF' }, 'FULL')] });
    expect(resolveEventVisibility(selfRule, asFriend(), defaults())).toBe('HIDDEN');
    expect(resolveEventVisibility(selfRule, asStranger(), defaults())).toBe('HIDDEN');
  });

  it('treats a viewer whose id matches the owner as the owner', () => {
    const own = event({ ownerId: ALICE });
    expect(
      resolveEventVisibility(own, { viewerId: ALICE, relationship: 'NONE', sharedCircleIds: [], isModerator: false }, defaults()),
    ).toBe('FULL');
  });
});

describe('widestSharedLevel', () => {
  it('summarises an unshared event as HIDDEN ("only you")', () => {
    const private_ = event({ shareRules: [], visibilityCeiling: 'FULL' });
    expect(widestSharedLevel(private_, defaults())).toBe('HIDDEN');
  });

  it('reports the most-privileged audience, not the least', () => {
    const mixed = event({
      shareRules: [
        rule({ kind: 'FRIENDS' }, 'BUSY'),
        rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL'),
      ],
    });
    expect(widestSharedLevel(mixed, defaults())).toBe('FULL');
  });

  it('is clamped by the ceiling', () => {
    const capped = event({ shareRules: [rule({ kind: 'FRIENDS' }, 'FULL')], visibilityCeiling: 'BUSY' });
    expect(widestSharedLevel(capped, defaults())).toBe('BUSY');
  });

  it('falls back to the owner defaults when the event has no rules', () => {
    const inherits = event({ shareRules: [] });
    expect(widestSharedLevel(inherits, CONSERVATIVE_SHARING_DEFAULTS)).toBe('BUSY');
  });

  it('does not count a SELF rule or attendees as widening', () => {
    // A private event you happen to have invited someone to still summarises
    // as "only you" — attendee access is a property of the guest, not a public
    // posture the owner should be warned about.
    const withGuest = event({
      shareRules: [rule({ kind: 'SELF' }, 'FULL')],
      attendeeIds: [BOB],
      visibilityCeiling: 'FULL',
    });
    expect(widestSharedLevel(withGuest, defaults())).toBe('HIDDEN');
  });

  it('recognises a public event', () => {
    const open = event({ shareRules: [rule({ kind: 'PUBLIC' }, 'TITLE')] });
    expect(widestSharedLevel(open, defaults())).toBe('TITLE');
  });
});

describe('account sharing presets', () => {
  it('grants exactly what each preset claims, and nothing wider', () => {
    // A security-relevant constant: widening one of these silently widens every
    // user who has not configured anything (ADR 0021).
    expect(SHARING_PRESETS.PRIVATE.rules).toEqual([]);
    expect(SHARING_PRESETS.BUSY_TO_FRIENDS.rules).toEqual([
      { audience: { kind: 'FRIENDS' }, level: 'BUSY' },
    ]);
    expect(SHARING_PRESETS.OPEN_TO_FRIENDS.rules).toEqual([
      { audience: { kind: 'FRIENDS' }, level: 'TITLE' },
    ]);
  });

  it('offers no preset that shares FULL or reaches PUBLIC', () => {
    // The load-bearing refusal. FULL carries location; PUBLIC reaches strangers.
    // Both stay available per event, and neither is one tap on the screen
    // nobody reads.
    for (const name of SharingPresetName.options) {
      for (const rule of SHARING_PRESETS[name].rules) {
        expect(rule.level).not.toBe('FULL');
        expect(rule.audience.kind).not.toBe('PUBLIC');
      }
    }
  });

  it('keeps the conservative fallback identical to the Busy preset', () => {
    // Defined once. If these ever disagree, an unconfigured user and a user who
    // picked "Busy to friends" would be sharing different amounts.
    expect(CONSERVATIVE_SHARING_DEFAULTS.rules).toEqual(SHARING_PRESETS.BUSY_TO_FRIENDS.rules);
    expect(presetOf(CONSERVATIVE_SHARING_DEFAULTS)).toBe('BUSY_TO_FRIENDS');
  });

  it('recognises a preset whatever order the rules are stored in', () => {
    expect(presetOf({ rules: [] })).toBe('PRIVATE');
    expect(presetOf({ rules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }] })).toBe(
      'OPEN_TO_FRIENDS',
    );
  });

  it('says CUSTOM rather than rounding to the nearest preset', () => {
    // Someone who composed something specific is told it is specific.
    expect(
      presetOf({
        rules: [
          { audience: { kind: 'FRIENDS' }, level: 'BUSY' },
          { audience: { kind: 'PUBLIC' }, level: 'TITLE' },
        ],
      }),
    ).toBe('CUSTOM');
    expect(presetOf({ rules: [{ audience: { kind: 'FRIENDS' }, level: 'FULL' }] })).toBe('CUSTOM');
  });
});
