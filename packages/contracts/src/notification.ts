import { z } from 'zod';
import { HangoutRequestId, Instant, LongText, UserId } from './primitives.js';

/**
 * A notification.
 *
 * The delivery mechanism does not exist yet — [ADR 0007](../../docs/adr/0007-async-by-design.md)
 * commits to a once-daily digest, never a real-time nudge, and that is
 * deliberately unbuilt. What exists here is the *record*: when someone cancels,
 * reschedules, or edits a hangout and asks to notify the other party, an intent
 * is written for the recipient to find. That keeps "notify them" honest — the
 * message is produced and stored — without smuggling in the pressure-generating
 * real-time channel the product exists to avoid.
 *
 * Notifications are the recipient's alone: only the user a notification is *for*
 * may read it. There is no fan-out, no "seen by", no delivery receipt.
 */
export const NotificationKind = z.enum([
  'HANGOUT_CANCELLED',
  'HANGOUT_RESCHEDULED',
  'HANGOUT_UPDATED',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const Notification = z.object({
  id: z.string().uuid(),
  /** Who this is for. Only they may read it. */
  recipientId: UserId,
  /** Who caused it. */
  actorId: UserId,
  kind: NotificationKind,
  hangoutId: HangoutRequestId,
  /** A short, already-composed line. Safe to show; contains no private detail. */
  summary: LongText,
  createdAt: Instant,
  readAt: Instant.optional(),
});
export type Notification = z.infer<typeof Notification>;
