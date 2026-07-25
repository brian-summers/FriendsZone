import { describe, expect, it } from 'vitest';
import {
  deriveHangoutHolds,
  mergeBusyBlocks,
  projectCalendar,
  projectEvent,
} from './projection.js';
import {
  ALICE,
  asBlocked,
  asFriend,
  asOwner,
  asStranger,
  BOB,
  CAROL,
  CLIMBING_CREW,
  DAVE,
  DAY,
  defaults,
  event,
  hangout,
  hours,
  rule,
  viewer,
} from './testing.js';

describe('projectEvent', () => {
  it('emits nothing at HIDDEN', () => {
    expect(projectEvent(event(), 'HIDDEN')).toEqual({ kind: 'HIDDEN' });
  });

  it('emits only a time range at BUSY', () => {
    const projection = projectEvent(event({ title: 'Therapy' }), 'BUSY');
    expect(projection.kind).toBe('BUSY');
    // Asserting on the serialized form, because that is what actually ships.
    expect(JSON.stringify(projection)).not.toContain('Therapy');
    expect(JSON.stringify(projection)).not.toContain('Elm St');
  });

  /**
   * A whitelist test. It fails if anyone adds a field to a projection without
   * consciously updating the expected key set, which is the point: field
   * additions to `CalendarEvent` must never reach a viewer implicitly.
   */
  it('emits exactly the whitelisted fields at TITLE', () => {
    const projection = projectEvent(event(), 'TITLE');
    if (projection.kind !== 'DETAIL') throw new Error('expected a detail projection');
    expect(Object.keys(projection.view).sort()).toEqual(
      ['id', 'openToConflict', 'ownerId', 'status', 'timeRange', 'title', 'visibility'].sort(),
    );
  });

  it('withholds description, location, and attendees at TITLE', () => {
    const projection = projectEvent(
      event({ description: 'secret', location: 'secret place', attendeeIds: [BOB] }),
      'TITLE',
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain(BOB);
  });

  it('emits the full record at FULL', () => {
    const projection = projectEvent(event(), 'FULL');
    if (projection.kind !== 'DETAIL') throw new Error('expected a detail projection');
    expect(projection.view).toMatchObject({
      visibility: 'FULL',
      description: 'Back left molar',
      location: '400 Elm St',
    });
  });

  it('omits absent optional fields rather than emitting null', () => {
    const sparse = event({ description: undefined, location: undefined });
    const projection = projectEvent(sparse, 'FULL');
    if (projection.kind !== 'DETAIL') throw new Error('expected a detail projection');
    expect('description' in projection.view).toBe(false);
    expect('location' in projection.view).toBe(false);
  });
});

describe('mergeBusyBlocks', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeBusyBlocks([hours(9, 10), hours(10, 11)])).toEqual([
      { start: hours(9, 11).start, end: hours(9, 11).end },
    ]);
    expect(mergeBusyBlocks([hours(9, 12), hours(10, 11)])).toEqual([
      { start: hours(9, 12).start, end: hours(9, 12).end },
    ]);
  });

  it('keeps genuinely separate intervals apart', () => {
    expect(mergeBusyBlocks([hours(9, 10), hours(14, 15)])).toHaveLength(2);
  });

  it('is order independent', () => {
    const forward = mergeBusyBlocks([hours(9, 10), hours(10, 11), hours(14, 15)]);
    const reverse = mergeBusyBlocks([hours(14, 15), hours(10, 11), hours(9, 10)]);
    expect(reverse).toEqual(forward);
  });

  it('returns an empty set for no input', () => {
    expect(mergeBusyBlocks([])).toEqual([]);
  });
});

describe('projectCalendar', () => {
  const call = (args: Parameters<typeof projectCalendar>[0]) => projectCalendar(args);

  it('returns an empty calendar to a stranger instead of failing', () => {
    // Indistinguishable from "this user has nothing scheduled", which is the
    // whole point: a stranger must not be able to tell the difference between
    // a private calendar, an empty one, and a nonexistent account.
    const view = call({
      ownerId: ALICE,
      events: [event(), event({ timeRange: hours(14, 15) })],
      viewer: asStranger(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(view.busy).toEqual([]);
    expect(view.details).toEqual([]);
  });

  it('gives a blocked viewer the same empty answer as a stranger', () => {
    const events = [event({ shareRules: [rule({ kind: 'PUBLIC' }, 'FULL')] })];
    const blocked = call({
      ownerId: ALICE,
      events,
      viewer: asBlocked(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(blocked).toEqual(
      call({
        ownerId: ALICE,
        events: [],
        viewer: asStranger(),
        ownerDefaults: defaults(),
        window: DAY,
      }),
    );
  });

  it('reports detailed events as busy as well as in details', () => {
    const view = call({
      ownerId: ALICE,
      events: [event({ shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] })],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(view.details).toHaveLength(1);
    expect(view.busy).toHaveLength(1);
  });

  it('merges busy across events at different visibility levels', () => {
    const view = call({
      ownerId: ALICE,
      events: [
        event({ timeRange: hours(9, 10), shareRules: [rule({ kind: 'FRIENDS' }, 'BUSY')] }),
        event({ timeRange: hours(10, 11), shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] }),
      ],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(view.busy).toHaveLength(1);
    expect(view.details).toHaveLength(1);
  });

  it('clips busy blocks to the requested window', () => {
    const view = call({
      ownerId: ALICE,
      events: [event({ timeRange: hours(8, 20), shareRules: [rule({ kind: 'FRIENDS' }, 'BUSY')] })],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: hours(9, 10),
    });
    expect(view.busy).toEqual([{ start: hours(9, 10).start, end: hours(9, 10).end }]);
  });

  it('excludes events outside the window entirely', () => {
    const view = call({
      ownerId: ALICE,
      events: [event({ timeRange: hours(14, 15), shareRules: [rule({ kind: 'FRIENDS' }, 'BUSY')] })],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: hours(9, 10),
    });
    expect(view.busy).toEqual([]);
  });

  it('treats back-to-back events as non-overlapping with the window', () => {
    // Half-open intervals: an event ending exactly at the window start is out.
    const view = call({
      ownerId: ALICE,
      events: [event({ timeRange: hours(8, 9), shareRules: [rule({ kind: 'FRIENDS' }, 'BUSY')] })],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: hours(9, 10),
    });
    expect(view.busy).toEqual([]);
  });

  it('hides cancelled events from others but keeps them for the owner', () => {
    const cancelled = event({
      status: 'CANCELLED',
      shareRules: [rule({ kind: 'FRIENDS' }, 'FULL')],
    });
    const friendView = call({
      ownerId: ALICE,
      events: [cancelled],
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(friendView.details).toEqual([]);
    expect(friendView.busy).toEqual([]);

    const ownerView = call({
      ownerId: ALICE,
      events: [cancelled],
      viewer: asOwner(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(ownerView.details).toHaveLength(1);
  });

  it('never reports how much was withheld', () => {
    const view = call({
      ownerId: ALICE,
      events: [event(), event({ timeRange: hours(14, 15) })],
      viewer: asStranger(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(Object.keys(view).sort()).toEqual([
      'busy',
      'details',
      'holds',
      'openBlocks',
      'ownerId',
      'window',
    ]);
    // Still no count of what was withheld; these are fixed, non-secret fields.
    expect(view.holds).toEqual([]);
    expect(view.openBlocks).toEqual([]);
  });

  it('refuses to project events belonging to another owner', () => {
    expect(() =>
      call({
        ownerId: ALICE,
        events: [event({ ownerId: BOB })],
        viewer: asFriend(),
        ownerDefaults: defaults(),
        window: DAY,
      }),
    ).toThrow(/another owner/);
  });

  it('applies circle rules per viewer', () => {
    const events = [
      event({ shareRules: [rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL')] }),
    ];
    const inCircle = call({
      ownerId: ALICE,
      events,
      viewer: asFriend([CLIMBING_CREW]),
      ownerDefaults: defaults(),
      window: DAY,
    });
    const outOfCircle = call({
      ownerId: ALICE,
      events,
      viewer: asFriend(),
      ownerDefaults: defaults(),
      window: DAY,
    });
    expect(inCircle.details).toHaveLength(1);
    expect(outOfCircle.details).toEqual([]);
    expect(outOfCircle.busy).toEqual([]);
  });

  describe('open to conflict', () => {
    it('routes an open-to-conflict event to openBlocks, not busy', () => {
      const view = call({
        ownerId: ALICE,
        events: [
          event({ timeRange: hours(9, 10), openToConflict: false }),
          event({ timeRange: hours(14, 15), openToConflict: true }),
        ],
        viewer: asOwner(),
        ownerDefaults: defaults(),
        window: DAY,
      });
      expect(view.busy).toHaveLength(1);
      expect(view.openBlocks).toHaveLength(1);
      expect(view.openBlocks[0]).toMatchObject({ start: hours(14, 15).start });
    });

    it('carries the flag onto the detail view', () => {
      const view = call({
        ownerId: ALICE,
        events: [event({ openToConflict: true, shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] })],
        viewer: asFriend(),
        ownerDefaults: defaults(),
        window: DAY,
      });
      expect(view.details[0]).toMatchObject({ openToConflict: true });
      // And it stays out of hard busy for the friend too.
      expect(view.busy).toEqual([]);
      expect(view.openBlocks).toHaveLength(1);
    });
  });

  describe('sharedAs annotation', () => {
    it('tells the owner the widest level anyone else can see', () => {
      const view = call({
        ownerId: ALICE,
        events: [
          event({ shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')] }),
          event({ timeRange: hours(14, 15), shareRules: [], visibilityCeiling: 'HIDDEN' }),
        ],
        viewer: asOwner(),
        ownerDefaults: defaults(),
        window: DAY,
      });

      const byTitle = new Map(
        view.details.map((d) => [d.visibility === 'FULL' ? d.sharedAs : undefined, d]),
      );
      // One event is shared to friends as TITLE; the capped one is HIDDEN.
      const levels = view.details
        .map((d) => (d.visibility === 'FULL' ? d.sharedAs : undefined))
        .sort();
      expect(levels).toEqual(['HIDDEN', 'TITLE']);
      expect(byTitle.size).toBe(2);
    });

    it('never annotates a non-owner FULL view, even an attendee', () => {
      // A friend or attendee reaching FULL must not learn the owner's posture.
      const shared = event({
        attendeeIds: [BOB],
        shareRules: [rule({ kind: 'FRIENDS' }, 'FULL')],
      });

      for (const viewer of [asFriend(), { viewerId: BOB, relationship: 'FRIEND' as const, sharedCircleIds: [] }]) {
        const view = call({
          ownerId: ALICE,
          events: [shared],
          viewer,
          ownerDefaults: defaults(),
          window: DAY,
        });
        expect(view.details).toHaveLength(1);
        const only = view.details[0];
        expect(only?.visibility).toBe('FULL');
        // None of the owner-only fields leak to a non-owner.
        for (const field of ['sharedAs', 'shareRules', 'ownVisibilityCeiling']) {
          expect(only && field in only).toBe(false);
        }
      }
    });

    it('gives the owner the event’s own rules to edit', () => {
      const own = event({
        shareRules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
        visibilityCeiling: 'FULL',
      });
      const view = call({
        ownerId: ALICE,
        events: [own],
        viewer: asOwner(),
        ownerDefaults: defaults(),
        window: DAY,
      });
      const d = view.details[0];
      expect(d?.visibility === 'FULL' ? d.shareRules : undefined).toEqual([
        { audience: { kind: 'FRIENDS' }, level: 'TITLE' },
      ]);
      expect(d?.visibility === 'FULL' ? d.ownVisibilityCeiling : undefined).toBe('FULL');
    });
  });
});

describe('deriveHangoutHolds', () => {
  const bobToAlice = () => hangout({ proposerId: BOB, inviteeIds: [ALICE] });

  it('shows an invitee their own hold with an INVITEE role', () => {
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: asOwner(), // Alice viewing her own calendar
      requests: [bobToAlice()],
      window: DAY,
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ role: 'INVITEE', title: 'Climb?', slotIndex: 0 });
  });

  it('shows the proposer their hold with a PROPOSER role', () => {
    const holds = deriveHangoutHolds({
      ownerId: BOB,
      viewer: viewer({ viewerId: BOB, relationship: 'SELF' }),
      requests: [bobToAlice()],
      window: DAY,
    });
    expect(holds[0]?.role).toBe('PROPOSER');
  });

  it('emits one hold per proposed slot in the window', () => {
    const multi = hangout({ proposedSlots: [hours(9, 10), hours(14, 15), hours(19, 21)] });
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: asOwner(),
      requests: [multi],
      window: DAY,
    });
    expect(holds.map((h) => h.slotIndex)).toEqual([0, 1, 2]);
  });

  it('clips to the window', () => {
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: asOwner(),
      requests: [hangout({ proposedSlots: [hours(9, 10)] })],
      window: hours(14, 18),
    });
    expect(holds).toEqual([]);
  });

  it('never shows a hold for a request the viewer is not part of', () => {
    // Carol views Alice's calendar. There's a pending Bob→Alice request. Carol
    // is not a party to it, so she must not see the tentative hold — even
    // though she can see Alice's calendar.
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: viewer({ viewerId: CAROL, relationship: 'FRIEND' }),
      requests: [bobToAlice()],
      window: DAY,
    });
    expect(holds).toEqual([]);
  });

  it('shows a proposer their hold on the invitee’s calendar', () => {
    // Alice (proposer) views Dave's calendar; her pending request to Dave shows
    // as a hold there, because she is a party and already knows the times.
    const aliceToDave = hangout({ proposerId: ALICE, inviteeIds: [DAVE] });
    const holds = deriveHangoutHolds({
      ownerId: DAVE,
      viewer: asOwner(), // viewerId = ALICE
      requests: [aliceToDave],
      window: DAY,
    });
    expect(holds[0]).toMatchObject({ role: 'PROPOSER', inviteeId: DAVE });
  });

  it('ignores non-pending requests', () => {
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: asOwner(),
      requests: [hangout({ status: 'ACCEPTED' }), hangout({ status: 'DECLINED' })],
      window: DAY,
    });
    expect(holds).toEqual([]);
  });

  it('emits nothing to an anonymous viewer', () => {
    const holds = deriveHangoutHolds({
      ownerId: ALICE,
      viewer: viewer({ viewerId: null }),
      requests: [bobToAlice()],
      window: DAY,
    });
    expect(holds).toEqual([]);
  });
});
