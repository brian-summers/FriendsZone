import { z } from 'zod';
import {
  ClaimId,
  EventId,
  ExchangeId,
  Instant,
  ListingId,
  LongText,
  MinorUnits,
  ShortText,
  TimeRange,
  UserId,
} from './primitives.js';
import { Audience } from './visibility.js';

export const ItemCondition = z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'WORN', 'FOR_PARTS']);
export type ItemCondition = z.infer<typeof ItemCondition>;

export const ListingStatus = z.enum(['AVAILABLE', 'CLAIMED', 'EXCHANGED', 'WITHDRAWN']);
export type ListingStatus = z.infer<typeof ListingStatus>;

/**
 * A secondhand item offered to friends.
 *
 * `audience` reuses the calendar's sharing vocabulary rather than inventing a
 * parallel one. One audience model across the product means one place to get
 * the privacy semantics right, and one place to review them.
 */
export const Listing = z.object({
  id: ListingId,
  ownerId: UserId,
  title: ShortText,
  description: LongText.optional(),
  condition: ItemCondition,
  /** 0 means free. Absent means "make me an offer". */
  priceMinorUnits: MinorUnits.optional(),
  currency: z.string().length(3).default('USD'),

  /**
   * Image references are opaque storage keys, never client-supplied URLs.
   * Accepting a URL here would hand us an SSRF and a phishing vector at once.
   */
  photoKeys: z.array(z.string().max(200)).max(8),

  audience: Audience,
  status: ListingStatus,
  createdAt: Instant,
  updatedAt: Instant,
});
export type Listing = z.infer<typeof Listing>;

export const ClaimStatus = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/**
 * "I'd like that." Multiple claims may be PENDING at once; the owner picks.
 * Accepting one does not auto-decline the others — the owner may want a backup
 * if the first exchange falls through, so declining stays an explicit act.
 */
export const Claim = z.object({
  id: ClaimId,
  listingId: ListingId,
  claimantId: UserId,
  message: LongText.optional(),
  status: ClaimStatus,
  createdAt: Instant,
  updatedAt: Instant,
});
export type Claim = z.infer<typeof Claim>;

export const ExchangeStatus = z.enum(['PROPOSED', 'SCHEDULED', 'COMPLETED', 'CANCELLED']);
export type ExchangeStatus = z.infer<typeof ExchangeStatus>;

/**
 * The handoff. This is the one place the product moves people into physical
 * proximity, so it is the one place with an explicit safety story:
 *
 *  - `location` is free text chosen by the participants, never auto-filled from
 *    a home address, because we do not store home addresses.
 *  - Scheduling an exchange creates a calendar event for both parties whose
 *    `visibilityCeiling` is BUSY. Third parties learn that someone is occupied,
 *    never where they will be or who they are meeting.
 *
 * See docs/security/threat-model.md, "Abuse case: exchange as a pretext".
 */
export const Exchange = z.object({
  id: ExchangeId,
  claimId: ClaimId,
  proposedBy: UserId,
  timeRange: TimeRange,
  location: ShortText,
  status: ExchangeStatus,
  /** Calendar events created for each participant, if scheduled. */
  eventIds: z.array(EventId).max(2),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Exchange = z.infer<typeof Exchange>;
