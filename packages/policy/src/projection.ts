import {
  overlaps,
  type BusyBlock,
  type CalendarEvent,
  type CalendarView,
  type Claim,
  type EventView,
  type Exchange,
  type ExchangeView,
  type HangoutHold,
  type HangoutRequest,
  type Instant,
  type Listing,
  type ListingView,
  type ModerationQueueRow,
  type ModeratorReportView,
  type NoteAudience,
  type NoteView,
  type OwnClaimView,
  type OwnerClaimView,
  type Report,
  type ReporterReportView,
  type ReportNote,
  type SharingDefaults,
  type SubjectReportView,
  type TimeRange,
  type UserId,
  type VisibilityLevel,
} from '@friendszone/contracts';
import { can } from './actions.js';
import { assertNever, isSelf, type ViewerContext } from './viewer.js';
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
          exclusive: event.exclusive,
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
          exclusive: event.exclusive,
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

    // Events overlap by default: a non-exclusive event occupies time but does
    // not *block* it, so its time goes to openBlocks (soft, requestable,
    // overlappable). Only an event explicitly made exclusive hard-blocks and
    // lands in busy.
    const occupies = event.exclusive ? busyRanges : openRanges;

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

// ── Listings ──────────────────────────────────────────────────────────

const ownClaimView = (claim: Claim, exchange?: ExchangeView): OwnClaimView => ({
  id: claim.id,
  status: claim.status,
  ...(claim.message === undefined ? {} : { message: claim.message }),
  createdAt: claim.createdAt,
  ...(exchange === undefined ? {} : { exchange }),
});

const ownerClaimView = (claim: Claim, exchange?: ExchangeView): OwnerClaimView => ({
  id: claim.id,
  claimantId: claim.claimantId,
  status: claim.status,
  ...(claim.message === undefined ? {} : { message: claim.message }),
  createdAt: claim.createdAt,
  ...(exchange === undefined ? {} : { exchange }),
});

/**
 * A stored `Listing` reduced to what one viewer may see, or `null` if they may
 * see nothing at all.
 *
 * `null` — rather than a redacted stub — is what keeps a listing the viewer is
 * not in the audience for indistinguishable from one that does not exist.
 * Callers filter lists on it and return 404 for a single fetch.
 *
 * The gate is `can()` rather than an inline audience test, because the block
 * check lives at the top of `can()` and an inline `audienceMatches` would
 * silently drop it — a blocked viewer would start seeing listings again.
 *
 * Every field is whitelisted by hand. A spread here would ship `audience`, the
 * owner's sharing configuration, to whoever asked.
 */
export function projectListing(args: {
  listing: Listing;
  viewer: ViewerContext;
  /** Every claim on this listing, unfiltered. Filtering happens here. */
  claims: readonly Claim[];
  /**
   * Live handoffs, keyed by claim id.
   *
   * Passed in rather than fetched — the kernel does no I/O. Both parties to a
   * claim are entitled to its handoff, and `projectExchange` has already
   * refused anyone else, so what arrives here is safe to attach.
   */
  exchanges?: ReadonlyMap<string, ExchangeView>;
}): ListingView | null {
  const { listing, viewer, claims, exchanges } = args;

  if (!can(viewer, { action: 'listing:view', listing }).allowed) return null;

  const isOwner = isSelf(viewer, listing.ownerId);

  // The viewer's own claim, and only theirs. An owner has none by construction
  // — `listing:claim` refuses the owner — so this stays undefined for them.
  const own =
    viewer.viewerId === null
      ? undefined
      : claims.find((c) => c.claimantId === viewer.viewerId);

  return {
    id: listing.id,
    ownerId: listing.ownerId,
    title: listing.title,
    ...(listing.description === undefined ? {} : { description: listing.description }),
    condition: listing.condition,
    ...(listing.priceMinorUnits === undefined
      ? {}
      : { priceMinorUnits: listing.priceMinorUnits }),
    currency: listing.currency,
    photoKeys: listing.photoKeys,
    status: listing.status,
    claimMode: listing.claimMode,
    ...(listing.claimsCloseAt === undefined ? {} : { claimsCloseAt: listing.claimsCloseAt }),
    createdAt: listing.createdAt,

    isOwner,
    ...(own === undefined ? {} : { yourClaim: ownClaimView(own, exchanges?.get(own.id)) }),
    /**
     * Owner-only, and *absent* rather than empty for everyone else.
     *
     * An empty array would be a count — zero is a number, and a client that
     * renders "0 interested" for a stranger and nothing for a friend has leaked
     * the distinction. Absent means the question was never answered.
     */
    ...(isOwner
      ? { claims: claims.map((c) => ownerClaimView(c, exchanges?.get(c.id))) }
      : {}),
  };
}

// ── Reports ───────────────────────────────────────────────────────────

const noteView = (note: ReportNote): NoteView => ({
  id: note.id,
  // The *fact* of a moderator, never which one. A party has no business
  // learning who is handling their case, and an id in the payload is an id
  // that can be correlated across reports.
  fromModerator: note.authorId === null,
  body: note.body,
  createdAt: note.createdAt,
});

const notesFor = (notes: readonly ReportNote[], audience: NoteAudience): NoteView[] =>
  notes.filter((n) => n.audience === audience).map(noteView);

/**
 * A report as its reporter sees it.
 *
 * No evidence snapshot: they already saw the material — they reported it — and
 * handing back a frozen copy would give them a durable record of content the
 * author may since have deleted. No subject identity beyond what they already
 * knew, and none of the subject's thread.
 */
export function projectReportForReporter(args: {
  report: Report;
  notes: readonly ReportNote[];
}): ReporterReportView {
  const { report, notes } = args;
  return {
    id: report.id,
    reason: report.reason,
    ...(report.detail === undefined ? {} : { detail: report.detail }),
    status: report.status,
    subjectKind: report.subject.kind,
    createdAt: report.createdAt,
    notes: notesFor(notes, 'REPORTER'),
  };
}

/**
 * A report as the person it is *about* sees it.
 *
 * This is the projection the whole feature turns on, so it is worth stating what
 * is missing and why:
 *
 *  - **`reporterId`** — the entire point. Never present at any status.
 *  - **`detail`** — the reporter's own words, which routinely identify them
 *    ("he keeps messaging me about the bike"). The subject gets the reason
 *    *category* and the moderator's composed message, nothing rawer.
 *  - **`createdAt`** — filing time correlates with whoever they just argued
 *    with. A timestamp is a weak identifier but it is not no identifier.
 *  - **`evidence`** — it is their own material; re-serving it adds nothing and
 *    would confirm exactly which item drew the report.
 *  - **the reporter's thread** — filtered out by audience, structurally.
 */
export function projectReportForSubject(args: {
  report: Report;
  notes: readonly ReportNote[];
}): SubjectReportView {
  const { report, notes } = args;
  return {
    id: report.id,
    reason: report.reason,
    status: report.status,
    subjectKind: report.subject.kind,
    notes: notesFor(notes, 'SUBJECT'),
  };
}

/**
 * The full case file. Moderators only.
 *
 * The two threads are returned as two arrays rather than one merged, sorted
 * list. That is not a rendering preference: a single array is one careless
 * `.map()` in a client away from showing a subject the reporter's words, and
 * the shape of the data should make that mistake require effort.
 */
export function projectReportForModerator(args: {
  report: Report;
  notes: readonly ReportNote[];
}): ModeratorReportView {
  const { report, notes } = args;
  return {
    id: report.id,
    reporterId: report.reporterId,
    subjectUserId: report.subjectUserId,
    subject: report.subject,
    reason: report.reason,
    ...(report.detail === undefined ? {} : { detail: report.detail }),
    status: report.status,
    evidence: report.evidence,
    ...(report.resolutionNote === undefined
      ? {}
      : { resolutionNote: report.resolutionNote }),
    subjectNotified: report.subjectNotified,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    reporterNotes: notesFor(notes, 'REPORTER'),
    subjectNotes: notesFor(notes, 'SUBJECT'),
  };
}

export const queueRow = (report: Report, noteCount: number): ModerationQueueRow => ({
  id: report.id,
  reason: report.reason,
  status: report.status,
  subjectKind: report.subject.kind,
  createdAt: report.createdAt,
  noteCount,
});

// ── The handoff ───────────────────────────────────────────────────────

/**
 * A handoff as one of its two parties sees it, or `null` for anyone else.
 *
 * Both parties see the same thing, because both agreed to be in a room
 * together: the same time, the same place, and who proposed it. There is no
 * asymmetry to encode.
 *
 * `eventIds` is dropped. The calendar copies belong to their owners and are read
 * through the calendar, so handing a party the *other* person's event id would
 * only invite a client to fetch it directly.
 */
export function projectExchange(args: {
  exchange: Exchange;
  viewer: ViewerContext;
  listing: Pick<Listing, 'ownerId'>;
  claim: Pick<Claim, 'claimantId'>;
}): ExchangeView | null {
  const { exchange, viewer, listing, claim } = args;

  if (viewer.viewerId === null) return null;
  const isParty = viewer.viewerId === listing.ownerId || viewer.viewerId === claim.claimantId;
  if (!isParty) return null;

  return {
    id: exchange.id,
    claimId: exchange.claimId,
    proposedBy: exchange.proposedBy,
    timeRange: exchange.timeRange,
    location: exchange.location,
    ...(exchange.note === undefined ? {} : { note: exchange.note }),
    status: exchange.status,
    createdAt: exchange.createdAt,
  };
}
