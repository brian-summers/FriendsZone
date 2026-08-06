import {
  ClaimId,
  ExchangeId,
  ProposeExchangeInput,
  RespondExchangeInput,
  type CalendarEvent,
  type Claim,
  type EventId,
  type Exchange,
  type ExchangeView,
  type Listing,
  type TimeRange,
  type UserId,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  PolicyDeniedError,
  projectExchange,
} from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * The handoff — the one place Friendszone moves two people into a room.
 *
 * Read docs/adr/0019-the-handoff.md before changing anything here. The two
 * things most easily undone by accident:
 *
 * 1. **`visibilityCeiling: 'BUSY'` on the booked events.** Third parties must
 *    learn only that someone is occupied — never where, never with whom. Both
 *    participants still see everything, because the attendee branch of
 *    `resolveEventVisibility` returns FULL *before* the ceiling clamp. Raising
 *    this to FULL, as accepted hangouts use, publishes an address.
 *
 * 2. **Cancelling deletes the calendar copies** rather than marking them
 *    cancelled. A cancelled handoff that lingers still occupies a slot, and a
 *    slot that frees up at short notice is itself information.
 */

/** How far ahead a handoff may be scheduled. Bounded like every other range. */
const MAX_LEAD_DAYS = 180;

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

/**
 * The calendar copy one participant gets.
 *
 * Owned by that participant, so each sees their own in full. `attendeeIds`
 * carries both, which is what lets each party see the other's copy at FULL if
 * they ever look — while the ceiling holds everyone else at BUSY.
 */
function handoffEvent(
  ownerId: UserId,
  participants: UserId[],
  listing: Pick<Listing, 'title'>,
  exchange: Pick<Exchange, 'id' | 'timeRange' | 'location' | 'note'>,
  now: string,
): CalendarEvent {
  return {
    id: randomUUID() as EventId,
    ownerId,
    timeRange: exchange.timeRange,
    title: `Handoff — ${listing.title}`,
    status: 'CONFIRMED',
    // The load-bearing line. See the file header and ADR 0019.
    visibilityCeiling: 'BUSY',
    shareRules: [],
    attendeeIds: participants,
    // Meeting a person at a place is a firm commitment, not a soft overlap.
    exclusive: true,
    location: exchange.location,
    createdAt: now,
    updatedAt: now,
    ...(exchange.note === undefined ? {} : { description: exchange.note }),
  };
}

export function buildExchangeRoutes(repos: Repositories) {
  /**
   * Resolve claim → listing → exchange, refusing a non-party the same way an
   * unknown id is refused.
   *
   * One code path so the two outcomes cannot drift apart as this file grows.
   */
  const context = async (
    claimId: ClaimId,
    action: string,
  ): Promise<{ claim: Claim; listing: Listing; exchange: Exchange | null }> => {
    const claim = await repos.listings.claimById(claimId);
    if (claim === null) throw new PolicyDeniedError(action, 'NOT_PARTICIPANT');

    const listing = await repos.listings.byId(claim.listingId);
    if (listing === null) throw new PolicyDeniedError(action, 'NOT_PARTICIPANT');

    return { claim, listing, exchange: await repos.exchanges.forClaim(claimId) };
  };

  const partiesOf = (listing: Listing, claim: Claim): UserId[] => [
    listing.ownerId,
    claim.claimantId,
  ];

  /** Remove both calendar copies. Used on cancel. */
  const clearEvents = async (exchange: Exchange): Promise<void> => {
    await Promise.all(exchange.eventIds.map((id) => repos.calendar.remove(id)));
  };

  const validateWindow = (range: TimeRange): void => {
    const start = Date.parse(range.start);
    if (start < Date.now() - 60_000) {
      // A handoff in the past is a typo, not a plan.
      throw new PolicyDeniedError('exchange:propose', 'WRONG_STATE');
    }
    if (start > Date.now() + MAX_LEAD_DAYS * 86_400_000) {
      throw new PolicyDeniedError('exchange:propose', 'WRONG_STATE');
    }
  };

  return [
    /**
     * Propose a time and a place, or re-propose while it is still open.
     *
     * Either party may. Haggling over a time is the normal case, and a model
     * where only the giver may suggest turns a favour into a summons.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/claims/:id/exchange',
      authz: { kind: 'POLICY', action: 'exchange:propose' },
      params: z.object({ id: ClaimId }),
      query: z.object({}),
      body: ProposeExchangeInput,
      handler: async (ctx): Promise<ExchangeView> => {
        const actorId = requireActor(ctx.actorId, 'exchange:propose');
        const { claim, listing, exchange } = await context(ctx.params.id, 'exchange:propose');

        // Per owner, inside the handler — never hoisted across owners.
        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'exchange:propose',
            listing: { ownerId: listing.ownerId },
            claim: { claimantId: claim.claimantId, status: claim.status },
            exchange: exchange === null ? null : { status: exchange.status },
          }),
        );

        validateWindow(ctx.body.timeRange);

        const now = new Date().toISOString();

        // Re-proposing edits the live record rather than stacking a second, so
        // there is never a question of which proposal is the real one.
        const next: Exchange =
          exchange === null || exchange.status === 'CANCELLED'
            ? {
                id: randomUUID() as ExchangeId,
                claimId: claim.id,
                proposedBy: actorId, // ← from the session, never the body
                timeRange: ctx.body.timeRange,
                location: ctx.body.location,
                status: 'PROPOSED',
                eventIds: [],
                createdAt: now,
                updatedAt: now,
                ...(ctx.body.note === undefined ? {} : { note: ctx.body.note }),
              }
            : {
                ...exchange,
                proposedBy: actorId,
                timeRange: ctx.body.timeRange,
                location: ctx.body.location,
                status: 'PROPOSED',
                updatedAt: now,
                ...(ctx.body.note === undefined ? {} : { note: ctx.body.note }),
              };

        const stored =
          exchange === null || exchange.status === 'CANCELLED'
            ? await repos.exchanges.create(next)
            : await repos.exchanges.save(next);

        const view = projectExchange({ exchange: stored, viewer, listing, claim });
        if (view === null) throw new PolicyDeniedError('exchange:propose', 'NOT_PARTICIPANT');
        return view;
      },
    }),

    /**
     * Accept or decline the proposed time.
     *
     * Accepting is the moment anything is written to a calendar, and it writes
     * to **both** — a sanctioned cross-owner write, with the owner ids taken
     * from stored state and never from the request (ADR 0010).
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/exchanges/:id/respond',
      authz: { kind: 'POLICY', action: 'exchange:respond' },
      params: z.object({ id: ExchangeId }),
      query: z.object({}),
      body: RespondExchangeInput,
      handler: async (ctx): Promise<ExchangeView> => {
        requireActor(ctx.actorId, 'exchange:respond');

        const exchange = await repos.exchanges.byId(ctx.params.id);
        if (exchange === null) throw new PolicyDeniedError('exchange:respond', 'NOT_PARTICIPANT');
        const { claim, listing } = await context(exchange.claimId, 'exchange:respond');

        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'exchange:respond',
            listing: { ownerId: listing.ownerId },
            claim: { claimantId: claim.claimantId },
            exchange: { proposedBy: exchange.proposedBy, status: exchange.status },
          }),
        );

        const now = new Date().toISOString();

        if (ctx.body.decision === 'DECLINE') {
          // Declining a time is not declining the handoff — it returns to
          // "nothing arranged", and either party may propose again.
          const stored = await repos.exchanges.save({
            ...exchange,
            status: 'CANCELLED',
            updatedAt: now,
          });
          const view = projectExchange({ exchange: stored, viewer, listing, claim });
          if (view === null) throw new PolicyDeniedError('exchange:respond', 'NOT_PARTICIPANT');
          return view;
        }

        const parties = partiesOf(listing, claim);
        const created = await Promise.all(
          parties.map((ownerId) =>
            repos.calendar.create(handoffEvent(ownerId, parties, listing, exchange, now)),
          ),
        );

        const stored = await repos.exchanges.save({
          ...exchange,
          status: 'SCHEDULED',
          eventIds: created.map((e) => e.id),
          updatedAt: now,
        });

        const view = projectExchange({ exchange: stored, viewer, listing, claim });
        if (view === null) throw new PolicyDeniedError('exchange:respond', 'NOT_PARTICIPANT');
        return view;
      },
    }),

    /**
     * Call it off. Either party, no reason asked, no reason stored.
     *
     * The calendar copies are **deleted**, not cancelled in place: a cancelled
     * handoff that lingers still occupies a slot, and a slot that frees up at
     * short notice is itself information about someone's evening.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/exchanges/:id/cancel',
      authz: { kind: 'POLICY', action: 'exchange:cancel' },
      params: z.object({ id: ExchangeId }),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx): Promise<ExchangeView> => {
        requireActor(ctx.actorId, 'exchange:cancel');

        const exchange = await repos.exchanges.byId(ctx.params.id);
        if (exchange === null) throw new PolicyDeniedError('exchange:cancel', 'NOT_PARTICIPANT');
        const { claim, listing } = await context(exchange.claimId, 'exchange:cancel');

        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'exchange:cancel',
            listing: { ownerId: listing.ownerId },
            claim: { claimantId: claim.claimantId },
            exchange: { status: exchange.status },
          }),
        );

        await clearEvents(exchange);

        const stored = await repos.exchanges.save({
          ...exchange,
          status: 'CANCELLED',
          eventIds: [],
          updatedAt: new Date().toISOString(),
        });

        const view = projectExchange({ exchange: stored, viewer, listing, claim });
        if (view === null) throw new PolicyDeniedError('exchange:cancel', 'NOT_PARTICIPANT');
        return view;
      },
    }),

    /** Mark it done. Either party — this is not a two-sided confirmation. */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/exchanges/:id/complete',
      authz: { kind: 'POLICY', action: 'exchange:complete' },
      params: z.object({ id: ExchangeId }),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx): Promise<ExchangeView> => {
        requireActor(ctx.actorId, 'exchange:complete');

        const exchange = await repos.exchanges.byId(ctx.params.id);
        if (exchange === null) {
          throw new PolicyDeniedError('exchange:complete', 'NOT_PARTICIPANT');
        }
        const { claim, listing } = await context(exchange.claimId, 'exchange:complete');

        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'exchange:complete',
            listing: { ownerId: listing.ownerId },
            claim: { claimantId: claim.claimantId },
            exchange: { status: exchange.status },
          }),
        );

        const now = new Date().toISOString();

        // The calendar copies stay: this one happened, and each owner's past
        // week is theirs to keep.
        const stored = await repos.exchanges.save({
          ...exchange,
          status: 'COMPLETED',
          updatedAt: now,
        });

        await repos.listings.save({ ...listing, status: 'EXCHANGED', updatedAt: now });

        const view = projectExchange({ exchange: stored, viewer, listing, claim });
        if (view === null) throw new PolicyDeniedError('exchange:complete', 'NOT_PARTICIPANT');
        return view;
      },
    }),
  ];
}
