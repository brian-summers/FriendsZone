import { z } from 'zod';
import { CalendarEvent, EventView } from './calendar.js';
import { PublicProfile } from './identity.js';
import { ExchangeView, ListingView, OwnClaimView } from './marketplace.js';
import { ReporterReportView, SubjectReportView } from './moderation.js';
import { Notification } from './notification.js';
import { Handle, Instant } from './primitives.js';
import { SharingDefaults } from './visibility.js';

/**
 * Account export and deletion.
 *
 * The shape below is deliberately built out of **view** types, not stored ones.
 * Every section is what the projection engine already hands this user, which is
 * what makes the guarantee in docs/adr/0022-export-and-deletion.md structural:
 *
 * > An export can never contain more than the user could already read.
 *
 * The case that matters: `reportsAboutYou` is `SubjectReportView`, which carries
 * no `reporterId`. Exporting the stored `Report` would hand a reported person
 * the identity of whoever reported them, in a downloadable file, as a privacy
 * feature.
 */

/**
 * Your own events, in full.
 *
 * `CalendarEvent` rather than `EventView` here on purpose, and it is the one
 * place the export touches a stored shape: these are *your* events, you are
 * their author and owner, and an export that dropped your own descriptions and
 * sharing rules would not be a usable copy of your calendar.
 */
export const ExportedEvent = CalendarEvent;

export const AccountExport = z.object({
  /** When this copy was made. */
  exportedAt: Instant,
  /**
   * A note to whoever opens the file, explaining what is *not* in it and why.
   * Shipped as data so the interface and the file agree.
   */
  readme: z.string(),

  profile: PublicProfile,
  sharingDefaults: SharingDefaults,

  events: z.array(ExportedEvent),

  /** Things you offered. Projected as you see them, including your claims. */
  listings: z.array(ListingView),
  /** Claims you made on other people's listings. */
  claims: z.array(OwnClaimView),
  /** Handoffs you are a party to. */
  handoffs: z.array(ExchangeView),

  /** Hangouts, as the calendar shows them to you. */
  hangoutEvents: z.array(EventView),

  notifications: z.array(Notification),

  /** Reports you filed, with your own thread. */
  reportsYouFiled: z.array(ReporterReportView),
  /**
   * Reports about you that a moderator opened a thread on.
   *
   * `SubjectReportView` - no reporter identity, no reporter's words, no filing
   * time. The anonymity guarantee does not weaken because the data left the
   * building in a JSON file.
   */
  reportsAboutYou: z.array(SubjectReportView),
});
export type AccountExport = z.infer<typeof AccountExport>;

/**
 * Deleting your account.
 *
 * Requires typing your own handle. Deletion is immediate and irreversible
 * (ADR 0022), so it costs more than a click - and a `POST` with a body rather
 * than `DELETE /v1/me`, which is one mis-scoped fetch away from firing.
 */
export const DeleteAccountInput = z.object({
  /** Must match the caller's own handle exactly. */
  confirmHandle: Handle,
});
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;

export const DeletionReceipt = z.object({
  deletedAt: Instant,
  /**
   * Stated plainly, and true. What survives is listed rather than glossed,
   * because "your account has been deleted" while retaining data is the kind of
   * claim this product should not make.
   */
  retained: z.array(z.string()),
});
export type DeletionReceipt = z.infer<typeof DeletionReceipt>;

/** The neutral name a tombstoned user shows as in other people's records. */
export const TOMBSTONE_DISPLAY_NAME = 'A former member';
