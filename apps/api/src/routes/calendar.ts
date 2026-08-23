import {
  CreateEventInput,
  EventId,
  Instant,
  isHangoutExpired,
  presetOf,
  SharingDefaults,
  UpdateEventInput,
  UserId,
  type CalendarEvent,
  type CalendarView,
  type EventFullView,
  type EventView,
  type HangoutHold,
  type SharingDefaults as SharingDefaultsType,
  type SharingDefaultsView as SharingDefaultsViewType,
  type TimeRange,
  UpdateQuietHoursInput,
  type QuietHours,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  deriveHangoutHolds,
  PolicyDeniedError,
  projectCalendar,
  projectEvent,
  resolveEventVisibility,
  widestSharedLevel,
  type ViewerContext,
} from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import { ValidationError } from '../http/errors.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * A window must be bounded and modest. An unbounded range is both a denial of
 * service vector and a bulk-export vector: "give me every event you will ever
 * let me see" is a scraping request wearing a calendar's clothes.
 */
const MAX_WINDOW_DAYS = 62;

const CalendarQuery = z
  .object({ start: Instant, end: Instant })
  .refine((q) => Date.parse(q.end) > Date.parse(q.start), {
    message: 'end must be after start',
    path: ['end'],
  })
  .refine(
    (q) => Date.parse(q.end) - Date.parse(q.start) <= MAX_WINDOW_DAYS * 86_400_000,
    { message: `window may not exceed ${MAX_WINDOW_DAYS} days`, path: ['end'] },
  );

/**
 * Read another user's calendar.
 *
 * This is the endpoint the whole privacy model exists to protect, so it is
 * worth being explicit about the division of labour:
 *
 *  - `can(..., 'calendar:view')` is a coarse gate. It only rejects blocked
 *    viewers; everyone else is allowed to *ask*.
 *  - `projectCalendar` decides, per event, what actually comes back.
 *
 * That split is why a stranger gets `200 {busy: [], details: []}` rather than a
 * 403. A 403 would confirm the account exists; an empty calendar is
 * indistinguishable from a real user with nothing scheduled.
 */
export const buildCalendarRoutes = (repos: Repositories) => {
  // Tentative holds for `ownerId`'s calendar as seen by `viewer`. Kept next to
  // the read handlers because both need it identically. Expired-but-unsettled
  // requests are filtered out so a stale hold never lingers on the calendar.
  const holdsFor = async (
    ownerId: UserId,
    viewer: ViewerContext,
    window: TimeRange,
  ): Promise<HangoutHold[]> => {
    const now = new Date().toISOString();
    const pending = (await repos.hangouts.pendingInvolving(ownerId)).filter(
      (r) => !isHangoutExpired(r, now),
    );
    return deriveHangoutHolds({ ownerId, viewer, requests: pending, window });
  };

  /**
   * Project a stored event as its own owner - a FULL view carrying every
   * owner-only field (sharedAs, the raw rules, the ceiling). The one shape a
   * create/update response should return, so the client can immediately edit
   * what it just wrote.
   */
  const ownerFullView = (
    stored: CalendarEvent,
    ownerDefaults: SharingDefaultsType,
  ): EventFullView => {
    const projection = projectEvent(stored, 'FULL');
    if (projection.kind !== 'DETAIL' || projection.view.visibility !== 'FULL') {
      throw new Error('event did not project to a full owner view');
    }
    return {
      ...projection.view,
      sharedAs: widestSharedLevel(stored, ownerDefaults),
      shareRules: stored.shareRules.map((r) => ({ ...r })),
      ownVisibilityCeiling: stored.visibilityCeiling,
    };
  };

  return [
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/users/:ownerId/calendar',
    authz: { kind: 'POLICY', action: 'calendar:view' },
    params: z.object({ ownerId: UserId }),
    query: CalendarQuery,
    handler: async (ctx): Promise<CalendarView> => {
      const ownerId = ctx.params.ownerId;
      const window: TimeRange = { start: ctx.query.start, end: ctx.query.end };

      // Rebuilt for this specific owner. Never hoisted out of the handler.
      const viewer = await ctx.viewerFor(ownerId);
      assertAllowed(can(viewer, { action: 'calendar:view', ownerId }));

      const [events, ownerDefaults, holds] = await Promise.all([
        repos.calendar.eventsInWindow(ownerId, window),
        repos.calendar.sharingDefaults(ownerId),
        holdsFor(ownerId, viewer, window),
      ]);

      const ownerQuietHours = await repos.calendar.quietHours(ownerId);
      return {
        ...projectCalendar({ ownerId, events, viewer, ownerDefaults, window, ownerQuietHours }),
        holds,
      };
    },
  }),

  /**
   * Free/busy only. Same data source, same engine, but the response contract
   * carries no detail fields at all, so a client asking "when are they free?"
   * cannot accidentally receive titles it did not need.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/users/:ownerId/availability',
    authz: { kind: 'POLICY', action: 'calendar:view' },
    params: z.object({ ownerId: UserId }),
    query: CalendarQuery,
    handler: async (ctx) => {
      const ownerId = ctx.params.ownerId;
      const window: TimeRange = { start: ctx.query.start, end: ctx.query.end };

      const viewer = await ctx.viewerFor(ownerId);
      assertAllowed(can(viewer, { action: 'calendar:view', ownerId }));

      const [events, ownerDefaults] = await Promise.all([
        repos.calendar.eventsInWindow(ownerId, window),
        repos.calendar.sharingDefaults(ownerId),
      ]);

      // Availability is strictly free/busy: no details, and no holds. A pending
      // hangout is a maybe, not a commitment, so it must not narrow free time.
      // Availability deliberately omits quiet hours: this endpoint answers
      // "when are they busy?", and a quiet hour is not busy. The full calendar
      // view carries them for rendering; the free/busy contract has no field.
      const view = projectCalendar({ ownerId, events, viewer, ownerDefaults, window });
      return { ownerId: view.ownerId, window: view.window, busy: view.busy };
    },
  }),

  /**
   * The sharing checkup: "what does Bob actually see of my week?"
   *
   * Note the shape of the request. It carries *whose eyes* to borrow, and never
   * *whose calendar* - the calendar is always the caller's own. Adding an owner
   * parameter here would turn this endpoint into a complete bypass of the
   * visibility model, which is why the policy case for `calendar:preview`
   * asserts ownership rather than trusting the route.
   *
   * The preview is produced by the same `projectCalendar` the real endpoint
   * uses. It is not an approximation of what Bob would see; it is what Bob
   * would see.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/me/calendar/preview',
    authz: { kind: 'POLICY', action: 'calendar:preview' },
    params: z.object({}),
    query: z.intersection(CalendarQuery, z.object({ viewerId: UserId })),
    handler: async (ctx): Promise<CalendarView> => {
      const ownerId = ctx.actorId;
      if (ownerId === null) {
        throw new PolicyDeniedError('calendar:preview', 'ANONYMOUS');
      }

      const self = await ctx.viewerFor(ownerId);
      assertAllowed(can(self, { action: 'calendar:preview', ownerId }));

      const asViewerId = ctx.query.viewerId;
      const window: TimeRange = { start: ctx.query.start, end: ctx.query.end };

      // Built by hand rather than via ctx.viewerFor, because the pair is
      // inverted here: the *other* person is the viewer and the caller is the
      // owner. Getting this backwards would silently show the caller their own
      // calendar and call it a preview.
      const [relationship, sharedCircleIds] = await Promise.all([
        repos.social.relationship(asViewerId, ownerId),
        repos.social.sharedCircles(asViewerId, ownerId),
      ]);
      const asViewer: ViewerContext = {
        viewerId: asViewerId,
        relationship,
        sharedCircleIds,
        // Never inherited from the caller, and never looked up: moderation
        // grants no visibility exemption, so a preview "as a moderator" would
        // be both meaningless and a way to ask a question we do not answer.
        isModerator: false,
      };

      const [events, ownerDefaults, holds] = await Promise.all([
        repos.calendar.eventsInWindow(ownerId, window),
        repos.calendar.sharingDefaults(ownerId),
        // Faithful to what the previewed viewer would see: holds for requests
        // between them and you. `deriveHangoutHolds` scopes to participants.
        holdsFor(ownerId, asViewer, window),
      ]);

      return {
        ...projectCalendar({
          ownerId,
          events,
          viewer: asViewer,
          ownerDefaults,
          window,
          ownerQuietHours: await repos.calendar.quietHours(ownerId),
        }),
        holds,
      };
    },
  }),

  /**
   * Create an event on your own calendar.
   *
   * The security-relevant line is `ownerId: actorId`. The owner is taken from
   * the authenticated session and the request body's opinion on the matter, if
   * any, is discarded - `CreateEventInput` has no `ownerId` field to supply. So
   * "create an event on someone else's calendar" is not a request that can be
   * expressed, let alone one the policy has to refuse.
   *
   * The response is the event projected back for its own creator, so the client
   * receives exactly the same shape it renders from a calendar read, `sharedAs`
   * and all - never the raw stored row.
   */
  defineRoute({
    method: 'POST',
    rateLimit: 'WRITE',
    url: '/v1/events',
    authz: { kind: 'POLICY', action: 'event:create' },
    params: z.object({}),
    query: z.object({}),
    body: CreateEventInput,
    handler: async (ctx): Promise<EventView> => {
      const actorId = ctx.actorId;
      if (actorId === null) {
        throw new PolicyDeniedError('event:create', 'ANONYMOUS');
      }

      const viewer = await ctx.viewerFor(actorId);
      assertAllowed(can(viewer, { action: 'event:create', ownerId: actorId }));

      const now = new Date().toISOString();
      const event: CalendarEvent = {
        id: randomUUID() as EventId,
        ownerId: actorId, // ← from the session, never the body
        timeRange: ctx.body.timeRange,
        title: ctx.body.title,
        status: ctx.body.status,
        visibilityCeiling: ctx.body.visibilityCeiling,
        shareRules: ctx.body.shareRules,
        attendeeIds: ctx.body.attendeeIds,
        exclusive: ctx.body.exclusive,
        createdAt: now,
        updatedAt: now,
        ...(ctx.body.description !== undefined ? { description: ctx.body.description } : {}),
        ...(ctx.body.location !== undefined ? { location: ctx.body.location } : {}),
      };

      const stored = await repos.calendar.create(event);
      // Return it as the owner would see it - FULL, with its editable rules.
      return ownerFullView(stored, await repos.calendar.sharingDefaults(actorId));
    },
  }),

  /**
   * Edit an event you own - including its sharing rules (the per-event sharing
   * editor is just this route carrying new `shareRules`/`visibilityCeiling`).
   *
   * Ownership is the gate (`event:modify`), and a hangout-origin event is
   * refused: it is managed through its hangout so the two copies never drift.
   */
  defineRoute({
    method: 'PATCH',
    rateLimit: 'WRITE',
    url: '/v1/events/:id',
    authz: { kind: 'POLICY', action: 'event:modify' },
    params: z.object({ id: EventId }),
    query: z.object({}),
    body: UpdateEventInput,
    handler: async (ctx): Promise<EventFullView> => {
      const actorId = ctx.actorId;
      if (actorId === null) throw new PolicyDeniedError('event:modify', 'ANONYMOUS');

      const existing = await repos.calendar.eventById(ctx.params.id);
      // Unknown id and not-yours collapse to the same 404 upstream.
      if (existing === null) throw new PolicyDeniedError('event:modify', 'NOT_OWNER');

      const viewer = await ctx.viewerFor(existing.ownerId);
      assertAllowed(can(viewer, { action: 'event:modify', event: { ownerId: existing.ownerId } }));

      if (existing.originHangoutRequestId !== undefined) {
        // Manage hangout events through their hangout, not here.
        throw new PolicyDeniedError('event:modify', 'WRONG_STATE');
      }

      const now = new Date().toISOString();
      const updated: CalendarEvent = {
        ...existing,
        updatedAt: now,
        ...(ctx.body.timeRange !== undefined ? { timeRange: ctx.body.timeRange } : {}),
        ...(ctx.body.title !== undefined ? { title: ctx.body.title } : {}),
        ...(ctx.body.description !== undefined ? { description: ctx.body.description } : {}),
        ...(ctx.body.location !== undefined ? { location: ctx.body.location } : {}),
        ...(ctx.body.status !== undefined ? { status: ctx.body.status } : {}),
        ...(ctx.body.visibilityCeiling !== undefined
          ? { visibilityCeiling: ctx.body.visibilityCeiling }
          : {}),
        ...(ctx.body.shareRules !== undefined ? { shareRules: ctx.body.shareRules } : {}),
        ...(ctx.body.exclusive !== undefined ? { exclusive: ctx.body.exclusive } : {}),
      };

      const stored = await repos.calendar.update(updated);
      return ownerFullView(stored, await repos.calendar.sharingDefaults(actorId));
    },
  }),

  /** Delete an event you own. Hangout events are cancelled via their hangout. */
  defineRoute({
    method: 'DELETE',
    rateLimit: 'WRITE',
    url: '/v1/events/:id',
    authz: { kind: 'POLICY', action: 'event:modify' },
    params: z.object({ id: EventId }),
    query: z.object({}),
    body: z.object({}),
    handler: async (ctx): Promise<{ deleted: true }> => {
      const actorId = ctx.actorId;
      if (actorId === null) throw new PolicyDeniedError('event:modify', 'ANONYMOUS');

      const existing = await repos.calendar.eventById(ctx.params.id);
      if (existing === null) throw new PolicyDeniedError('event:modify', 'NOT_OWNER');

      const viewer = await ctx.viewerFor(existing.ownerId);
      assertAllowed(can(viewer, { action: 'event:modify', event: { ownerId: existing.ownerId } }));

      if (existing.originHangoutRequestId !== undefined) {
        throw new PolicyDeniedError('event:modify', 'WRONG_STATE');
      }

      await repos.calendar.remove(existing.id);
      return { deleted: true };
    },
  }),

  /**
   * Your recurring unavailable window.
   *
   * Gated on `sharing:manage` rather than a new action: it is the same kind of
   * thing, a standing rule over every future request rather than a decision
   * about one, and it is equally self-scoped.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/me/quiet-hours',
    authz: { kind: 'POLICY', action: 'sharing:manage' },
    params: z.object({}),
    query: z.object({}),
    handler: async (ctx): Promise<{ quietHours: QuietHours | null }> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('sharing:manage', 'ANONYMOUS');
      assertAllowed(can(await ctx.viewerFor(ctx.actorId), { action: 'sharing:manage' }));
      return { quietHours: await repos.calendar.quietHours(ctx.actorId) };
    },
  }),

  defineRoute({
    method: 'PUT',
    rateLimit: 'WRITE',
    url: '/v1/me/quiet-hours',
    authz: { kind: 'POLICY', action: 'sharing:manage' },
    params: z.object({}),
    query: z.object({}),
    body: UpdateQuietHoursInput,
    handler: async (ctx): Promise<{ quietHours: QuietHours | null }> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('sharing:manage', 'ANONYMOUS');
      assertAllowed(can(await ctx.viewerFor(ctx.actorId), { action: 'sharing:manage' }));

      await repos.calendar.setQuietHours(ctx.actorId, ctx.body.quietHours);
      return { quietHours: ctx.body.quietHours };
    },
  }),

  /** Read your own baseline sharing policy. */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/me/sharing-defaults',
    authz: { kind: 'POLICY', action: 'sharing:manage' },
    params: z.object({}),
    query: z.object({}),
    handler: async (ctx): Promise<SharingDefaultsViewType> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('sharing:manage', 'ANONYMOUS');
      assertAllowed(can(await ctx.viewerFor(ctx.actorId), { action: 'sharing:manage' }));

      const [defaults, chosen] = await Promise.all([
        repos.calendar.sharingDefaults(ctx.actorId),
        repos.calendar.hasExplicitSharingDefaults(ctx.actorId),
      ]);
      // `chosen: false` means they are on the conservative fallback and have
      // never said so themselves - which is what onboarding asks about.
      return { rules: defaults.rules, preset: presetOf(defaults), chosen };
    },
  }),

  /** Replace your own baseline sharing policy - the most-used privacy control. */
  defineRoute({
    method: 'PUT',
    rateLimit: 'WRITE',
    url: '/v1/me/sharing-defaults',
    authz: { kind: 'POLICY', action: 'sharing:manage' },
    params: z.object({}),
    query: z.object({}),
    body: SharingDefaults,
    handler: async (ctx): Promise<SharingDefaultsViewType> => {
      if (ctx.actorId === null) throw new PolicyDeniedError('sharing:manage', 'ANONYMOUS');
      assertAllowed(can(await ctx.viewerFor(ctx.actorId), { action: 'sharing:manage' }));
      const saved = await repos.calendar.setSharingDefaults(ctx.actorId, ctx.body);
      // Saving anything - preset or custom - is the choice being made.
      return { rules: saved.rules, preset: presetOf(saved), chosen: true };
    },
  }),
  ];
};

/** Re-exported so route tests can assert on the window cap. */
export const __test = { CalendarQuery, MAX_WINDOW_DAYS, ValidationError };
