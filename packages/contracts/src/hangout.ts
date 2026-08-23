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

/**
 * The asynchronous ask: "any of these times work?"
 *
 * The whole point of the product is that this can sit unanswered without it
 * being rude. Two design consequences follow:
 *
 *  1. Requests carry an explicit `expiresAt`. A request that quietly ages out
 *     is socially cheaper than one the recipient must actively decline, and it
 *     stops the inbox becoming a guilt pile.
 *  2. There is no "seen" or "typing" signal anywhere in this model. Read
 *     receipts reintroduce exactly the synchronous pressure we are removing.
 */
export const HangoutRequestStatus = z.enum([
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  /** Proposer took it back before it was accepted. */
  'WITHDRAWN',
  /** Passed `expiresAt` with no response. Not a rejection. */
  'EXPIRED',
  /** A *confirmed* hangout was called off after the fact. */
  'CANCELLED',
]);
export type HangoutRequestStatus = z.infer<typeof HangoutRequestStatus>;

/**
 * How a hangout resolves.
 *
 *  - `FIXED`   - the classic ask: a short list of candidate slots, resolved once
 *                into a single confirmed event.
 *  - `FLOATING`- a standing invitation over a period ("any evening in the next
 *                two weeks"), which can be booked *any number of times*. Each
 *                booking mints an occurrence; the invitation stays open until
 *                the period ends.
 */
export const HangoutKind = z.enum(['FIXED', 'FLOATING']);
export type HangoutKind = z.infer<typeof HangoutKind>;

export const SlotPreference = z.enum(['YES', 'IF_NEEDED', 'NO']);
export type SlotPreference = z.infer<typeof SlotPreference>;

export const SlotResponse = z.object({
  /** Index into `HangoutRequest.proposedSlots`. */
  slotIndex: z.number().int().min(0),
  preference: SlotPreference,
});
export type SlotResponse = z.infer<typeof SlotResponse>;

export const InviteeResponse = z.object({
  userId: UserId,
  slots: z.array(SlotResponse).max(10),
  note: LongText.optional(),
  respondedAt: Instant,
});
export type InviteeResponse = z.infer<typeof InviteeResponse>;

export const HangoutRequest = z.object({
  id: HangoutRequestId,
  proposerId: UserId,
  inviteeIds: z.array(UserId).min(1).max(50),
  kind: HangoutKind,
  title: ShortText,
  note: LongText.optional(),
  location: ShortText.optional(),

  /**
   * FIXED only. Candidate times, in preference order. Capped at 10: a request
   * with thirty options is a scheduling burden dressed up as flexibility.
   * Empty for FLOATING requests, which use `period` instead.
   */
  proposedSlots: z.array(TimeRange).max(10),

  /** FLOATING only. The window an occurrence may be booked within. */
  period: TimeRange.optional(),
  /** FLOATING only. How long each booked occurrence lasts. */
  occurrenceMinutes: z.number().int().min(15).max(1440).optional(),

  status: HangoutRequestStatus,
  responses: z.array(InviteeResponse).max(50),

  /**
   * Calendar events this hangout has produced - one per participant per
   * occurrence. A FIXED hangout has two once accepted; a FLOATING one
   * accumulates a pair per booking. Fanning cancel/reschedule/update out to all
   * copies reads from here, so it must list *every* copy, not just one.
   */
  resultingEventIds: z.array(EventId).max(200),

  expiresAt: Instant,
  createdAt: Instant,
  updatedAt: Instant,
}).refine(
  (r) =>
    r.kind === 'FLOATING'
      ? r.period !== undefined && r.occurrenceMinutes !== undefined
      : r.proposedSlots.length >= 1,
  { message: 'FIXED needs proposedSlots; FLOATING needs period and occurrenceMinutes' },
);
export type HangoutRequest = z.infer<typeof HangoutRequest>;

/**
 * Terminal states cannot transition further. Encoded as data so that both the
 * state machine and its tests read from one table rather than two hand-written
 * switch statements that drift apart.
 *
 * ACCEPTED is no longer terminal: a confirmed hangout can be CANCELLED after
 * the fact. Rescheduling and property updates keep the status unchanged (they
 * are edits, not transitions), so they do not appear here. Booking a FLOATING
 * occurrence likewise keeps it PENDING - the invitation stays open.
 */
export const HANGOUT_TRANSITIONS: Readonly<
  Record<HangoutRequestStatus, readonly HangoutRequestStatus[]>
> = Object.freeze({
  PENDING: ['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['CANCELLED'],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
  CANCELLED: [],
});

/**
 * A pending request whose `expiresAt` has passed is *effectively* EXPIRED, even
 * before anything writes that status. This is a pure predicate so the same
 * answer is reachable from the store (which mutates lazily on read) and from a
 * test, without either importing a clock.
 */
export const isHangoutExpired = (
  request: Pick<HangoutRequest, 'status' | 'expiresAt'>,
  nowIso: string,
): boolean => request.status === 'PENDING' && Date.parse(nowIso) > Date.parse(request.expiresAt);

/**
 * What a client sends to propose a hangout.
 *
 * Single invitee on purpose. The stored model carries an `inviteeIds` array
 * because group hangouts are a planned extension, but resolving a *group*
 * request needs a proposer-confirms-after-collecting-availability flow (see the
 * sequence diagram in docs/architecture/overview.md), which is materially more
 * than the 1:1 case. Rather than ship an ambiguous half-version, the input type
 * expresses the 1:1 constraint honestly; groups get their own input later.
 *
 * `proposerId` is absent by design - it is the authenticated actor, never the
 * body. `expiresAt` is optional; the server supplies a sensible default so a
 * client cannot forget the property that keeps the inbox from becoming a guilt
 * pile.
 */
export const CreateHangoutInput = z
  .object({
    inviteeId: UserId,
    kind: HangoutKind.default('FIXED'),
    title: ShortText,
    note: LongText.optional(),
    location: ShortText.optional(),
    /** FIXED: the candidate times. */
    proposedSlots: z.array(TimeRange).max(5).default([]),
    /** FLOATING: the window occurrences may be booked within. */
    period: TimeRange.optional(),
    /** FLOATING: how long each occurrence lasts. */
    occurrenceMinutes: z.number().int().min(15).max(1440).optional(),
    expiresAt: Instant.optional(),
  })
  .refine(
    (r) =>
      r.kind === 'FLOATING'
        ? r.period !== undefined && r.occurrenceMinutes !== undefined
        : r.proposedSlots.length >= 1,
    { message: 'FIXED needs at least one proposed slot; FLOATING needs a period and duration' },
  );
export type CreateHangoutInput = z.infer<typeof CreateHangoutInput>;

/**
 * How an invitee resolves a FIXED request they received.
 *
 * Accepting names the winning slot and books it for everyone; declining is one
 * tap and needs no reason (an optional note is offered, never required - a
 * mandatory reason is exactly what makes people avoid answering at all).
 */
export const HangoutDecision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('ACCEPT'), slotIndex: z.number().int().min(0).max(9) }),
  z.object({ decision: z.literal('DECLINE'), note: LongText.optional() }),
]);
export type HangoutDecision = z.infer<typeof HangoutDecision>;

/** Edit a hangout's descriptive properties. Times are handled by reschedule. */
export const UpdateHangoutInput = z
  .object({
    title: ShortText.optional(),
    note: LongText.optional(),
    location: ShortText.optional(),
    /** Send a heads-up to the other party about the change. */
    notify: z.boolean().default(false),
  })
  .refine((r) => r.title !== undefined || r.note !== undefined || r.location !== undefined, {
    message: 'nothing to update',
  });
export type UpdateHangoutInput = z.infer<typeof UpdateHangoutInput>;

/**
 * Move a hangout in time.
 *
 * For a still-pending FIXED request this replaces the proposed slots (a fresh
 * ask). For a confirmed hangout it takes a single new time and re-books it -
 * the counterparty is notified and can bow out if it no longer works.
 */
export const RescheduleHangoutInput = z.object({
  proposedSlots: z.array(TimeRange).min(1).max(5),
  notify: z.boolean().default(true),
});
export type RescheduleHangoutInput = z.infer<typeof RescheduleHangoutInput>;

/** Call off a confirmed hangout, optionally letting the other party know. */
export const CancelHangoutInput = z.object({
  notify: z.boolean().default(true),
  reason: LongText.optional(),
});
export type CancelHangoutInput = z.infer<typeof CancelHangoutInput>;

/** Book one occurrence of a FLOATING hangout at a chosen start time. */
export const BookOccurrenceInput = z.object({
  start: Instant,
});
export type BookOccurrenceInput = z.infer<typeof BookOccurrenceInput>;
