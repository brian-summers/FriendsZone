import {
  BookOccurrenceInput,
  CancelHangoutInput,
  CreateHangoutInput,
  HangoutDecision,
  HangoutRequestId,
  isHangoutExpired,
  RescheduleHangoutInput,
  UpdateHangoutInput,
  type CalendarEvent,
  type EventId,
  type HangoutRequest,
  type InviteeResponse,
  type Notification,
  type NotificationKind,
  type SlotResponse,
  type TimeRange,
  type UserId,
} from '@friendszone/contracts';
import { assertAllowed, can, PolicyDeniedError } from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

const empty = z.object({});

/** Default lifetime for a request: a week is long enough not to feel like a deadline. */
const DEFAULT_TTL_DAYS = 7;

async function settleExpiry(
  repos: Repositories,
  request: HangoutRequest,
  now: string,
): Promise<HangoutRequest> {
  if (!isHangoutExpired(request, now)) return request;
  return repos.hangouts.save({ ...request, status: 'EXPIRED', updatedAt: now });
}

const settleAll = (repos: Repositories, requests: HangoutRequest[], now: string) =>
  Promise.all(requests.map((r) => settleExpiry(repos, r, now)));

const participantsOf = (r: HangoutRequest): UserId[] => [r.proposerId, ...r.inviteeIds];

/** Everyone on the hangout except `actorId` — who a notification is *for*. */
const othersThan = (r: HangoutRequest, actorId: UserId): UserId[] =>
  participantsOf(r).filter((id) => id !== actorId);

/** One participant's calendar copy of a booked hangout occurrence. */
function participantEvent(
  ownerId: UserId,
  participants: UserId[],
  request: HangoutRequest,
  slot: TimeRange,
  now: string,
): CalendarEvent {
  return {
    id: randomUUID() as EventId,
    ownerId,
    timeRange: slot,
    title: request.title,
    status: 'CONFIRMED',
    // Attendees always see FULL, so the two participants see each other's copy
    // in full while third parties fall back to each owner's own sharing default.
    visibilityCeiling: 'FULL',
    shareRules: [],
    attendeeIds: participants,
    // A booked hangout is a firm commitment — it exclusively blocks its slot.
    exclusive: true,
    originHangoutRequestId: request.id,
    createdAt: now,
    updatedAt: now,
    ...(request.note !== undefined ? { description: request.note } : {}),
    ...(request.location !== undefined ? { location: request.location } : {}),
  };
}

/**
 * Record a heads-up for the other party.
 *
 * There is no delivery here — see ADR 0007 and the `Notification` contract. The
 * message is composed and stored for the recipient to find; that is what
 * "notify them" honestly means without a real-time nudge.
 */
async function notify(
  repos: Repositories,
  args: {
    recipients: UserId[];
    actorId: UserId;
    kind: NotificationKind;
    request: HangoutRequest;
    summary: string;
    now: string;
  },
): Promise<void> {
  await Promise.all(
    args.recipients.map((recipientId) => {
      const notification: Notification = {
        id: randomUUID(),
        recipientId,
        actorId: args.actorId,
        kind: args.kind,
        hangoutId: args.request.id,
        summary: args.summary,
        createdAt: args.now,
      };
      return repos.notifications.create(notification);
    }),
  );
}

/** Load a hangout, settle its expiry, or throw the given denial if absent. */
async function loadOr(
  repos: Repositories,
  id: HangoutRequestId,
  denyReason: 'NOT_PARTICIPANT' | 'NOT_OWNER',
  action: string,
  now: string,
): Promise<HangoutRequest> {
  const found = await repos.hangouts.byId(id);
  if (found === null) throw new PolicyDeniedError(action, denyReason);
  return settleExpiry(repos, found, now);
}

export const buildHangoutRoutes = (repos: Repositories) => [
  /**
   * Propose a hangout to a friend — FIXED (candidate slots) or FLOATING (a
   * standing invitation over a period).
   *
   * `proposerId` is the session, never the body. The friendship requirement is
   * the anti-harassment boundary, checked in `can(..., 'hangout:send')`.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts',
    authz: { kind: 'POLICY', action: 'hangout:send' },
    params: empty,
    query: empty,
    body: CreateHangoutInput,
    handler: async (ctx): Promise<HangoutRequest> => {
      const proposerId = ctx.actorId;
      if (proposerId === null) throw new PolicyDeniedError('hangout:send', 'ANONYMOUS');

      const recipientId = ctx.body.inviteeId;
      const viewer = await ctx.viewerFor(recipientId);
      assertAllowed(can(viewer, { action: 'hangout:send', recipientId }));

      const now = new Date().toISOString();
      // A FLOATING invitation expires at the end of its period; a FIXED one uses
      // the supplied or default TTL.
      const expiresAt =
        ctx.body.kind === 'FLOATING'
          ? ctx.body.period!.end
          : ctx.body.expiresAt ??
            new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();

      const request: HangoutRequest = {
        id: randomUUID() as HangoutRequestId,
        proposerId,
        inviteeIds: [recipientId],
        kind: ctx.body.kind,
        title: ctx.body.title,
        proposedSlots: ctx.body.proposedSlots,
        status: 'PENDING',
        responses: [],
        resultingEventIds: [],
        expiresAt,
        createdAt: now,
        updatedAt: now,
        ...(ctx.body.note !== undefined ? { note: ctx.body.note } : {}),
        ...(ctx.body.location !== undefined ? { location: ctx.body.location } : {}),
        ...(ctx.body.period !== undefined ? { period: ctx.body.period } : {}),
        ...(ctx.body.occurrenceMinutes !== undefined
          ? { occurrenceMinutes: ctx.body.occurrenceMinutes }
          : {}),
      };

      return repos.hangouts.create(request);
    },
  }),

  /** Your inbox: requests other people sent you. */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/hangouts/received',
    authz: { kind: 'POLICY', action: 'hangout:respond' },
    params: empty,
    query: empty,
    handler: async (ctx): Promise<{ requests: HangoutRequest[] }> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:respond', 'ANONYMOUS');
      const now = new Date().toISOString();
      return { requests: await settleAll(repos, await repos.hangouts.received(ctx.actorId), now) };
    },
  }),

  /** Your outbox: requests you proposed, and where they stand. */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/hangouts/sent',
    authz: { kind: 'POLICY', action: 'hangout:withdraw' },
    params: empty,
    query: empty,
    handler: async (ctx): Promise<{ requests: HangoutRequest[] }> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:withdraw', 'ANONYMOUS');
      const now = new Date().toISOString();
      return { requests: await settleAll(repos, await repos.hangouts.sent(ctx.actorId), now) };
    },
  }),

  /**
   * Respond to a FIXED request you received: accept a slot, or decline.
   *
   * Accepting books the hangout on *both* calendars — the one sanctioned
   * cross-owner write (ADR 0010). Owner ids come from the stored request's
   * participants, never the body.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id/respond',
    authz: { kind: 'POLICY', action: 'hangout:respond' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: HangoutDecision,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:respond', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_PARTICIPANT', 'hangout:respond', now);

      // Counterparty is the proposer, so a block that appeared after sending
      // still denies — `can` short-circuits on BLOCKED.
      const viewer = await ctx.viewerFor(request.proposerId);
      assertAllowed(
        can(viewer, {
          action: 'hangout:respond',
          request: { inviteeIds: request.inviteeIds, status: request.status },
        }),
      );

      const responder = ctx.actorId;

      if (ctx.body.decision === 'DECLINE') {
        const response: InviteeResponse = {
          userId: responder,
          slots: [],
          respondedAt: now,
          ...(ctx.body.note !== undefined ? { note: ctx.body.note } : {}),
        };
        return repos.hangouts.save({
          ...request,
          status: 'DECLINED',
          responses: [...request.responses, response],
          updatedAt: now,
        });
      }

      const slot = request.proposedSlots[ctx.body.slotIndex];
      if (slot === undefined) throw new PolicyDeniedError('hangout:respond', 'WRONG_STATE');

      const participants = participantsOf(request);
      const created = await Promise.all(
        participants.map((ownerId) =>
          repos.calendar.create(participantEvent(ownerId, participants, request, slot, now)),
        ),
      );

      const chosen: SlotResponse = { slotIndex: ctx.body.slotIndex, preference: 'YES' };
      const response: InviteeResponse = { userId: responder, slots: [chosen], respondedAt: now };

      return repos.hangouts.save({
        ...request,
        status: 'ACCEPTED',
        responses: [...request.responses, response],
        resultingEventIds: created.map((e) => e.id),
        updatedAt: now,
      });
    },
  }),

  /** Read a single hangout you are a party to — used to manage it in place. */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/hangouts/:id',
    authz: { kind: 'POLICY', action: 'hangout:read' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:read', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_PARTICIPANT', 'hangout:read', now);
      assertAllowed(
        can(await ctx.viewerFor(request.proposerId), {
          action: 'hangout:read',
          request: { proposerId: request.proposerId, inviteeIds: request.inviteeIds },
        }),
      );
      return request;
    },
  }),

  /** Take back a request you sent, while it is still pending. */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id/withdraw',
    authz: { kind: 'POLICY', action: 'hangout:withdraw' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: empty,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:withdraw', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_OWNER', 'hangout:withdraw', now);

      const counterparty = request.inviteeIds[0] ?? request.proposerId;
      const viewer = await ctx.viewerFor(counterparty);
      assertAllowed(
        can(viewer, {
          action: 'hangout:withdraw',
          request: { proposerId: request.proposerId, status: request.status },
        }),
      );

      return repos.hangouts.save({ ...request, status: 'WITHDRAWN', updatedAt: now });
    },
  }),

  /**
   * Edit a hangout's descriptive properties. The organiser's right; if the
   * hangout is already confirmed, the change is mirrored onto both calendar
   * copies so the booked event stays in step.
   */
  defineRoute({
    method: 'PATCH',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id',
    authz: { kind: 'POLICY', action: 'hangout:update' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: UpdateHangoutInput,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:update', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_OWNER', 'hangout:update', now);

      const counterparty = request.inviteeIds[0] ?? request.proposerId;
      const viewer = await ctx.viewerFor(counterparty);
      assertAllowed(
        can(viewer, {
          action: 'hangout:update',
          request: { proposerId: request.proposerId, status: request.status },
        }),
      );

      const updated: HangoutRequest = {
        ...request,
        updatedAt: now,
        ...(ctx.body.title !== undefined ? { title: ctx.body.title } : {}),
        ...(ctx.body.note !== undefined ? { note: ctx.body.note } : {}),
        ...(ctx.body.location !== undefined ? { location: ctx.body.location } : {}),
      };

      // Mirror onto any booked events so the calendar copies stay accurate.
      await Promise.all(
        request.resultingEventIds.map(async (eventId) => {
          const ev = await repos.calendar.eventById(eventId);
          if (ev === null) return;
          await repos.calendar.update({
            ...ev,
            title: updated.title,
            updatedAt: now,
            ...(updated.note !== undefined ? { description: updated.note } : {}),
            ...(updated.location !== undefined ? { location: updated.location } : {}),
          });
        }),
      );

      if (ctx.body.notify) {
        await notify(repos, {
          recipients: othersThan(request, ctx.actorId),
          actorId: ctx.actorId,
          kind: 'HANGOUT_UPDATED',
          request: updated,
          summary: `Updated the details of “${updated.title}”.`,
          now,
        });
      }

      return repos.hangouts.save(updated);
    },
  }),

  /**
   * Move a hangout in time.
   *
   * A still-pending FIXED request gets fresh proposed slots — a re-ask. A
   * confirmed one is re-booked to a single new time on both calendars, and the
   * other party is notified so they can bow out if it no longer works.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id/reschedule',
    authz: { kind: 'POLICY', action: 'hangout:reschedule' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: RescheduleHangoutInput,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:reschedule', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_OWNER', 'hangout:reschedule', now);

      const counterparty = request.inviteeIds[0] ?? request.proposerId;
      const viewer = await ctx.viewerFor(counterparty);
      assertAllowed(
        can(viewer, {
          action: 'hangout:reschedule',
          request: { proposerId: request.proposerId, status: request.status },
        }),
      );

      // Floating invitations have no single time to move; edit the period via
      // a future capability instead of overloading reschedule.
      if (request.kind === 'FLOATING') {
        throw new PolicyDeniedError('hangout:reschedule', 'WRONG_STATE');
      }

      if (request.status === 'PENDING') {
        // Re-ask: swap the candidate slots, stay pending.
        return repos.hangouts.save({
          ...request,
          proposedSlots: ctx.body.proposedSlots,
          updatedAt: now,
        });
      }

      // Confirmed: re-book both copies to the new time.
      const newSlot = ctx.body.proposedSlots[0]!;
      await Promise.all(
        request.resultingEventIds.map(async (eventId) => {
          const ev = await repos.calendar.eventById(eventId);
          if (ev === null) return;
          await repos.calendar.update({ ...ev, timeRange: newSlot, updatedAt: now });
        }),
      );

      const moved = { ...request, updatedAt: now };
      if (ctx.body.notify) {
        await notify(repos, {
          recipients: othersThan(request, ctx.actorId),
          actorId: ctx.actorId,
          kind: 'HANGOUT_RESCHEDULED',
          request: moved,
          summary: `Moved “${request.title}” to a new time.`,
          now,
        });
      }
      return repos.hangouts.save(moved);
    },
  }),

  /**
   * Cancel a confirmed hangout. Either participant may call it off; both
   * calendar copies are marked cancelled, and the other party is notified when
   * asked.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id/cancel',
    authz: { kind: 'POLICY', action: 'hangout:cancel' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: CancelHangoutInput,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:cancel', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_PARTICIPANT', 'hangout:cancel', now);

      const counterparty =
        ctx.actorId === request.proposerId
          ? request.inviteeIds[0] ?? request.proposerId
          : request.proposerId;
      const viewer = await ctx.viewerFor(counterparty);
      assertAllowed(
        can(viewer, {
          action: 'hangout:cancel',
          request: {
            proposerId: request.proposerId,
            inviteeIds: request.inviteeIds,
            status: request.status,
          },
        }),
      );

      await Promise.all(
        request.resultingEventIds.map(async (eventId) => {
          const ev = await repos.calendar.eventById(eventId);
          if (ev === null) return;
          await repos.calendar.update({ ...ev, status: 'CANCELLED', updatedAt: now });
        }),
      );

      const cancelled = { ...request, status: 'CANCELLED' as const, updatedAt: now };
      if (ctx.body.notify) {
        await notify(repos, {
          recipients: othersThan(request, ctx.actorId),
          actorId: ctx.actorId,
          kind: 'HANGOUT_CANCELLED',
          request: cancelled,
          summary: ctx.body.reason
            ? `Cancelled “${request.title}”: ${ctx.body.reason}`
            : `Cancelled “${request.title}”.`,
          now,
        });
      }
      return repos.hangouts.save(cancelled);
    },
  }),

  /**
   * Book one occurrence of a FLOATING hangout. Either party picks a start time
   * within the period; a pair of events is added to both calendars, and the
   * invitation stays open for more.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/hangouts/:id/book',
    authz: { kind: 'POLICY', action: 'hangout:book' },
    params: z.object({ id: HangoutRequestId }),
    query: empty,
    body: BookOccurrenceInput,
    handler: async (ctx): Promise<HangoutRequest> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('hangout:book', 'ANONYMOUS');
      const now = new Date().toISOString();
      const request = await loadOr(repos, ctx.params.id, 'NOT_PARTICIPANT', 'hangout:book', now);

      const counterparty =
        ctx.actorId === request.proposerId
          ? request.inviteeIds[0] ?? request.proposerId
          : request.proposerId;
      const viewer = await ctx.viewerFor(counterparty);
      assertAllowed(
        can(viewer, {
          action: 'hangout:book',
          request: {
            proposerId: request.proposerId,
            inviteeIds: request.inviteeIds,
            status: request.status,
            kind: request.kind,
          },
        }),
      );

      // The occurrence must fall inside the invitation's period.
      const durationMs = (request.occurrenceMinutes ?? 60) * 60_000;
      const start = Date.parse(ctx.body.start);
      const end = start + durationMs;
      const period = request.period;
      if (
        period === undefined ||
        start < Date.parse(period.start) ||
        end > Date.parse(period.end)
      ) {
        throw new PolicyDeniedError('hangout:book', 'WRONG_STATE');
      }

      const slot: TimeRange = {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      };
      const participants = participantsOf(request);
      const created = await Promise.all(
        participants.map((ownerId) =>
          repos.calendar.create(participantEvent(ownerId, participants, request, slot, now)),
        ),
      );

      // Stays PENDING — a floating invitation can be booked again.
      return repos.hangouts.save({
        ...request,
        resultingEventIds: [...request.resultingEventIds, ...created.map((e) => e.id)],
        updatedAt: now,
      });
    },
  }),

  /** Your notifications. Yours alone — the port scopes to the actor. */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/notifications',
    authz: { kind: 'POLICY', action: 'notifications:read' },
    params: empty,
    query: empty,
    handler: async (ctx): Promise<{ notifications: Notification[] }> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('notifications:read', 'ANONYMOUS');
      assertAllowed(can(await ctx.viewerFor(ctx.actorId), { action: 'notifications:read' }));
      return { notifications: await repos.notifications.forUser(ctx.actorId) };
    },
  }),
];
