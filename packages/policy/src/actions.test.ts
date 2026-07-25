import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS, can, type Action, type PolicyRequest } from './actions.js';
import { assertAllowed, PolicyDeniedError } from './decision.js';
import {
  ALICE,
  asAnonymous,
  asBlocked,
  asFriend,
  asOwner,
  asStranger,
  BOB,
  CAROL,
  CLIMBING_CREW,
} from './testing.js';

/** Records which actions the suite below actually exercises. */
const exercised = new Set<Action>();

const decide = (viewer: Parameters<typeof can>[0], request: PolicyRequest) => {
  exercised.add(request.action);
  return can(viewer, request);
};

describe('can', () => {
  describe('blocking', () => {
    it('overrides friendship and audience grants', () => {
      expect(decide(asBlocked(), { action: 'hangout:send', recipientId: ALICE })).toEqual({
        allowed: false,
        action: 'hangout:send',
        reason: 'BLOCKED',
      });
      expect(
        decide(asBlocked(), {
          action: 'listing:view',
          listing: { ownerId: ALICE, audience: { kind: 'PUBLIC' } },
        }),
      ).toMatchObject({ allowed: false, reason: 'BLOCKED' });
    });

    it('still lets a blocked viewer ask for a calendar, so the answer looks ordinary', () => {
      // Denying here would return 404 where a stranger gets an empty 200, and
      // that difference tells the blocked user they were blocked. The empty
      // result is guaranteed by the visibility engine, not by this decision —
      // see BLOCK_EXEMPT_ACTIONS and the projection tests it points at.
      expect(decide(asBlocked(), { action: 'calendar:view', ownerId: ALICE }).allowed).toBe(true);
    });

    it('exempts calendar:view and nothing else', () => {
      const stillDenied = ALL_ACTIONS.filter((action) => action !== 'calendar:view');
      expect(stillDenied.length).toBeGreaterThan(0);
    });
  });

  describe('identity', () => {
    it('lets you read your own profile and a friend’s, but not a stranger’s', () => {
      expect(decide(asOwner(), { action: 'profile:read', subjectId: ALICE }).allowed).toBe(true);
      expect(decide(asFriend(), { action: 'profile:read', subjectId: ALICE }).allowed).toBe(true);
      expect(decide(asStranger(), { action: 'profile:read', subjectId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'NOT_FRIENDS',
      });
      expect(decide(asAnonymous(), { action: 'profile:read', subjectId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });

    it('keeps a friend list private even from friends', () => {
      // One hop of graph traversal is one hop too many — see the threat model.
      expect(decide(asOwner(), { action: 'friends:list', ownerId: ALICE }).allowed).toBe(true);
      expect(decide(asFriend(), { action: 'friends:list', ownerId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'NOT_OWNER',
      });
    });

    it('lets any authenticated user read their notifications, but not anon', () => {
      expect(decide(asOwner(), { action: 'notifications:read' }).allowed).toBe(true);
      expect(decide(asAnonymous(), { action: 'notifications:read' })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });

    it('lets any authenticated user manage their own sharing, but not anon', () => {
      expect(decide(asOwner(), { action: 'sharing:manage' }).allowed).toBe(true);
      expect(decide(asAnonymous(), { action: 'sharing:manage' })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });
  });

  describe('calendar', () => {
    it('lets you preview only your own calendar through someone else’s eyes', () => {
      // The dangerous inverse — borrowing eyes on someone else's calendar —
      // is not expressible: the request names the owner, and it must be you.
      expect(decide(asOwner(), { action: 'calendar:preview', ownerId: ALICE }).allowed).toBe(true);
      expect(decide(asFriend(), { action: 'calendar:preview', ownerId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'NOT_OWNER',
      });
      expect(decide(asAnonymous(), { action: 'calendar:preview', ownerId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });

    it('lets anyone ask for a calendar, because the answer may be empty', () => {
      expect(decide(asStranger(), { action: 'calendar:view', ownerId: ALICE }).allowed).toBe(true);
      expect(decide(asAnonymous(), { action: 'calendar:view', ownerId: ALICE }).allowed).toBe(true);
    });

    it('confines writes to the owner', () => {
      expect(decide(asOwner(), { action: 'event:create', ownerId: ALICE }).allowed).toBe(true);
      expect(decide(asFriend(), { action: 'event:create', ownerId: ALICE }).allowed).toBe(false);
      expect(
        decide(asFriend(), { action: 'event:modify', event: { ownerId: ALICE } }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asAnonymous(), { action: 'event:create', ownerId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });
  });

  describe('hangout requests', () => {
    it('requires friendship to reach someone inbox', () => {
      expect(decide(asFriend(), { action: 'hangout:send', recipientId: ALICE }).allowed).toBe(true);
      expect(
        decide(asStranger(), { action: 'hangout:send', recipientId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'NOT_FRIENDS' });
      expect(
        decide(asAnonymous(), { action: 'hangout:send', recipientId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it('refuses a request addressed to yourself', () => {
      expect(
        decide(asOwner(), { action: 'hangout:send', recipientId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('lets either party read a hangout, but no one else', () => {
      const req = { proposerId: BOB, inviteeIds: [CAROL] };
      expect(decide(asFriend(), { action: 'hangout:read', request: req }).allowed).toBe(true); // BOB
      expect(
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [] }, { action: 'hangout:read', request: req }).allowed,
      ).toBe(true);
      expect(
        decide({ viewerId: ALICE, relationship: 'FRIEND', sharedCircleIds: [] }, { action: 'hangout:read', request: req }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('lets only invitees respond, and only while pending', () => {
      expect(
        decide(asFriend(), {
          action: 'hangout:respond',
          request: { inviteeIds: [BOB], status: 'PENDING' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'hangout:respond',
          request: { inviteeIds: [CAROL], status: 'PENDING' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      expect(
        decide(asFriend(), {
          action: 'hangout:respond',
          request: { inviteeIds: [BOB], status: 'EXPIRED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets only the proposer withdraw a pending request', () => {
      expect(
        decide(asFriend(), {
          action: 'hangout:withdraw',
          request: { proposerId: BOB, status: 'PENDING' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'hangout:withdraw',
          request: { proposerId: CAROL, status: 'PENDING' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asFriend(), {
          action: 'hangout:withdraw',
          request: { proposerId: BOB, status: 'ACCEPTED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets the organiser update and reschedule while the hangout is live', () => {
      for (const action of ['hangout:update', 'hangout:reschedule'] as const) {
        // Proposer, still pending or confirmed → allowed.
        expect(decide(asFriend(), { action, request: { proposerId: BOB, status: 'PENDING' } }).allowed).toBe(true);
        expect(decide(asFriend(), { action, request: { proposerId: BOB, status: 'ACCEPTED' } }).allowed).toBe(true);
        // Non-proposer → denied.
        expect(
          decide(asFriend(), { action, request: { proposerId: CAROL, status: 'PENDING' } }),
        ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
        // Terminal → nothing to edit.
        expect(
          decide(asFriend(), { action, request: { proposerId: BOB, status: 'CANCELLED' } }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      }
    });

    it('lets either party cancel a confirmed hangout, but not a pending one', () => {
      const base = { action: 'hangout:cancel' as const };
      // Proposer (BOB) cancels a confirmed hangout.
      expect(
        decide(asFriend(), { ...base, request: { proposerId: BOB, inviteeIds: [CAROL], status: 'ACCEPTED' } }).allowed,
      ).toBe(true);
      // Invitee (BOB) cancels a confirmed hangout.
      expect(
        decide(asFriend(), { ...base, request: { proposerId: CAROL, inviteeIds: [BOB], status: 'ACCEPTED' } }).allowed,
      ).toBe(true);
      // A non-participant cannot.
      expect(
        decide(asFriend(), { ...base, request: { proposerId: ALICE, inviteeIds: [CAROL], status: 'ACCEPTED' } }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      // Cancel is for confirmed hangouts; a pending one is withdrawn/declined.
      expect(
        decide(asFriend(), { ...base, request: { proposerId: BOB, inviteeIds: [CAROL], status: 'PENDING' } }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets a party book a floating occurrence, but not a fixed one', () => {
      const base = { action: 'hangout:book' as const };
      expect(
        decide(asFriend(), {
          ...base,
          request: { proposerId: CAROL, inviteeIds: [BOB], status: 'PENDING', kind: 'FLOATING' },
        }).allowed,
      ).toBe(true);
      // FIXED requests are booked by accepting a slot, not this action.
      expect(
        decide(asFriend(), {
          ...base,
          request: { proposerId: CAROL, inviteeIds: [BOB], status: 'PENDING', kind: 'FIXED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      // Non-participant refused.
      expect(
        decide(asFriend(), {
          ...base,
          request: { proposerId: ALICE, inviteeIds: [CAROL], status: 'PENDING', kind: 'FLOATING' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });
  });

  describe('marketplace', () => {
    const friendsListing = {
      ownerId: ALICE,
      audience: { kind: 'FRIENDS' } as const,
      status: 'AVAILABLE' as const,
    };

    it('shows listings to the matching audience only', () => {
      expect(decide(asFriend(), { action: 'listing:view', listing: friendsListing }).allowed).toBe(
        true,
      );
      expect(
        decide(asStranger(), { action: 'listing:view', listing: friendsListing }),
      ).toMatchObject({ allowed: false, reason: 'NO_MATCHING_AUDIENCE' });
    });

    it('shows the owner their own listing regardless of audience', () => {
      expect(
        decide(asOwner(), {
          action: 'listing:view',
          listing: { ownerId: ALICE, audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW } },
        }).allowed,
      ).toBe(true);
    });

    it('requires friendship to claim even a public listing', () => {
      // Discoverability and claimability are separate gates because a claim
      // ends with two people arranging to meet.
      const publicListing = {
        ownerId: ALICE,
        audience: { kind: 'PUBLIC' } as const,
        status: 'AVAILABLE' as const,
      };
      expect(
        decide(asStranger(), { action: 'listing:view', listing: publicListing }).allowed,
      ).toBe(true);
      expect(
        decide(asStranger(), { action: 'listing:claim', listing: publicListing }),
      ).toMatchObject({ allowed: false, reason: 'NOT_FRIENDS' });
      expect(decide(asFriend(), { action: 'listing:claim', listing: publicListing }).allowed).toBe(
        true,
      );
    });

    it('refuses to let an owner claim their own listing', () => {
      expect(
        decide(asOwner(), { action: 'listing:claim', listing: friendsListing }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
    });

    it('refuses to claim a listing that is no longer available', () => {
      expect(
        decide(asFriend(), {
          action: 'listing:claim',
          listing: { ...friendsListing, status: 'EXCHANGED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets only the listing owner decide a pending claim', () => {
      expect(
        decide(asOwner(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE },
          claim: { status: 'PENDING' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE },
          claim: { status: 'PENDING' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asOwner(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE },
          claim: { status: 'ACCEPTED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets either counterparty propose an exchange time', () => {
      const base = {
        action: 'exchange:propose',
        listing: { ownerId: ALICE },
        claim: { claimantId: BOB, status: 'ACCEPTED' as const },
        exchange: null,
      } satisfies PolicyRequest;

      expect(decide(asOwner(), base).allowed).toBe(true);
      expect(decide(asFriend(), base).allowed).toBe(true);
      expect(
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [] }, base),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('refuses to reschedule a completed exchange', () => {
      expect(
        decide(asFriend(), {
          action: 'exchange:propose',
          listing: { ownerId: ALICE },
          claim: { claimantId: BOB, status: 'ACCEPTED' },
          exchange: { status: 'COMPLETED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses an exchange before the claim is accepted', () => {
      expect(
        decide(asFriend(), {
          action: 'exchange:propose',
          listing: { ownerId: ALICE },
          claim: { claimantId: BOB, status: 'PENDING' },
          exchange: null,
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });
  });

  /**
   * The backstop. A new action added to the union without tests fails here
   * rather than shipping unexercised, which is the failure mode that matters:
   * an unreviewed capability is indistinguishable from an intentional one.
   */
  it('exercises every declared action', () => {
    const missing = ALL_ACTIONS.filter((action) => !exercised.has(action));
    expect(missing).toEqual([]);
  });
});

describe('assertAllowed', () => {
  it('passes through an allow', () => {
    expect(() => assertAllowed(can(asOwner(), { action: 'event:create', ownerId: ALICE }))).not.toThrow();
  });

  it('throws a structured error carrying the reason', () => {
    try {
      assertAllowed(can(asStranger(), { action: 'hangout:send', recipientId: ALICE }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyDeniedError);
      expect((error as PolicyDeniedError).reason).toBe('NOT_FRIENDS');
    }
  });
});
