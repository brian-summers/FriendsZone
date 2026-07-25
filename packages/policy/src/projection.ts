import {
  overlaps,
  type BusyBlock,
  type CalendarEvent,
  type CalendarView,
  type EventView,
  type HangoutHold,
  type HangoutRequest,
  type Instant,
  type SharingDefaults,
  type TimeRange,
  type UserId,
  type VisibilityLevel,
} from '@friendszone/contracts';
import { assertNever, type ViewerContext } from './viewer.js';
import { resolveEventVisibility, widestSharedLevel } from './visibility.js';

/**
 * The result of narrowing one stored event down to what one viewer may see.
 * Modelled as a union so that "this viewer gets nothing" is a value the type
 * system forces callers to handle, rather than a `null` that is easy to forget.
 */
export type EventProjection =
  | { readonly kind: 'HIDDEN' }
  | { readonly kind: 'BUSY'; readonly range: TimeRange }
  | { readonly kind: 'DETAIL'; readonly view: EventView };

/**
 * Build the viewer's copy of an event at a resolved visibility level.
 *
 * This function is the only sanctioned way to turn a `CalendarEvent` into
 * something that crosses the network boundary. It is written as a whitelist —
 * each level names the fields it emits — so that adding a field to
 * `CalendarEvent` cannot leak it by default. A spread of `...event` anywhere in
 * this file would be a security bug; adding one should fail review.
 */
export function projectEvent(event: CalendarEvent, level: VisibilityLevel): EventProjection {
  switch (level) {
    case 'HIDDEN':
      return { kind: 'HIDDEN' };

    case 'BUSY':
      return { kind: 'BUSY', range: event.timeRange };

    case 'TITLE':
      return {
        kind: 'DETAIL',
        view: {
          visibility: 'TITLE',
          id: event.id,
          ownerId: event.ownerId,
          timeRange: event.timeRange,
          title: event.title,
          status: event.status,
          openToConflict: event.openToConflict,
        },
      };

    case 'FULL':
      return {
        kind: 'DETAIL',
        view: {
          visibility: 'FULL',
          id: event.id,
          ownerId: event.ownerId,
          timeRange: event.timeRange,
          title: event.title,
          status: event.status,
          attendeeIds: [...event.attendeeIds],
          openToConflict: event.openToConflict,
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.location !== undefined ? { location: event.location } : {}),
          ...(event.originHangoutRequestId !== undefined
            ? { originHangoutRequestId: event.originHangoutRequestId }
            : {}),
        },
      };

    default:
      return assertNever(level, 'projectEvent');
  }
}

const laterOf = (a: Instant, b: Instant): Instant => (Date.parse(a) >= Date.parse(b) ? a : b);
const earlierOf = (a: Instant, b: Instant): Instant => (Date.parse(a) <= Date.parse(b) ? a : b);

/** Intersect a range with the requested window. Assumes they overlap. */
const clipToWindow = (range: TimeRange, window: TimeRange): TimeRange => ({
  start: laterOf(range.start, window.start),
  end: earlierOf(range.end, window.end),
});

/**
 * Collapse busy intervals into the smallest equivalent set.
 *
 * Adjacent intervals are merged, not just overlapping ones: if a viewer can see
 * that you are busy 09:00–10:00 and 10:00–11:00, the boundary at 10:00 tells
 * them you have two separate commitments rather than one. Merging on `<=`
 * erases that, and the resulting free/busy answer is identical.
 */
export function mergeBusyBlocks(ranges: readonly TimeRange[]): BusyBlock[] {
  const sorted = [...ranges].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const merged: BusyBlock[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Date.parse(range.start) <= Date.parse(last.end)) {
      merged[merged.length - 1] = { start: last.start, end: laterOf(last.end, range.end) };
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }

  return merged;
}

/**
 * Produce the calendar one viewer is allowed to see for one owner and window.
 *
 * Every event the owner has in the window goes through the visibility engine
 * individually; there is no bulk shortcut and no "the viewer is a friend, send
 * everything" fast path.
 *
 * Two behaviours here are privacy decisions rather than convenience:
 *
 *  - Cancelled events are dropped entirely, for everyone but the owner. A
 *    cancellation is information ("they freed up that evening") and it is not
 *    the viewer's to have.
 *  - Busy blocks are clipped to the requested window before merging, so that
 *    querying a narrow window cannot reveal how far past its edges a commitment
 *    extends. Detail views are *not* clipped, because a viewer authorised to
 *    see the event is authorised to see its real extent.
 */
export function projectCalendar(args: {
  ownerId: UserId;
  events: readonly CalendarEvent[];
  viewer: ViewerContext;
  ownerDefaults: SharingDefaults;
  window: TimeRange;
}): CalendarView {
  const { ownerId, events, viewer, ownerDefaults, window } = args;

  const isOwner = viewer.viewerId !== null && viewer.viewerId === ownerId;
  const busyRanges: TimeRange[] = [];
  const openRanges: TimeRange[] = [];
  const details: EventView[] = [];

  for (const event of events) {
    // Defence in depth: a repository bug that mixes owners must not become a
    // disclosure. The engine refuses rather than trusting its caller.
    if (event.ownerId !== ownerId) {
      throw new Error('projectCalendar received an event belonging to another owner');
    }

    if (event.status === 'CANCELLED' && !isOwner) continue;
    if (!overlaps(event.timeRange, window)) continue;

    // An open-to-conflict event occupies time but does not *block* it: its time
    // goes to openBlocks (soft, requestable) rather than busy (hard).
    const occupies = event.openToConflict ? openRanges : busyRanges;

    const level = resolveEventVisibility(event, viewer, ownerDefaults);
    const projection = projectEvent(event, level);

    switch (projection.kind) {
      case 'HIDDEN':
        continue;
      case 'BUSY':
        occupies.push(clipToWindow(projection.range, window));
        continue;
      case 'DETAIL': {
        // Visible events also occupy time. Including them in busy/openBlocks
        // keeps free/slot-finding correct for clients that read those alone.
        occupies.push(clipToWindow(projection.view.timeRange, window));

        // Owner-only annotation: the widest level anyone else could see, so the
        // client can render a who-can-see-this badge. Set *only* on the owner's
        // own view — a non-owner reaching FULL (attendee, explicit grant) never
        // gets it, which projection.test.ts asserts.
        if (isOwner && projection.view.visibility === 'FULL') {
          details.push({
            ...projection.view,
            sharedAs: widestSharedLevel(event, ownerDefaults),
            // Owner-only: the event's own rules, so the sharing editor can load
            // and change them. Never sent to anyone but the owner.
            shareRules: event.shareRules.map((r) => ({ ...r })),
            ownVisibilityCeiling: event.visibilityCeiling,
          });
        } else {
          details.push(projection.view);
        }
        continue;
      }
      default:
        return assertNever(projection, 'projectCalendar');
    }
  }

  return {
    ownerId,
    window,
    busy: mergeBusyBlocks(busyRanges),
    openBlocks: mergeBusyBlocks(openRanges),
    details,
    // Filled by `deriveHangoutHolds` at the route, which has the pending
    // requests. The engine has no hangout knowledge, so it emits none here.
    holds: [],
  };
}

/**
 * Turn pending hangout requests into tentative holds for one calendar view.
 *
 * This is participant-scoped access control expressed as a projection, which is
 * why it lives in the security kernel rather than the route: a hold is emitted
 * only when **both** the calendar's owner and the viewer are parties to the
 * request. That guarantee is what makes it safe for a hold to carry its full
 * title — it is never shown to anyone who was not already entitled to the
 * request's contents.
 *
 * `role` is the viewer's, so the client can offer the right action (an invitee
 * accepts or declines; a proposer withdraws) without a second lookup.
 *
 * Callers pass requests already narrowed to "pending and involving the owner";
 * the owner check here is defence in depth against a mis-scoped query.
 */
export function deriveHangoutHolds(args: {
  ownerId: UserId;
  viewer: ViewerContext;
  requests: readonly HangoutRequest[];
  window: TimeRange;
}): HangoutHold[] {
  const { ownerId, viewer, requests, window } = args;
  const viewerId = viewer.viewerId;
  if (viewerId === null) return [];

  const holds: HangoutHold[] = [];

  for (const request of requests) {
    if (request.status !== 'PENDING') continue;

    const participants = [request.proposerId, ...request.inviteeIds];
    // Both parties must be on the request. Owner-not-participant would be a
    // caller bug; viewer-not-participant would be a disclosure.
    if (!participants.includes(ownerId) || !participants.includes(viewerId)) continue;

    const role = viewerId === request.proposerId ? 'PROPOSER' : 'INVITEE';
    const inviteeId = request.inviteeIds[0];
    if (inviteeId === undefined) continue;

    request.proposedSlots.forEach((slot, slotIndex) => {
      if (!overlaps(slot, window)) return;
      holds.push({
        requestId: request.id,
        slotIndex,
        timeRange: slot,
        title: request.title,
        proposerId: request.proposerId,
        inviteeId,
        role,
        expiresAt: request.expiresAt,
      });
    });
  }

  return holds;
}
