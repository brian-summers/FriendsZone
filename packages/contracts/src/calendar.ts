import { z } from 'zod';
import {
  EventId,
  HangoutRequestId,
  Instant,
  LongText,
  ShortText,
  TimeRange,
  UserId,
} from './primitives.js';
import { ShareRule, VisibilityLevel } from './visibility.js';

export const EventStatus = z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
export type EventStatus = z.infer<typeof EventStatus>;

/**
 * An entry on someone's calendar.
 *
 * This is the *stored* shape. It must never be returned to a client directly —
 * only `projectEvent()` output crosses the network boundary. Enforced by
 * convention here and by a test in packages/policy.
 */
export const CalendarEvent = z.object({
  id: EventId,
  ownerId: UserId,
  timeRange: TimeRange,
  title: ShortText,
  description: LongText.optional(),
  /** Free text, not a geocoded address. Treated as sensitive. */
  location: ShortText.optional(),
  status: EventStatus,

  /**
   * A hard ceiling the owner sets per event. The resolved visibility for any
   * viewer is clamped to at most this. It exists so that a user can drop one
   * sensitive event below their general sharing defaults without having to
   * reason about which of their circles those defaults happen to cover.
   */
  visibilityCeiling: VisibilityLevel,

  /**
   * Per-event overrides. When empty, the owner's `SharingDefaults` apply.
   * Empty array and "no rules" are the same thing, and both mean *default*,
   * not *deny* — the ceiling is how you deny.
   */
  shareRules: z.array(ShareRule).max(50),

  /** Confirmed participants. Attendees always see FULL — see the spec. */
  attendeeIds: z.array(UserId).max(200),

  /**
   * Whether this event **exclusively blocks** its time.
   *
   * Events overlap by default (`exclusive: false`) — useful for layered plans
   * that share a block, and it means friends may request the time anyway. Such
   * an event contributes to `openBlocks`, not `busy`. Opting *out* of overlap
   * (`exclusive: true`) makes it a hard commitment: it goes to `busy`, and no
   * one can request over it.
   */
  exclusive: z.boolean(),

  /** Set when the event was created by accepting a hangout request. */
  originHangoutRequestId: HangoutRequestId.optional(),

  createdAt: Instant,
  updatedAt: Instant,
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

/**
 * What a client may supply when creating an event.
 *
 * Pointedly *not* `CalendarEvent`. The server owns identity and timestamps, and
 * — critically — owns `ownerId`: it is taken from the authenticated actor, never
 * from the body, so a request cannot create an event on someone else's
 * calendar by naming them. Everything a client is allowed to decide is here and
 * nothing it is not.
 */
export const CreateEventInput = z.object({
  timeRange: TimeRange,
  title: ShortText,
  description: LongText.optional(),
  location: ShortText.optional(),
  status: EventStatus.default('CONFIRMED'),
  visibilityCeiling: VisibilityLevel.default('FULL'),
  shareRules: z.array(ShareRule).max(50).default([]),
  attendeeIds: z.array(UserId).max(200).default([]),
  /** Default false: events overlap unless you opt out by blocking the time. */
  exclusive: z.boolean().default(false),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

/**
 * What a client may change about an event it owns. Every field optional — a
 * PATCH touches only what it names. Still no `ownerId`: ownership does not move.
 * The sharing editor is just this input carrying new `shareRules` and
 * `visibilityCeiling`.
 */
export const UpdateEventInput = z
  .object({
    timeRange: TimeRange.optional(),
    title: ShortText.optional(),
    description: LongText.optional(),
    location: ShortText.optional(),
    status: EventStatus.optional(),
    visibilityCeiling: VisibilityLevel.optional(),
    shareRules: z.array(ShareRule).max(50).optional(),
    exclusive: z.boolean().optional(),
  })
  .refine((r) => Object.values(r).some((v) => v !== undefined), {
    message: 'nothing to update',
  });
export type UpdateEventInput = z.infer<typeof UpdateEventInput>;

/**
 * When a user is open to *receiving* hangout requests, expressed in their own
 * timezone. This is not availability in the free/busy sense — it is consent to
 * be asked. A friend can propose a time inside these windows without it feeling
 * like an intrusion; outside them, the UI warns before sending.
 */
export const AvailabilityWindow = z.object({
  /** 0 = Sunday. */
  dayOfWeek: z.number().int().min(0).max(6),
  /** Minutes from local midnight, half-open [startMinute, endMinute). */
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
}).refine((w) => w.endMinute > w.startMinute, {
  message: 'endMinute must be after startMinute',
  path: ['endMinute'],
});
export type AvailabilityWindow = z.infer<typeof AvailabilityWindow>;

// ---------------------------------------------------------------------------
// Projections — the only event shapes permitted to leave the server.
// ---------------------------------------------------------------------------

/**
 * An opaque unavailable interval. Carries no id: busy blocks are *merged*
 * across adjacent events before serialization, so there is no stable one-to-one
 * mapping back to a row, and a viewer cannot count how many events fill a span.
 */
export const BusyBlock = z.object({
  start: Instant,
  end: Instant,
});
export type BusyBlock = z.infer<typeof BusyBlock>;

export const EventTitleView = z.object({
  visibility: z.literal('TITLE'),
  id: EventId,
  ownerId: UserId,
  timeRange: TimeRange,
  title: ShortText,
  status: EventStatus,
  exclusive: z.boolean(),
});
export type EventTitleView = z.infer<typeof EventTitleView>;

export const EventFullView = z.object({
  visibility: z.literal('FULL'),
  id: EventId,
  ownerId: UserId,
  timeRange: TimeRange,
  title: ShortText,
  description: LongText.optional(),
  location: ShortText.optional(),
  status: EventStatus,
  attendeeIds: z.array(UserId),
  exclusive: z.boolean(),

  /**
   * Set when this event came from a hangout. Only ever reaches the FULL view,
   * which for a hangout event only its participants receive — so it lets the
   * two people involved manage the hangout (reschedule, cancel, edit) straight
   * from the calendar, and is invisible to everyone else.
   */
  originHangoutRequestId: HangoutRequestId.optional(),

  /**
   * "The most anyone else can see." Present *only* when the owner is looking at
   * their own calendar, so it can be surfaced as a who-can-see-this badge.
   *
   * It is safe on this shape because a non-owner only reaches `FULL` by being
   * an attendee or an explicit grant, and the projection code never populates
   * this field on those paths — a test in packages/policy asserts a friend's
   * FULL view never carries it. It is a summary for the owner, never a grant.
   */
  sharedAs: VisibilityLevel.optional(),

  /**
   * The event's own sharing rules and ceiling, so the owner can *edit* them.
   * Owner-only, exactly like `sharedAs` — a non-owner must never learn how an
   * event is shared, only what they personally received. Populated solely in
   * the owner branch of `projectCalendar`; asserted absent for others.
   */
  shareRules: z.array(ShareRule).optional(),
  ownVisibilityCeiling: VisibilityLevel.optional(),
});
export type EventFullView = z.infer<typeof EventFullView>;

export const EventView = z.discriminatedUnion('visibility', [EventTitleView, EventFullView]);
export type EventView = z.infer<typeof EventView>;

export const HangoutHoldRole = z.enum(['PROPOSER', 'INVITEE']);
export type HangoutHoldRole = z.infer<typeof HangoutHoldRole>;

/**
 * A tentative entry: one proposed slot of a *pending* hangout request, shown on
 * a calendar as a soft hold.
 *
 * Holds are strictly participant-scoped. One appears only when the viewer is a
 * party to the request, so it discloses nothing — the viewer either proposed
 * these times or received them, and already knows them. That is why a hold can
 * carry its full title and the other party's id without a visibility check: it
 * is never shown to anyone who was not already entitled to the request.
 *
 * `role` is the *viewer's* role, which decides what they may do with it: an
 * invitee can accept this slot or decline the request; a proposer can withdraw.
 * A hold is never counted as busy — a maybe is not a commitment.
 */
export const HangoutHold = z.object({
  requestId: HangoutRequestId,
  /** Which of the request's proposed slots this hold represents. */
  slotIndex: z.number().int().min(0),
  timeRange: TimeRange,
  title: ShortText,
  proposerId: UserId,
  inviteeId: UserId,
  role: HangoutHoldRole,
  expiresAt: Instant,
});
export type HangoutHold = z.infer<typeof HangoutHold>;

/**
 * The complete answer to "show me this person's calendar for this window".
 *
 * `busy` covers *every* non-hidden event, including those also present in
 * `details`. That redundancy is intentional: it makes "find a free slot" a
 * correct operation over `busy` alone, and it means a client that ignores
 * `details` still cannot accidentally treat a titled event as free time.
 *
 * `holds` are tentative — pending hangout slots the viewer is a party to. They
 * are deliberately *not* in `busy`, because a pending ask is not a commitment
 * and must not make the owner look unavailable.
 *
 * `openBlocks` are times the owner is occupied by a *non-exclusive* event —
 * overlappable, and requestable. They are kept out of `busy` so they never
 * register as a hard conflict. Since events overlap by default, most occupied
 * time lands here; only events explicitly made exclusive land in `busy`.
 *
 * There is deliberately no `hiddenCount`. Reporting how much was withheld is
 * itself a disclosure.
 */
export const CalendarView = z.object({
  ownerId: UserId,
  window: TimeRange,
  busy: z.array(BusyBlock),
  openBlocks: z.array(BusyBlock),
  details: z.array(EventView),
  holds: z.array(HangoutHold),
});
export type CalendarView = z.infer<typeof CalendarView>;
