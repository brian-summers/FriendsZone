import type {
  CalendarEvent,
  Claim,
  Exchange,
  HangoutRequest,
  Listing,
  UserId,
} from '@friendszone/contracts';
import { allow, deny, type Decision } from './decision.js';
import { assertNever, isSelf, type ViewerContext } from './viewer.js';
import { audienceMatches } from './visibility.js';

/**
 * Every privileged operation in Friendszone, named.
 *
 * This union is the contract between the transport layer and the security
 * kernel. Routes do not invent their own checks; they name an action from this
 * list and hand over the resource. Adding a capability means adding a member
 * here, which means `can()` stops compiling until the new case is handled.
 */
export type Action =
  | 'profile:read'
  | 'friends:list'
  | 'notifications:read'
  | 'sharing:manage'
  | 'calendar:view'
  | 'calendar:preview'
  | 'event:create'
  | 'event:modify'
  | 'hangout:send'
  | 'hangout:read'
  | 'hangout:respond'
  | 'hangout:withdraw'
  | 'hangout:update'
  | 'hangout:reschedule'
  | 'hangout:cancel'
  | 'hangout:book'
  | 'listing:view'
  | 'listing:claim'
  | 'claim:decide'
  | 'exchange:propose';

/**
 * The action list as data.
 *
 * Typing the literal as `Record<Action, true>` makes the compiler demand a key
 * for every member of the union, so this stays in step with `Action` for free.
 * Tests use it to assert that no action ships without coverage.
 */
const ACTION_REGISTRY: Record<Action, true> = {
  'profile:read': true,
  'friends:list': true,
  'notifications:read': true,
  'sharing:manage': true,
  'calendar:view': true,
  'calendar:preview': true,
  'event:create': true,
  'event:modify': true,
  'hangout:send': true,
  'hangout:read': true,
  'hangout:respond': true,
  'hangout:withdraw': true,
  'hangout:update': true,
  'hangout:reschedule': true,
  'hangout:cancel': true,
  'hangout:book': true,
  'listing:view': true,
  'listing:claim': true,
  'claim:decide': true,
  'exchange:propose': true,
};

export const ALL_ACTIONS = Object.keys(ACTION_REGISTRY) as readonly Action[];

/**
 * Actions a blocked viewer is still permitted to *attempt*.
 *
 * This exists to close an oracle, not to weaken blocking. If `calendar:view`
 * were denied outright, a blocked user would get a 404 where a stranger gets an
 * empty 200 — and that difference is itself the disclosure. It tells them they
 * have been blocked, which is information the person who blocked them did not
 * choose to share, and it is exactly the signal that makes people escalate to
 * another account.
 *
 * The exemption is only safe because `resolveEventVisibility` returns HIDDEN
 * for a blocked viewer before it consults any sharing rule, so the projection
 * is empty regardless. Those two facts are load-bearing together: the tests
 * `visibility.test.ts › hides everything from a blocked viewer` and
 * `projection.test.ts › gives a blocked viewer the same empty answer as a
 * stranger` are what keep this pair honest. Do not add to this set without an
 * equivalent guarantee that the response carries no data.
 */
const BLOCK_EXEMPT_ACTIONS: ReadonlySet<Action> = new Set<Action>(['calendar:view']);

/**
 * An action bundled with exactly the resource fields needed to decide it.
 *
 * Each variant takes a `Pick<>` rather than the whole entity. That is not
 * fussiness: it means the type signature documents precisely which fields are
 * security-relevant, and a reviewer can verify a decision without holding the
 * entire entity in their head.
 */
export type PolicyRequest =
  | { action: 'profile:read'; subjectId: UserId }
  | { action: 'friends:list'; ownerId: UserId }
  | { action: 'notifications:read' }
  | { action: 'sharing:manage' }
  | { action: 'calendar:view'; ownerId: UserId }
  | { action: 'calendar:preview'; ownerId: UserId }
  | { action: 'event:create'; ownerId: UserId }
  | { action: 'event:modify'; event: Pick<CalendarEvent, 'ownerId'> }
  | { action: 'hangout:send'; recipientId: UserId }
  | {
      // Read a single hangout you are a party to.
      action: 'hangout:read';
      request: Pick<HangoutRequest, 'proposerId' | 'inviteeIds'>;
    }
  | {
      action: 'hangout:respond';
      request: Pick<HangoutRequest, 'inviteeIds' | 'status'>;
    }
  | {
      action: 'hangout:withdraw';
      request: Pick<HangoutRequest, 'proposerId' | 'status'>;
    }
  | {
      // Editing properties or times is the organiser's (proposer's) right.
      action: 'hangout:update' | 'hangout:reschedule';
      request: Pick<HangoutRequest, 'proposerId' | 'status'>;
    }
  | {
      // Cancelling a *confirmed* hangout is either party's right to call off.
      action: 'hangout:cancel';
      request: Pick<HangoutRequest, 'proposerId' | 'inviteeIds' | 'status'>;
    }
  | {
      // Booking a FLOATING occurrence is open to either party.
      action: 'hangout:book';
      request: Pick<HangoutRequest, 'proposerId' | 'inviteeIds' | 'status' | 'kind'>;
    }
  | { action: 'listing:view'; listing: Pick<Listing, 'ownerId' | 'audience'> }
  | {
      action: 'listing:claim';
      listing: Pick<Listing, 'ownerId' | 'audience' | 'status'>;
    }
  | {
      action: 'claim:decide';
      listing: Pick<Listing, 'ownerId'>;
      claim: Pick<Claim, 'status'>;
    }
  | {
      action: 'exchange:propose';
      listing: Pick<Listing, 'ownerId'>;
      claim: Pick<Claim, 'claimantId' | 'status'>;
      exchange: Pick<Exchange, 'status'> | null;
    };

/**
 * The single entry point for authorization.
 *
 * Pure, synchronous, and total. Every path returns an explicit `Decision`;
 * there is no implicit `true` at the bottom of the function.
 *
 * A note on ordering that applies to every case below: the block check comes
 * first, without exception. A block outranks friendship, ownership of a shared
 * resource, and any audience grant.
 */
export function can(viewer: ViewerContext, request: PolicyRequest): Decision<Action> {
  if (viewer.relationship === 'BLOCKED' && !BLOCK_EXEMPT_ACTIONS.has(request.action)) {
    return deny(request.action, 'BLOCKED');
  }

  switch (request.action) {
    // -----------------------------------------------------------------------
    // Identity
    // -----------------------------------------------------------------------
    case 'profile:read': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (isSelf(viewer, request.subjectId)) return allow(request.action);
      // `PublicProfile` is minimal by design, but gating it on friendship still
      // removes a bulk-enumeration surface: a scraper cannot turn a list of
      // guessed ids into a list of confirmed people.
      return viewer.relationship === 'FRIEND'
        ? allow(request.action)
        : deny(request.action, 'NOT_FRIENDS');
    }

    case 'friends:list': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // Your friend list is yours alone. Exposing it to friends would make the
      // social graph traversable one hop at a time, which is the property the
      // threat model relies on being absent.
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'notifications:read': {
      // Inherently self-scoped: the route only ever queries the actor's own
      // notifications, so authentication is the whole gate.
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    case 'sharing:manage': {
      // Reading and writing your *own* sharing defaults. The route always
      // targets the actor, so authentication is the whole gate.
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    // -----------------------------------------------------------------------
    // Calendar
    // -----------------------------------------------------------------------
    case 'calendar:view': {
      // Anyone may *ask*. What comes back is decided per event by the
      // visibility engine, and may legitimately be an empty calendar. This is
      // why the endpoint must return an empty result rather than 403 for a
      // stranger: a 403 would confirm the account exists.
      return allow(request.action);
    }

    case 'calendar:preview': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      /**
       * "What does Bob see of *my* week?" — the sharing checkup.
       *
       * Safe only because the direction is fixed: the owner asks about their
       * own calendar. The inverse — letting a caller name whose eyes to borrow
       * on someone else's calendar — would be a complete bypass of the
       * visibility model, so the request carries `ownerId` and this case
       * requires it to be the caller. There is deliberately no parameter for
       * "whose calendar", only "whose eyes".
       */
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'event:create': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // You write to your own calendar only. Invitations are a separate flow
      // that creates events owned by each invitee on acceptance.
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'event:modify': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      return isSelf(viewer, request.event.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    // -----------------------------------------------------------------------
    // Hangout requests
    // -----------------------------------------------------------------------
    case 'hangout:send': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (isSelf(viewer, request.recipientId)) return deny(request.action, 'NOT_PARTICIPANT');
      // Friendship is required to place something in someone's inbox. This is
      // the anti-harassment boundary: without it, the request inbox becomes an
      // open channel to any user whose handle you can guess.
      return viewer.relationship === 'FRIEND'
        ? allow(request.action)
        : deny(request.action, 'NOT_FRIENDS');
    }

    case 'hangout:read': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isParty =
        viewer.viewerId === request.request.proposerId ||
        request.request.inviteeIds.includes(viewer.viewerId);
      // Unknown-to-you and not-a-party collapse to the same outcome upstream —
      // a non-participant learns nothing, not even that the hangout exists.
      return isParty ? allow(request.action) : deny(request.action, 'NOT_PARTICIPANT');
    }

    case 'hangout:respond': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (!request.request.inviteeIds.includes(viewer.viewerId)) {
        return deny(request.action, 'NOT_PARTICIPANT');
      }
      return request.request.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'hangout:withdraw': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (viewer.viewerId !== request.request.proposerId) {
        return deny(request.action, 'NOT_OWNER');
      }
      return request.request.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'hangout:update':
    case 'hangout:reschedule': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // The organiser owns the hangout's shape. The invitee agreed to what was
      // proposed; changing it is the proposer's call (the invitee's recourse to
      // a change they dislike is to cancel or decline).
      if (viewer.viewerId !== request.request.proposerId) {
        return deny(request.action, 'NOT_OWNER');
      }
      // Editable while live — pending or confirmed — but not once it is over.
      const s = request.request.status;
      return s === 'PENDING' || s === 'ACCEPTED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'hangout:cancel': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isParty =
        viewer.viewerId === request.request.proposerId ||
        request.request.inviteeIds.includes(viewer.viewerId);
      if (!isParty) return deny(request.action, 'NOT_PARTICIPANT');
      // Cancel is specifically calling off a *confirmed* hangout. A still-pending
      // one is withdrawn or declined instead.
      return request.request.status === 'ACCEPTED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'hangout:book': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isParty =
        viewer.viewerId === request.request.proposerId ||
        request.request.inviteeIds.includes(viewer.viewerId);
      if (!isParty) return deny(request.action, 'NOT_PARTICIPANT');
      if (request.request.kind !== 'FLOATING') return deny(request.action, 'WRONG_STATE');
      // A floating invitation stays PENDING while it can still be booked.
      return request.request.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    // -----------------------------------------------------------------------
    // Marketplace
    // -----------------------------------------------------------------------
    case 'listing:view': {
      if (isSelf(viewer, request.listing.ownerId)) return allow(request.action);
      return audienceMatches(request.listing.audience, viewer)
        ? allow(request.action)
        : deny(request.action, 'NO_MATCHING_AUDIENCE');
    }

    case 'listing:claim': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (isSelf(viewer, request.listing.ownerId)) return deny(request.action, 'NOT_OWNER');
      if (!audienceMatches(request.listing.audience, viewer)) {
        return deny(request.action, 'NO_MATCHING_AUDIENCE');
      }
      // Visibility and claimability are separate gates. A listing shared
      // PUBLIC is discoverable by anyone, but an exchange ends in two people
      // meeting, so actually claiming it still requires a friendship.
      if (viewer.relationship !== 'FRIEND') return deny(request.action, 'NOT_FRIENDS');
      return request.listing.status === 'AVAILABLE'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'claim:decide': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (!isSelf(viewer, request.listing.ownerId)) return deny(request.action, 'NOT_OWNER');
      return request.claim.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'exchange:propose': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isCounterparty =
        isSelf(viewer, request.listing.ownerId) || viewer.viewerId === request.claim.claimantId;
      if (!isCounterparty) return deny(request.action, 'NOT_PARTICIPANT');
      if (request.claim.status !== 'ACCEPTED') return deny(request.action, 'WRONG_STATE');
      // Re-proposing a time is allowed while the handoff is still being
      // arranged, but not after it is done or called off.
      if (request.exchange !== null && request.exchange.status !== 'PROPOSED') {
        return deny(request.action, 'WRONG_STATE');
      }
      return allow(request.action);
    }

    default:
      return assertNever(request, 'can');
  }
}
