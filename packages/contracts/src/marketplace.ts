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
 * How the owner decided this item would be given away.
 *
 * Fixed at creation and immutable once anyone has claimed — changing it
 * afterwards would rewrite the terms people already acted on. See
 * docs/adr/0017-claim-modes-and-deadlines.md.
 */
export const ClaimMode = z.enum([
  /** First eligible claim wins, accepted the moment it arrives. */
  'FIRST_COME',
  /** Every claim is an entry; the owner draws once, at random, after the deadline. */
  'LOTTERY',
  /** Claims accumulate; the owner accepts one whenever they choose. */
  'OWNER_SELECTS',
]);
export type ClaimMode = z.infer<typeof ClaimMode>;

/**
 * Claims per listing.
 *
 * A cap rather than unbounded, because the draw loads every entry at once and
 * because an unbounded child collection is a storage-exhaustion vector.
 */
export const MAX_CLAIMS_PER_LISTING = 200;

/** Photos per listing. Matches the `photoKeys` cap on `Listing`. */
export const MAX_PHOTOS_PER_LISTING = 8;

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

  claimMode: ClaimMode,
  /**
   * When claiming closes. Optional — an offer may stay open indefinitely.
   *
   * One meaning in every mode: after this instant no new claim is accepted.
   * What happens *next* is what varies by mode, which is why this is one field
   * and not three (ADR 0017).
   */
  claimsCloseAt: Instant.optional(),

  createdAt: Instant,
  updatedAt: Instant,
});
export type Listing = z.infer<typeof Listing>;

export const ClaimStatus = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/**
 * "I'd like that" — or, under `LOTTERY`, "enter me".
 *
 * What a claim *means* depends on the listing's `claimMode`, but the record is
 * the same shape in all three, so there is one lifecycle to reason about
 * instead of three (ADR 0017).
 *
 * Multiple claims may be PENDING at once. Under `OWNER_SELECTS`, accepting one
 * deliberately does **not** auto-decline the others — the owner may want a
 * backup if the handoff falls through. A `LOTTERY` draw is the exception: it
 * declines every entry it did not select, because leaving them pending forever
 * is the guilt pile the product exists to avoid.
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
  note: LongText.optional(),
  status: ExchangeStatus,
  /** Calendar events created for each participant, if scheduled. */
  eventIds: z.array(EventId).max(2),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Exchange = z.infer<typeof Exchange>;

// ── Wire types ────────────────────────────────────────────────────────
//
// Nothing above this line crosses the network. `Listing` and `Claim` are
// stored shapes; what a client receives is a `ListingView` built by
// `projectListing()`, which whitelists fields per viewer. Handing back a
// stored `Listing` would ship `audience` — the owner's sharing configuration —
// to whoever asked.

/**
 * What the owner supplies to create a listing.
 *
 * There is deliberately no `ownerId` and no `status`: the server takes identity
 * from the authenticated actor and starts every listing `AVAILABLE`. A field
 * here is a field a caller can set, so the absent ones are the point.
 */
export const CreateListingInput = z.object({
  title: ShortText,
  description: LongText.optional(),
  condition: ItemCondition,
  priceMinorUnits: MinorUnits.optional(),
  currency: z.string().length(3).default('USD'),
  photoKeys: z.array(z.string().uuid()).max(MAX_PHOTOS_PER_LISTING).default([]),
  audience: Audience,
  claimMode: ClaimMode,
  claimsCloseAt: Instant.optional(),
});
export type CreateListingInput = z.infer<typeof CreateListingInput>;

/**
 * Editing a listing. Every field optional; absent means "leave alone".
 *
 * `claimMode` is absent by design — it is immutable once anyone has claimed,
 * and permitting it here would mean the route had to police a rule the schema
 * could simply not express. `audience` *is* editable, because narrowing who can
 * see a thing must always be possible.
 */
export const UpdateListingInput = z.object({
  title: ShortText.optional(),
  description: LongText.optional(),
  condition: ItemCondition.optional(),
  priceMinorUnits: MinorUnits.optional(),
  photoKeys: z.array(z.string().uuid()).max(MAX_PHOTOS_PER_LISTING).optional(),
  audience: Audience.optional(),
  claimsCloseAt: Instant.optional(),
});
export type UpdateListingInput = z.infer<typeof UpdateListingInput>;

export const ClaimListingInput = z.object({
  message: LongText.optional(),
});
export type ClaimListingInput = z.infer<typeof ClaimListingInput>;

/** What the owner does with one claim under `OWNER_SELECTS`. */
export const ClaimDecisionInput = z.object({
  decision: z.enum(['ACCEPT', 'DECLINE']),
});
export type ClaimDecisionInput = z.infer<typeof ClaimDecisionInput>;

/**
 * A photo, base64-encoded, with **no `data:` URL prefix** — the client strips
 * it before sending.
 *
 * Deliberately not accepting the prefix: it carries a client-declared MIME type
 * that we would then have to be careful to ignore, and the safest way to ignore
 * a value is not to accept it in the first place. The real type is sniffed from
 * the decoded bytes.
 */
export const UploadPhotoInput = z.object({
  data: z.string().min(1).max(4_400_000),
});
export type UploadPhotoInput = z.infer<typeof UploadPhotoInput>;

/** Upload returns only the key. The bytes come back through the listing. */
export const UploadedPhoto = z.object({ key: z.string().uuid() });
export type UploadedPhoto = z.infer<typeof UploadedPhoto>;

/**
 * Proposing a handoff. Time and place, agreed between two people.
 *
 * `location` is `ShortText` a person typed. There is no venue id, no
 * coordinates, and no field that could be auto-filled from anything we store —
 * we hold no addresses, and building a place database would mean accumulating a
 * record of where our users physically meet
 * (docs/adr/0019-the-handoff.md).
 */
export const ProposeExchangeInput = z.object({
  timeRange: TimeRange,
  location: ShortText,
  note: LongText.optional(),
});
export type ProposeExchangeInput = z.infer<typeof ProposeExchangeInput>;

export const RespondExchangeInput = z.object({
  decision: z.enum(['ACCEPT', 'DECLINE']),
});
export type RespondExchangeInput = z.infer<typeof RespondExchangeInput>;

/**
 * A handoff as one of its two parties sees it.
 *
 * There is only one shape because there are only two viewers, and they are
 * symmetric: both agreed to be in a room together, so both see the same time,
 * the same place, and who proposed it. A non-party gets `null` from
 * `projectExchange` and never reaches this type.
 *
 * `eventIds` is deliberately absent. The calendar copies are each owner's own
 * and are read through the calendar; handing over the other person's event id
 * would invite a client to fetch it directly.
 */
export const ExchangeView = z.object({
  id: ExchangeId,
  claimId: ClaimId,
  proposedBy: UserId,
  timeRange: TimeRange,
  location: ShortText,
  note: LongText.optional(),
  status: ExchangeStatus,
  createdAt: Instant,
});
export type ExchangeView = z.infer<typeof ExchangeView>;

/**
 * A claim as its own claimant sees it. No `claimantId` — the viewer is the
 * claimant, so echoing the id back adds nothing and invites the field being
 * reused in a context where it would be someone else's.
 */
export const OwnClaimView = z.object({
  id: ClaimId,
  status: ClaimStatus,
  message: LongText.optional(),
  createdAt: Instant,
  /** Present once a handoff is being arranged. Parties only, by construction. */
  exchange: ExchangeView.optional(),
});
export type OwnClaimView = z.infer<typeof OwnClaimView>;

/**
 * A claim as the listing's *owner* sees it, in order to select or draw.
 *
 * The owner is the one party entitled to know who wants their item. Everyone
 * else — including other claimants — gets nothing about anyone but themselves.
 */
export const OwnerClaimView = z.object({
  id: ClaimId,
  claimantId: UserId,
  status: ClaimStatus,
  message: LongText.optional(),
  createdAt: Instant,
  exchange: ExchangeView.optional(),
});
export type OwnerClaimView = z.infer<typeof OwnerClaimView>;

/**
 * A listing as one specific viewer may see it.
 *
 * `audience` is absent at every level: it is the owner's configuration, not a
 * property of the item, and a viewer who could read it would learn the shape of
 * the owner's circles. The owner edits it through the input schema instead.
 *
 * `claims` is present only for the owner. `yourClaim` is the viewer's own entry
 * and is what lets a claimant render "you entered this" without anyone being
 * able to derive who else did (ADR 0017).
 */
export const ListingView = z.object({
  id: ListingId,
  ownerId: UserId,
  title: ShortText,
  description: LongText.optional(),
  condition: ItemCondition,
  priceMinorUnits: MinorUnits.optional(),
  currency: z.string().length(3),
  photoKeys: z.array(z.string().uuid()).max(MAX_PHOTOS_PER_LISTING),
  status: ListingStatus,
  claimMode: ClaimMode,
  claimsCloseAt: Instant.optional(),
  createdAt: Instant,

  /** True when the viewer owns this. Saves the client comparing ids. */
  isOwner: z.boolean(),
  /** The viewer's own claim, if they have one. Never anyone else's. */
  yourClaim: OwnClaimView.optional(),
  /** Owner-only. Absent — not empty — for every other viewer. */
  claims: z.array(OwnerClaimView).optional(),
});
export type ListingView = z.infer<typeof ListingView>;
