import {
  CreateEventInput,
  Instant,
  isHangoutExpired,
  UserId,
  type CalendarEvent,
  type CalendarView,
  type EventId,
  type EventView,
  type HangoutHold,
  type TimeRange,
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

  return [
  defineRoute({
    method: 'GET',
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

      return { ...projectCalendar({ ownerId, events, viewer, ownerDefaults, window }), holds };
    },
  }),

  /**
   * Free/busy only. Same data source, same engine, but the response contract
   * carries no detail fields at all, so a client asking "when are they free?"
   * cannot accidentally receive titles it did not need.
   */
  defineRoute({
    method: 'GET',
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
      const view = projectCalendar({ ownerId, events, viewer, ownerDefaults, window });
      return { ownerId: view.ownerId, window: view.window, busy: view.busy };
    },
  }),

  /**
   * The sharing checkup: "what does Bob actually see of my week?"
   *
   * Note the shape of the request. It carries *whose eyes* to borrow, and never
   * *whose calendar* — the calendar is always the caller's own. Adding an owner
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
      const asViewer: ViewerContext = { viewerId: asViewerId, relationship, sharedCircleIds };

      const [events, ownerDefaults, holds] = await Promise.all([
        repos.calendar.eventsInWindow(ownerId, window),
        repos.calendar.sharingDefaults(ownerId),
        // Faithful to what the previewed viewer would see: holds for requests
        // between them and you. `deriveHangoutHolds` scopes to participants.
        holdsFor(ownerId, asViewer, window),
      ]);

      return {
        ...projectCalendar({ ownerId, events, viewer: asViewer, ownerDefaults, window }),
        holds,
      };
    },
  }),

  /**
   * Create an event on your own calendar.
   *
   * The security-relevant line is `ownerId: actorId`. The owner is taken from
   * the authenticated session and the request body's opinion on the matter, if
   * any, is discarded — `CreateEventInput` has no `ownerId` field to supply. So
   * "create an event on someone else's calendar" is not a request that can be
   * expressed, let alone one the policy has to refuse.
   *
   * The response is the event projected back for its own creator, so the client
   * receives exactly the same shape it renders from a calendar read, `sharedAs`
   * and all — never the raw stored row.
   */
  defineRoute({
    method: 'POST',
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
        openToConflict: ctx.body.openToConflict,
        createdAt: now,
        updatedAt: now,
        ...(ctx.body.description !== undefined ? { description: ctx.body.description } : {}),
        ...(ctx.body.location !== undefined ? { location: ctx.body.location } : {}),
      };

      const stored = await repos.calendar.create(event);

      // Project it back through the same engine, as its owner, so the wire
      // shape is a normal EventView. The owner always resolves to FULL.
      const ownerDefaults = await repos.calendar.sharingDefaults(actorId);
      const level = resolveEventVisibility(stored, viewer, ownerDefaults);
      const projection = projectEvent(stored, level);
      if (projection.kind !== 'DETAIL' || projection.view.visibility !== 'FULL') {
        // Unreachable: an owner sees their own event at FULL. Fail loudly
        // rather than inventing a response if that invariant ever breaks.
        throw new Error('created event did not project to a full owner view');
      }
      // Attach the same who-can-see-this annotation a calendar read would carry.
      return { ...projection.view, sharedAs: widestSharedLevel(stored, ownerDefaults) };
    },
  }),
  ];
};

/** Re-exported so route tests can assert on the window cap. */
export const __test = { CalendarQuery, MAX_WINDOW_DAYS, ValidationError };
