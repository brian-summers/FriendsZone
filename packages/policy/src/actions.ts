import type {
  CalendarEvent,
  Claim,
  Exchange,
  Conversation,
  Friendship,
  HangoutRequest,
  Instant,
  RelationshipKind,
  Listing,
  Report,
  UserId,
} from '@friendszone/contracts';
import { allow, deny, type Decision } from './decision.js';
import { areClaimsClosed } from './marketplace.js';
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
  | 'friend:request'
  | 'friend:respond'
  | 'friend:remove'
  | 'block:create'
  | 'block:remove'
  | 'block:list'
  | 'people:search'
  | 'discoverability:manage'
  | 'message:send'
  | 'thread:read'
  | 'conversation:list'
  | 'notifications:read'
  | 'sharing:manage'
  | 'circle:manage'
  | 'account:export'
  | 'account:delete'
  | 'calendar:view'
  | 'calendar:preview'
  | 'slots:find'
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
  | 'listing:create'
  | 'listing:modify'
  | 'listing:withdraw'
  | 'listing:claim'
  | 'listing:draw'
  | 'claim:decide'
  | 'exchange:propose'
  | 'exchange:respond'
  | 'exchange:cancel'
  | 'exchange:complete'
  | 'report:create'
  | 'report:read'
  | 'report:reply'
  | 'moderation:review'
  | 'moderation:correspond'
  | 'moderation:dispose';

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
  'friend:request': true,
  'friend:respond': true,
  'friend:remove': true,
  'block:create': true,
  'block:remove': true,
  'block:list': true,
  'people:search': true,
  'discoverability:manage': true,
  'message:send': true,
  'thread:read': true,
  'conversation:list': true,
  'notifications:read': true,
  'sharing:manage': true,
  'circle:manage': true,
  'account:export': true,
  'account:delete': true,
  'calendar:view': true,
  'calendar:preview': true,
  'slots:find': true,
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
  'listing:create': true,
  'listing:modify': true,
  'listing:withdraw': true,
  'listing:claim': true,
  'listing:draw': true,
  'claim:decide': true,
  'exchange:propose': true,
  'exchange:respond': true,
  'exchange:cancel': true,
  'exchange:complete': true,
  'report:create': true,
  'report:read': true,
  'report:reply': true,
  'moderation:review': true,
  'moderation:correspond': true,
  'moderation:dispose': true,
};

export const ALL_ACTIONS = Object.keys(ACTION_REGISTRY) as readonly Action[];

/**
 * Actions a blocked viewer is still permitted to *attempt*.
 *
 * **The invariant every member must satisfy:** the response tells the caller
 * nothing whatsoever about the person they are blocked with. Either it is empty,
 * or everything in it is the caller's own material. Do not add to this set
 * without checking that, and without a test that asserts it.
 *
 * `calendar:view` is here to close an oracle. If it were denied outright, a
 * blocked user would get a 404 where a stranger gets an empty 200 - and that
 * difference is itself the disclosure. It tells them they have been blocked,
 * which is information the person who blocked them did not choose to share, and
 * it is exactly the signal that makes people escalate to another account. It
 * satisfies the invariant because `resolveEventVisibility` returns HIDDEN for a
 * blocked viewer before consulting any sharing rule, so the projection is empty
 * regardless. Those two facts are load-bearing together: the tests
 * `visibility.test.ts › hides everything from a blocked viewer` and
 * `projection.test.ts › gives a blocked viewer the same empty answer as a
 * stranger` are what keep the pair honest.
 *
 * The **report** actions are here for a different and more urgent reason:
 * blocking someone is frequently the *first* thing a person does when they are
 * being harassed, and blocks are bidirectional here. Without this exemption, an
 * abuser could block their victim and thereby strip them of the ability to
 * report - the safest users would be the ones who could not ask for help. They
 * satisfy the invariant because every report projection returns only the
 * caller's own side: `projectReportForReporter` and `projectReportForSubject`
 * carry no counterparty identity and no counterparty thread, asserted in
 * `moderation.test.ts`.
 *
 * Being able to *file* is still not being able to *see*. A blocked reporter can
 * name the person; they cannot read a word of their content, because the route
 * projects the reported material before capturing it as evidence.
 */
const BLOCK_EXEMPT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'calendar:view',
  'report:create',
  'report:read',
  'report:reply',
  // If Bob blocks Alice first, Alice must still be able to block Bob back -
  // otherwise whoever blocks first controls whether the other can protect
  // themselves, and Bob unblocking would silently restore contact Alice never
  // agreed to. Withdrawing your own block has to work for the same reason.
  // Both answer a fixed shape that says nothing about the counterparty
  // (ADR 0028).
  'block:create',
  'block:remove',
  'block:list',
]);

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
  | { action: 'people:search' }
  | {
      action: 'friend:request';
      targetId: UserId;
      /** How the caller already stands with them. */
      existing: RelationshipKind;
    }
  | {
      // Answering a request someone sent *you*.
      action: 'friend:respond';
      request: Pick<Friendship, 'requestedBy' | 'status'>;
    }
  | {
      // Unfriending, withdrawing your own request, or declining theirs.
      action: 'friend:remove';
      friendship: Pick<Friendship, 'lowUserId' | 'highUserId'>;
    }
  | { action: 'block:create' | 'block:remove'; targetId: UserId }
  | { action: 'block:list' }
  | { action: 'discoverability:manage' }
  | {
      /**
       * Sending requires an accepted friendship, not merely a pending one.
       * `PENDING` grants nothing anywhere else and must not become a way to
       * talk at somebody who has not answered the request (ADR 0028).
       */
      action: 'message:send';
      recipientId: UserId;
    }
  | {
      // Reading a thread you are one of the two parties to.
      action: 'thread:read';
      conversation: Pick<Conversation, 'lowUserId' | 'highUserId'>;
    }
  | { action: 'conversation:list' }
  | { action: 'notifications:read' }
  | { action: 'sharing:manage' }
  | { action: 'circle:manage'; ownerId: UserId }
  | { action: 'account:export' | 'account:delete' }
  | { action: 'calendar:view'; ownerId: UserId }
  | { action: 'calendar:preview'; ownerId: UserId }
  | { action: 'slots:find' }
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
  | { action: 'listing:create'; ownerId: UserId }
  | {
      action: 'listing:modify' | 'listing:withdraw';
      listing: Pick<Listing, 'ownerId' | 'status'>;
    }
  | {
      action: 'listing:claim';
      listing: Pick<
        Listing,
        'ownerId' | 'audience' | 'status' | 'claimsCloseAt'
      >;
      /**
       * Whether this viewer already has a live claim on this listing.
       *
       * One person, one entry - otherwise a lottery is won by whoever scripts
       * the most entries, which is the one outcome a draw exists to prevent.
       */
      viewerHasClaimed: boolean;
      /** Injected: the kernel may not read the clock (ADR 0005). */
      now: Instant;
    }
  | {
      action: 'listing:draw';
      listing: Pick<Listing, 'ownerId' | 'status' | 'claimMode' | 'claimsCloseAt'>;
      /** Injected: the kernel may not read the clock (ADR 0005). */
      now: Instant;
    }
  | {
      action: 'claim:decide';
      listing: Pick<Listing, 'ownerId' | 'claimMode'>;
      claim: Pick<Claim, 'status'>;
    }
  | {
      action: 'exchange:propose';
      listing: Pick<Listing, 'ownerId'>;
      claim: Pick<Claim, 'claimantId' | 'status'>;
      exchange: Pick<Exchange, 'status'> | null;
    }
  | {
      /**
       * Answering a proposed handoff.
       *
       * Carries `proposedBy` because the one person who may *not* accept is the
       * person who proposed - otherwise "we agreed a time" is one party
       * clicking twice.
       */
      action: 'exchange:respond';
      listing: Pick<Listing, 'ownerId'>;
      claim: Pick<Claim, 'claimantId'>;
      exchange: Pick<Exchange, 'proposedBy' | 'status'>;
    }
  | {
      action: 'exchange:cancel' | 'exchange:complete';
      listing: Pick<Listing, 'ownerId'>;
      claim: Pick<Claim, 'claimantId'>;
      exchange: Pick<Exchange, 'status'>;
    }
  | {
      // Filing a report. Whether the caller may *see* the reported material is
      // checked separately, at the route, by projecting it - see below.
      action: 'report:create';
      subjectUserId: UserId;
    }
  | {
      // Reading a report you are a party to. Which *view* you get is decided by
      // `projectReport`; this only settles whether you may look at all.
      action: 'report:read' | 'report:reply';
      report: Pick<Report, 'reporterId' | 'subjectUserId' | 'status' | 'subjectNotified'>;
    }
  | { action: 'moderation:review' | 'moderation:correspond' | 'moderation:dispose' };

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

    case 'people:search': {
      // Handles exist to be searched for, and `PublicProfile` is deliberately
      // minimal so enumeration yields nothing worth harvesting. What the route
      // must still do is omit anyone in a block relationship, in either
      // direction (ADR 0028).
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    case 'discoverability:manage': {
      // Inherently self-scoped: the route only ever writes the actor's own
      // setting, so authentication is the whole gate.
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    case 'conversation:list': {
      // Same shape: a mailbox is only ever your own.
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    case 'message:send': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // Messaging yourself is not a feature, and a self-conversation would
      // break the "exactly two people" invariant the projection relies on.
      if (isSelf(viewer, request.recipientId)) return deny(request.action, 'NOT_PARTICIPANT');
      /**
       * Friends only, and `FRIEND` exactly.
       *
       * The block gate above this switch already ends it in both directions -
       * `message:send` is deliberately **not** in `BLOCK_EXEMPT_ACTIONS`,
       * unlike `report:*`. Someone you blocked must not be able to reach you,
       * and the route turns that denial into the same 404 a nonexistent
       * account produces.
       */
      return viewer.relationship === 'FRIEND'
        ? allow(request.action)
        : deny(request.action, 'NOT_FRIENDS');
    }

    case 'thread:read': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      /**
       * Participation, not friendship - but a block still ends it.
       *
       * Two different relaxations, and only one of them is granted:
       *
       *  - **Unfriending** does not confiscate correspondence. `relationship`
       *    drops to `NONE` and this still allows, which is the same reasoning
       *    as ADR 0022's rule that deleting your account leaves the
       *    counterparty's copy of a shared plan alone.
       *  - **Blocking** does end it, because `thread:read` is deliberately
       *    *not* in `BLOCK_EXEMPT_ACTIONS`. The block gate above this switch
       *    denies before we get here. Exempting it would have meant someone
       *    you blocked could still open the thread, which is an exemption
       *    nobody asked for and non-negotiable #3 forbids by default.
       */
      const isParty =
        viewer.viewerId === request.conversation.lowUserId ||
        viewer.viewerId === request.conversation.highUserId;
      return isParty ? allow(request.action) : deny(request.action, 'NOT_PARTICIPANT');
    }

    case 'friend:request': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (isSelf(viewer, request.targetId)) return deny(request.action, 'NOT_PARTICIPANT');
      // Already friends, or already asked. Re-asking is not a way to nag
      // someone who has not answered - ADR 0007's whole posture.
      if (request.existing === 'FRIEND' || request.existing === 'PENDING') {
        return deny(request.action, 'WRONG_STATE');
      }
      return allow(request.action);
    }

    case 'friend:respond': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // The person who *sent* it cannot accept it. Agreeing with yourself is
      // not agreement - the same rule the handoff uses (ADR 0019).
      if (viewer.viewerId === request.request.requestedBy) {
        return deny(request.action, 'NOT_PARTICIPANT');
      }
      return request.request.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'friend:remove': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      /**
       * One action for three things a user experiences differently - unfriend,
       * withdraw my request, decline theirs - because they are the same write
       * and either party may do any of them. Splitting them would mean three
       * gates that must agree about who is allowed.
       */
      const isParty =
        viewer.viewerId === request.friendship.lowUserId ||
        viewer.viewerId === request.friendship.highUserId;
      return isParty ? allow(request.action) : deny(request.action, 'NOT_PARTICIPANT');
    }

    case 'block:list': {
      // Self-scoped by construction: the route only ever reads the actor's own
      // blocks. There is no route anywhere that answers "who blocked me" -
      // that answer belongs to the other party, and knowing it is what makes a
      // block evadable (ADR 0028).
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

    case 'block:create':
    case 'block:remove': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // Blocking yourself is not a thing.
      return isSelf(viewer, request.targetId)
        ? deny(request.action, 'NOT_PARTICIPANT')
        : allow(request.action);
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
    case 'circle:manage': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      /**
       * Your circles are yours alone - reading them as much as writing them.
       *
       * There is no "circles I am in" anywhere in the product, and this gate is
       * why: every circle route names an owner, and it must be the caller
       * (ADR 0023).
       */
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'account:export':
    case 'account:delete': {
      /**
       * Inherently self-scoped: both routes act on the caller and take no
       * subject id, so there is no "whose account" to get wrong. Authentication
       * is the whole gate.
       *
       * Not block-exempt, and it does not need to be - neither response says
       * anything about anyone the caller is blocked with. The export runs
       * through the same projections, which already return nothing for a
       * blocked pair.
       */
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
    }

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
       * "What does Bob see of *my* week?" - the sharing checkup.
       *
       * Safe only because the direction is fixed: the owner asks about their
       * own calendar. The inverse - letting a caller name whose eyes to borrow
       * on someone else's calendar - would be a complete bypass of the
       * visibility model, so the request carries `ownerId` and this case
       * requires it to be the caller. There is deliberately no parameter for
       * "whose calendar", only "whose eyes".
       */
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'slots:find': {
      /**
       * Authentication is the whole gate, and that is not a shortcut.
       *
       * Every participant's availability is computed by `projectCalendar` for
       * this exact viewer, so a stranger contributes an empty set and appears
       * free - the same answer they would get by opening that calendar. There is
       * nothing here to authorize beyond being someone, because the projection
       * has already decided what each participant is willing to tell them
       * (ADR 0008).
       */
      return viewer.viewerId === null
        ? deny(request.action, 'ANONYMOUS')
        : allow(request.action);
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
      // Unknown-to-you and not-a-party collapse to the same outcome upstream -
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
      // Editable while live - pending or confirmed - but not once it is over.
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

    case 'listing:create': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // You list your own things. There is no "post on behalf of".
      return isSelf(viewer, request.ownerId)
        ? allow(request.action)
        : deny(request.action, 'NOT_OWNER');
    }

    case 'listing:modify':
    case 'listing:withdraw': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (!isSelf(viewer, request.listing.ownerId)) return deny(request.action, 'NOT_OWNER');
      // Editable while the offer is live. Once it is withdrawn or handed over,
      // the record is history and history does not get rewritten.
      const s = request.listing.status;
      return s === 'AVAILABLE' || s === 'CLAIMED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
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
      if (request.listing.status !== 'AVAILABLE') return deny(request.action, 'WRONG_STATE');
      // One person, one entry - checked before the deadline so that a repeat
      // attempt reads the same whether or not claiming has closed.
      if (request.viewerHasClaimed) return deny(request.action, 'WRONG_STATE');
      return areClaimsClosed(request.listing, request.now)
        ? deny(request.action, 'WRONG_STATE')
        : allow(request.action);
    }

    case 'listing:draw': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (!isSelf(viewer, request.listing.ownerId)) return deny(request.action, 'NOT_OWNER');
      // A draw is meaningless in the other two modes: FIRST_COME resolves on
      // arrival, and OWNER_SELECTS is the owner deciding by hand.
      if (request.listing.claimMode !== 'LOTTERY') return deny(request.action, 'WRONG_STATE');
      if (request.listing.status !== 'AVAILABLE') return deny(request.action, 'WRONG_STATE');
      /**
       * Drawing early would let an owner run the draw, dislike the winner, and
       * leave entries open for another go. A deadline is therefore *required*
       * for a lottery, which `CreateListingInput` cannot express - so an absent
       * one is refused here rather than treated as "open forever".
       */
      return areClaimsClosed(request.listing, request.now)
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'claim:decide': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      if (!isSelf(viewer, request.listing.ownerId)) return deny(request.action, 'NOT_OWNER');
      /**
       * Hand-picking is only a mode of OWNER_SELECTS.
       *
       * Under LOTTERY this is the whole ballgame: an owner who can accept a
       * chosen entry has a draw in name only, and the entrants were told
       * otherwise. Under FIRST_COME the winning claim was already accepted on
       * arrival, so there is nothing left to decide.
       */
      if (request.listing.claimMode !== 'OWNER_SELECTS') {
        return deny(request.action, 'WRONG_STATE');
      }
      return request.claim.status === 'PENDING'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    // -----------------------------------------------------------------------
    // Reporting and moderation
    // -----------------------------------------------------------------------
    case 'report:create': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // Reporting yourself is not a thing, and allowing it would let someone
      // manufacture a case file about their own content.
      if (isSelf(viewer, request.subjectUserId)) return deny(request.action, 'NOT_PARTICIPANT');
      /**
       * Note what is *not* consulted here: `viewer.relationship`.
       *
       * Reporting must survive a block in either direction. Blocking someone is
       * often the first thing a person does when being harassed, and an abuser
       * blocking their victim must not strip that victim of the ability to
       * report them. Routes therefore build the context against the *caller*
       * (`viewerFor(actorId)`, which is always `SELF`), so the social
       * relationship never reaches this decision at all - rather than adding
       * `report:create` to `BLOCK_EXEMPT_ACTIONS` and widening a set whose
       * invariant is that its members return no data.
       *
       * Being able to *file* is not being able to *see*: the route projects the
       * reported material first, so a blocked reporter can still report the
       * person, and still cannot read a word of their content.
       */
      return allow(request.action);
    }

    case 'report:read':
    case 'report:reply': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');

      const isReporter = viewer.viewerId === request.report.reporterId;
      /**
       * The subject is a party only once a moderator has opened a thread.
       *
       * Before that they must not be able to read, reply to, or even confirm
       * the existence of a report about them: "you have been reported",
       * arriving promptly, identifies the reporter about as well as naming
       * them would (ADR 0018).
       */
      const isNotifiedSubject =
        viewer.viewerId === request.report.subjectUserId && request.report.subjectNotified;

      if (!isReporter && !isNotifiedSubject) return deny(request.action, 'NOT_PARTICIPANT');
      if (request.action === 'report:read') return allow(request.action);

      // Replies stop when the case does. A closed report is not a message
      // channel to someone you were in a dispute with.
      const s = request.report.status;
      return s === 'OPEN' || s === 'AWAITING_INFO'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'moderation:review':
    case 'moderation:correspond':
    case 'moderation:dispose': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      // The allowlist is the whole gate, and it is not a relationship: a
      // moderator has no special standing with anyone, only with the queue.
      return viewer.isModerator
        ? allow(request.action)
        : deny(request.action, 'NOT_PARTICIPANT');
    }

    case 'exchange:respond': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isCounterparty =
        isSelf(viewer, request.listing.ownerId) || viewer.viewerId === request.claim.claimantId;
      if (!isCounterparty) return deny(request.action, 'NOT_PARTICIPANT');
      // Agreeing with yourself is not agreement. The proposer waits.
      if (viewer.viewerId === request.exchange.proposedBy) {
        return deny(request.action, 'NOT_PARTICIPANT');
      }
      return request.exchange.status === 'PROPOSED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'exchange:cancel': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isCounterparty =
        isSelf(viewer, request.listing.ownerId) || viewer.viewerId === request.claim.claimantId;
      if (!isCounterparty) return deny(request.action, 'NOT_PARTICIPANT');
      /**
       * Either party, at any point before it is done, and no reason required.
       *
       * Calling off a plan to meet a person must be the easiest thing in the
       * flow - someone who has become uncomfortable should never have to
       * justify it, to us or to the other party (ADR 0019).
       */
      const s = request.exchange.status;
      return s === 'PROPOSED' || s === 'SCHEDULED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'exchange:complete': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isCounterparty =
        isSelf(viewer, request.listing.ownerId) || viewer.viewerId === request.claim.claimantId;
      if (!isCounterparty) return deny(request.action, 'NOT_PARTICIPANT');
      // Either party's call, not a two-sided confirmation - chasing someone for
      // a confirming tap is the obligation this product refuses (ADR 0007).
      return request.exchange.status === 'SCHEDULED'
        ? allow(request.action)
        : deny(request.action, 'WRONG_STATE');
    }

    case 'exchange:propose': {
      if (viewer.viewerId === null) return deny(request.action, 'ANONYMOUS');
      const isCounterparty =
        isSelf(viewer, request.listing.ownerId) || viewer.viewerId === request.claim.claimantId;
      if (!isCounterparty) return deny(request.action, 'NOT_PARTICIPANT');
      if (request.claim.status !== 'ACCEPTED') return deny(request.action, 'WRONG_STATE');
      /**
       * Propose whenever nothing is currently arranged.
       *
       * `CANCELLED` is included deliberately: declining a *time* is not
       * declining the handoff. The claim is still accepted and the two still
       * need to meet, so a rejected suggestion returns them to "nothing
       * arranged" rather than ending the exchange (ADR 0019).
       *
       * `SCHEDULED` is excluded - moving a booked handoff means un-booking two
       * calendars, so it goes through cancel and then propose, where the
       * calendar cleanup is explicit rather than implied.
       */
      if (request.exchange !== null) {
        const s = request.exchange.status;
        if (s !== 'PROPOSED' && s !== 'CANCELLED') return deny(request.action, 'WRONG_STATE');
      }
      return allow(request.action);
    }

    default:
      return assertNever(request, 'can');
  }
}
