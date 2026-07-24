import { describe, expect, it } from 'vitest';
import { CONSERVATIVE_SHARING_DEFAULTS, type VisibilityLevel } from '@friendszone/contracts';
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
      resolveEventVisibility(own, { viewerId: ALICE, relationship: 'NONE', sharedCircleIds: [] }, defaults()),
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
