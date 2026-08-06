import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS, can, type Action, type PolicyRequest } from './actions.js';
import { assertAllowed, PolicyDeniedError } from './decision.js';
import {
  ALICE,
  asAnonymous,
  asBlocked,
  asFriend,
  asModerator,
  asOwner,
  asStranger,
  BOB,
  CAROL,
  CLIMBING_CREW,
  friendship,
  viewer,
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

    it('exempts only calendar:view and the report actions', () => {
      /**
       * The exempt set is small and every member owes the same debt: its
       * response must tell a blocked caller nothing about the person they are
       * blocked with. `calendar:view` pays it by returning an empty calendar;
       * the report actions pay it by returning only the caller's own side.
       *
       * Asserted as a list so that *adding* an exemption fails here and has to
       * be argued for, rather than arriving quietly in a feature diff.
       */
      const exempt: Action[] = ['calendar:view', 'report:create', 'report:read', 'report:reply'];
      expect(ALL_ACTIONS.filter((a) => exempt.includes(a)).sort()).toEqual([...exempt].sort());

      // A representative non-member is still refused outright.
      expect(
        decide(asBlocked(), { action: 'profile:read', subjectId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'BLOCKED' });
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

    it.each(['account:export', 'account:delete'] as const)(
      'lets any authenticated user %s their own account, but not anon',
      (action) => {
        // Both are inherently self-scoped: neither route takes a subject id, so
        // there is no "whose account" to get wrong.
        expect(decide(asOwner(), { action }).allowed).toBe(true);
        expect(decide(asStranger(), { action }).allowed).toBe(true);
        expect(decide(asAnonymous(), { action })).toMatchObject({
          allowed: false,
          reason: 'ANONYMOUS',
        });
      },
    );

    it('keeps circles to their owner, reading as much as writing', () => {
      // There is no "circles I am in" anywhere in the product, and this gate is
      // why: every circle route names an owner, and it must be the caller.
      expect(decide(asOwner(), { action: 'circle:manage', ownerId: ALICE }).allowed).toBe(true);
      expect(decide(asFriend(), { action: 'circle:manage', ownerId: ALICE })).toMatchObject({
        allowed: false,
        reason: 'NOT_OWNER',
      });
      expect(decide(asAnonymous(), { action: 'circle:manage', ownerId: ALICE })).toMatchObject({
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

    it('lets any authenticated user find slots, but not anon', () => {
      // Authentication is the whole gate, and that is not a shortcut: every
      // participant's availability is projected for this exact viewer, so a
      // stranger contributes an empty set and appears free (ADR 0008).
      expect(decide(asStranger(), { action: 'slots:find' }).allowed).toBe(true);
      expect(decide(asAnonymous(), { action: 'slots:find' })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
      // Not block-exempt: a blocked pair get no shortcut through this endpoint.
      expect(decide(asBlocked(), { action: 'slots:find' })).toMatchObject({
        allowed: false,
        reason: 'BLOCKED',
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
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [], isModerator: false }, { action: 'hangout:read', request: req }).allowed,
      ).toBe(true);
      expect(
        decide({ viewerId: ALICE, relationship: 'FRIEND', sharedCircleIds: [], isModerator: false }, { action: 'hangout:read', request: req }),
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
    const NOW = '2026-07-31T12:00:00.000Z';
    const ALREADY_PAST = '2026-07-30T12:00:00.000Z';
    const STILL_FUTURE = '2026-08-30T12:00:00.000Z';

    const friendsListing = {
      ownerId: ALICE,
      audience: { kind: 'FRIENDS' } as const,
      status: 'AVAILABLE' as const,
    };

    /** A claim request with the uninteresting fields filled in. */
    const claiming = (
      listing: PolicyRequest & { action: 'listing:claim' } extends { listing: infer L }
        ? L
        : never,
      over: { viewerHasClaimed?: boolean; now?: string } = {},
    ) =>
      ({
        action: 'listing:claim',
        listing,
        viewerHasClaimed: over.viewerHasClaimed ?? false,
        now: over.now ?? NOW,
      }) satisfies PolicyRequest;

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
      expect(decide(asStranger(), claiming(publicListing))).toMatchObject({
        allowed: false,
        reason: 'NOT_FRIENDS',
      });
      expect(decide(asFriend(), claiming(publicListing)).allowed).toBe(true);
    });

    it('refuses to let an owner claim their own listing', () => {
      expect(decide(asOwner(), claiming(friendsListing))).toMatchObject({
        allowed: false,
        reason: 'NOT_OWNER',
      });
    });

    it('refuses to claim a listing that is no longer available', () => {
      expect(
        decide(asFriend(), claiming({ ...friendsListing, status: 'EXCHANGED' })),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses a claim from someone outside the audience', () => {
      expect(
        decide(asStranger(), claiming({ ...friendsListing, audience: { kind: 'FRIENDS' } })),
      ).toMatchObject({ allowed: false, reason: 'NO_MATCHING_AUDIENCE' });
    });

    it('refuses a claim from an anonymous caller', () => {
      expect(decide(asAnonymous(), claiming(friendsListing))).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });

    it('refuses a claim from a blocked viewer', () => {
      expect(decide(asBlocked(), claiming(friendsListing))).toMatchObject({
        allowed: false,
        reason: 'BLOCKED',
      });
    });

    // ── Deadlines ────────────────────────────────────────────────────
    it('accepts a claim while the deadline is still ahead', () => {
      expect(
        decide(asFriend(), claiming({ ...friendsListing, claimsCloseAt: STILL_FUTURE })).allowed,
      ).toBe(true);
    });

    it('refuses a claim once the deadline has passed', () => {
      expect(
        decide(asFriend(), claiming({ ...friendsListing, claimsCloseAt: ALREADY_PAST })),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('treats the deadline instant itself as closed', () => {
      // A boundary falls on one side or the other; "closes at 5pm" reading as
      // "5pm is too late" is what a deadline means to a person.
      expect(
        decide(asFriend(), claiming({ ...friendsListing, claimsCloseAt: NOW })),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('leaves a listing with no deadline open', () => {
      expect(decide(asFriend(), claiming(friendsListing)).allowed).toBe(true);
    });

    it('refuses a second claim from the same person', () => {
      // One person, one entry — otherwise a lottery is won by whoever scripts
      // the most entries.
      expect(
        decide(asFriend(), claiming(friendsListing, { viewerHasClaimed: true })),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    // ── Creating, editing, withdrawing ───────────────────────────────
    it('lets someone list only their own thing', () => {
      expect(decide(asOwner(), { action: 'listing:create', ownerId: ALICE }).allowed).toBe(true);
      expect(
        decide(asFriend(), { action: 'listing:create', ownerId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asAnonymous(), { action: 'listing:create', ownerId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it.each(['listing:modify', 'listing:withdraw'] as const)('lets the owner %s a live listing', (action) => {
      expect(
        decide(asOwner(), { action, listing: { ownerId: ALICE, status: 'AVAILABLE' } }).allowed,
      ).toBe(true);
      expect(
        decide(asOwner(), { action, listing: { ownerId: ALICE, status: 'CLAIMED' } }).allowed,
      ).toBe(true);
    });

    it.each(['listing:modify', 'listing:withdraw'] as const)(
      'refuses to %s a settled listing, or one you do not own',
      (action) => {
        // Once handed over or withdrawn the record is history, and history does
        // not get rewritten.
        expect(
          decide(asOwner(), { action, listing: { ownerId: ALICE, status: 'EXCHANGED' } }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
        expect(
          decide(asOwner(), { action, listing: { ownerId: ALICE, status: 'WITHDRAWN' } }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
        expect(
          decide(asFriend(), { action, listing: { ownerId: ALICE, status: 'AVAILABLE' } }),
        ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
        expect(
          decide(asAnonymous(), { action, listing: { ownerId: ALICE, status: 'AVAILABLE' } }),
        ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
      },
    );

    // ── The draw ─────────────────────────────────────────────────────
    const lottery = {
      ownerId: ALICE,
      status: 'AVAILABLE' as const,
      claimMode: 'LOTTERY' as const,
      claimsCloseAt: ALREADY_PAST,
    };

    it('lets the owner draw a closed lottery', () => {
      expect(decide(asOwner(), { action: 'listing:draw', listing: lottery, now: NOW }).allowed).toBe(
        true,
      );
    });

    it('refuses a draw while entries are still open', () => {
      // Drawing early would let an owner run it, dislike the winner, and leave
      // entries open for another go.
      expect(
        decide(asOwner(), {
          action: 'listing:draw',
          listing: { ...lottery, claimsCloseAt: STILL_FUTURE },
          now: NOW,
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses a draw on a lottery that never closes', () => {
      // Drawing whenever you like is not a draw, it is picking.
      const { claimsCloseAt: _omitted, ...noDeadline } = lottery;
      expect(
        decide(asOwner(), { action: 'listing:draw', listing: noDeadline, now: NOW }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it.each(['FIRST_COME', 'OWNER_SELECTS'] as const)(
      'refuses a draw in %s mode, where it means nothing',
      (claimMode) => {
        expect(
          decide(asOwner(), {
            action: 'listing:draw',
            listing: { ...lottery, claimMode },
            now: NOW,
          }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      },
    );

    it('refuses a draw on a listing already claimed', () => {
      expect(
        decide(asOwner(), {
          action: 'listing:draw',
          listing: { ...lottery, status: 'CLAIMED' },
          now: NOW,
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses a draw by anyone but the owner', () => {
      expect(
        decide(asFriend(), { action: 'listing:draw', listing: lottery, now: NOW }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asAnonymous(), { action: 'listing:draw', listing: lottery, now: NOW }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    // ── Hand-picking ─────────────────────────────────────────────────
    it('lets only the listing owner decide a pending claim', () => {
      expect(
        decide(asOwner(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE, claimMode: 'OWNER_SELECTS' },
          claim: { status: 'PENDING' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE, claimMode: 'OWNER_SELECTS' },
          claim: { status: 'PENDING' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
      expect(
        decide(asOwner(), {
          action: 'claim:decide',
          listing: { ownerId: ALICE, claimMode: 'OWNER_SELECTS' },
          claim: { status: 'ACCEPTED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it.each(['LOTTERY', 'FIRST_COME'] as const)(
      'refuses to let the owner hand-pick a claim in %s mode',
      (claimMode) => {
        // The load-bearing one. An owner who can accept a chosen entry has a
        // draw in name only, and the entrants were told otherwise.
        expect(
          decide(asOwner(), {
            action: 'claim:decide',
            listing: { ownerId: ALICE, claimMode },
            claim: { status: 'PENDING' },
          }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      },
    );

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
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [], isModerator: false }, base),
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

    // ── The handoff ──────────────────────────────────────────────────
    const handoff = {
      listing: { ownerId: ALICE },
      claim: { claimantId: BOB },
    };

    it('lets the other party accept a proposed time, but never the proposer', () => {
      // Agreeing with yourself is not agreement.
      expect(
        decide(asFriend(), {
          action: 'exchange:respond',
          ...handoff,
          exchange: { proposedBy: ALICE, status: 'PROPOSED' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'exchange:respond',
          ...handoff,
          exchange: { proposedBy: BOB, status: 'PROPOSED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      expect(
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [], isModerator: false }, {
          action: 'exchange:respond',
          ...handoff,
          exchange: { proposedBy: ALICE, status: 'PROPOSED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('refuses to answer a handoff that is no longer open', () => {
      for (const status of ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const) {
        expect(
          decide(asFriend(), {
            action: 'exchange:respond',
            ...handoff,
            exchange: { proposedBy: ALICE, status },
          }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      }
    });

    it('lets either party cancel, right up until it is done', () => {
      // Calling off a plan to meet a person must be the easiest thing here.
      for (const status of ['PROPOSED', 'SCHEDULED'] as const) {
        expect(
          decide(asOwner(), { action: 'exchange:cancel', ...handoff, exchange: { status } })
            .allowed,
        ).toBe(true);
        expect(
          decide(asFriend(), { action: 'exchange:cancel', ...handoff, exchange: { status } })
            .allowed,
        ).toBe(true);
      }
      expect(
        decide(asOwner(), {
          action: 'exchange:cancel',
          ...handoff,
          exchange: { status: 'COMPLETED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('lets either party mark a scheduled handoff done, and no one else', () => {
      expect(
        decide(asOwner(), {
          action: 'exchange:complete',
          ...handoff,
          exchange: { status: 'SCHEDULED' },
        }).allowed,
      ).toBe(true);
      expect(
        decide(asFriend(), {
          action: 'exchange:complete',
          ...handoff,
          exchange: { status: 'SCHEDULED' },
        }).allowed,
      ).toBe(true);
      expect(
        decide({ viewerId: CAROL, relationship: 'FRIEND', sharedCircleIds: [], isModerator: false }, {
          action: 'exchange:complete',
          ...handoff,
          exchange: { status: 'SCHEDULED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      expect(
        decide(asOwner(), {
          action: 'exchange:complete',
          ...handoff,
          exchange: { status: 'PROPOSED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses every handoff action to a blocked party', () => {
      // A block cuts off the meeting before any state is consulted.
      expect(
        decide(asBlocked(), {
          action: 'exchange:respond',
          ...handoff,
          exchange: { proposedBy: ALICE, status: 'PROPOSED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'BLOCKED' });
      expect(
        decide(asBlocked(), {
          action: 'exchange:cancel',
          ...handoff,
          exchange: { status: 'SCHEDULED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'BLOCKED' });
    });

    it('refuses handoff actions to an anonymous caller', () => {
      expect(
        decide(asAnonymous(), {
          action: 'exchange:complete',
          ...handoff,
          exchange: { status: 'SCHEDULED' },
        }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it('lets a declined time be proposed again, but not a scheduled one moved', () => {
      const base = {
        action: 'exchange:propose',
        listing: { ownerId: ALICE },
        claim: { claimantId: BOB, status: 'ACCEPTED' as const },
      } as const;

      // Declining a time is not declining the handoff.
      expect(
        decide(asFriend(), { ...base, exchange: { status: 'CANCELLED' } }).allowed,
      ).toBe(true);
      // Moving a booked one goes through cancel first, so the calendar cleanup
      // is explicit rather than implied.
      expect(
        decide(asFriend(), { ...base, exchange: { status: 'SCHEDULED' } }),
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
   * Coverage for the report gates lives here so the `ALL_ACTIONS` backstop
   * below sees it. The substantive per-party leak tests — which thread reaches
   * whom, and what each projection withholds — are in `moderation.test.ts`.
   */
  describe('reporting and moderation', () => {
    const openReport = {
      reporterId: BOB,
      subjectUserId: ALICE,
      status: 'OPEN' as const,
      subjectNotified: false,
    };

    it('lets an authenticated user file about someone else, but not themselves', () => {
      expect(decide(asFriend(), { action: 'report:create', subjectUserId: ALICE }).allowed).toBe(
        true,
      );
      expect(
        decide(asOwner(), { action: 'report:create', subjectUserId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      expect(
        decide(asAnonymous(), { action: 'report:create', subjectUserId: ALICE }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it('lets a blocked person report the one who blocked them', () => {
      // Blocks are bidirectional, so without this an abuser blocks their victim
      // and the victim can no longer ask for help.
      expect(
        decide(asBlocked(), { action: 'report:create', subjectUserId: ALICE }).allowed,
      ).toBe(true);
    });

    it('lets the reporter read, and hides it from the subject until contact', () => {
      const reporter = { viewerId: BOB, relationship: 'SELF' as const, sharedCircleIds: [], isModerator: false };
      const subject = { viewerId: ALICE, relationship: 'SELF' as const, sharedCircleIds: [], isModerator: false };

      expect(decide(reporter, { action: 'report:read', report: openReport }).allowed).toBe(true);
      expect(decide(subject, { action: 'report:read', report: openReport })).toMatchObject({
        allowed: false,
        reason: 'NOT_PARTICIPANT',
      });
      expect(
        decide(subject, {
          action: 'report:read',
          report: { ...openReport, subjectNotified: true },
        }).allowed,
      ).toBe(true);
    });

    it('closes the reply channel when the case closes', () => {
      const reporter = { viewerId: BOB, relationship: 'SELF' as const, sharedCircleIds: [], isModerator: false };
      expect(decide(reporter, { action: 'report:reply', report: openReport }).allowed).toBe(true);
      expect(
        decide(reporter, { action: 'report:reply', report: { ...openReport, status: 'UPHELD' } }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it.each(['moderation:review', 'moderation:correspond', 'moderation:dispose'] as const)(
      'gates %s on the allowlist, not on any relationship',
      (action) => {
        expect(decide(asModerator(), { action }).allowed).toBe(true);
        expect(decide(asFriend(), { action })).toMatchObject({
          allowed: false,
          reason: 'NOT_PARTICIPANT',
        });
        expect(decide(asOwner(), { action })).toMatchObject({
          allowed: false,
          reason: 'NOT_PARTICIPANT',
        });
        expect(decide(asAnonymous(), { action })).toMatchObject({
          allowed: false,
          reason: 'ANONYMOUS',
        });
      },
    );
  });

  describe('friend requests and blocking', () => {
    it('lets a stranger ask, and refuses to let anyone ask twice', () => {
      expect(
        decide(asStranger(), { action: 'friend:request', targetId: ALICE, existing: 'NONE' }),
      ).toMatchObject({ allowed: true });

      // Re-asking is not a way to nag someone who has not answered.
      for (const existing of ['FRIEND', 'PENDING'] as const) {
        expect(
          decide(asStranger(), { action: 'friend:request', targetId: ALICE, existing }),
        ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
      }
    });

    it('refuses a request to yourself', () => {
      expect(
        decide(asOwner(), { action: 'friend:request', targetId: ALICE, existing: 'SELF' }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('refuses a request from an anonymous caller', () => {
      expect(
        decide(asAnonymous(), { action: 'friend:request', targetId: ALICE, existing: 'NONE' }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it('blocks a request between a blocked pair', () => {
      // The block gate runs above the switch, so no `existing` value can
      // reopen it — including the 'NONE' a naive caller might pass.
      expect(
        decide(asBlocked(), { action: 'friend:request', targetId: ALICE, existing: 'NONE' }),
      ).toMatchObject({ allowed: false, reason: 'BLOCKED' });
    });

    it('lets the recipient answer, and never the sender', () => {
      // BOB is the fixture viewer. ALICE asked, so BOB may answer.
      expect(
        decide(asStranger(), {
          action: 'friend:respond',
          request: friendship({ requestedBy: ALICE, status: 'PENDING' }),
        }),
      ).toMatchObject({ allowed: true });

      // BOB asked, so BOB may not answer. Agreeing with yourself is not
      // agreement — the same rule the handoff uses.
      expect(
        decide(asStranger(), {
          action: 'friend:respond',
          request: friendship({ requestedBy: BOB, status: 'PENDING' }),
        }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
    });

    it('refuses to answer a request that is already accepted', () => {
      expect(
        decide(asStranger(), {
          action: 'friend:respond',
          request: friendship({ requestedBy: ALICE, status: 'ACCEPTED' }),
        }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    });

    it('refuses an anonymous response', () => {
      expect(
        decide(asAnonymous(), {
          action: 'friend:respond',
          request: friendship({ requestedBy: ALICE, status: 'PENDING' }),
        }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it('lets either party remove a friendship, and nobody else', () => {
      const pair = friendship();
      expect(decide(asStranger(), { action: 'friend:remove', friendship: pair })).toMatchObject({
        allowed: true,
      });
      expect(decide(asOwner(), { action: 'friend:remove', friendship: pair })).toMatchObject({
        allowed: true,
      });

      // CAROL is party to neither side of an ALICE/BOB row.
      expect(
        decide(viewer({ viewerId: CAROL }), { action: 'friend:remove', friendship: pair }),
      ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
      expect(
        decide(asAnonymous(), { action: 'friend:remove', friendship: pair }),
      ).toMatchObject({ allowed: false, reason: 'ANONYMOUS' });
    });

    it.each(['block:create', 'block:remove'] as const)(
      'allows %s against anyone but yourself, even a blocked pair',
      (action) => {
        expect(decide(asStranger(), { action, targetId: ALICE })).toMatchObject({ allowed: true });

        // The whole point of the exemption: a block must be liftable, and an
        // abuser must not be able to block someone out of blocking back.
        expect(decide(asBlocked(), { action, targetId: ALICE })).toMatchObject({ allowed: true });

        expect(decide(asOwner(), { action, targetId: ALICE })).toMatchObject({
          allowed: false,
          reason: 'NOT_PARTICIPANT',
        });
        expect(decide(asAnonymous(), { action, targetId: ALICE })).toMatchObject({
          allowed: false,
          reason: 'ANONYMOUS',
        });
      },
    );

    it('lets a signed-in user read their own block list', () => {
      expect(decide(asStranger(), { action: 'block:list' })).toMatchObject({ allowed: true });
      expect(decide(asAnonymous(), { action: 'block:list' })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    });

    it('lets a signed-in user search, and nobody else', () => {
      expect(decide(asStranger(), { action: 'people:search' })).toMatchObject({ allowed: true });
      expect(decide(asAnonymous(), { action: 'people:search' })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
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
