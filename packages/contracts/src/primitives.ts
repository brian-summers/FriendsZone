import { z } from 'zod';

/**
 * Branded identifiers.
 *
 * These are nominal types: a `ListingId` will not type-check where a `UserId`
 * is expected, even though both are strings at runtime. This is a cheap and
 * surprisingly effective defence against a whole class of authorization bugs
 * where the wrong id is threaded into a permission check.
 */
const brandedId = <B extends string>(brand: B) => z.string().uuid().brand<B>();

export const UserId = brandedId('UserId');
export type UserId = z.infer<typeof UserId>;

export const CircleId = brandedId('CircleId');
export type CircleId = z.infer<typeof CircleId>;

export const EventId = brandedId('EventId');
export type EventId = z.infer<typeof EventId>;

export const HangoutRequestId = brandedId('HangoutRequestId');
export type HangoutRequestId = z.infer<typeof HangoutRequestId>;

export const ListingId = brandedId('ListingId');
export type ListingId = z.infer<typeof ListingId>;

export const ClaimId = brandedId('ClaimId');
export type ClaimId = z.infer<typeof ClaimId>;

export const ExchangeId = brandedId('ExchangeId');
export type ExchangeId = z.infer<typeof ExchangeId>;

/** RFC 3339 timestamp, always stored and transmitted in UTC. */
export const Instant = z.string().datetime({ offset: true });
export type Instant = z.infer<typeof Instant>;

/** IANA timezone name, e.g. "America/Chicago". Display concern only. */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA timezone identifier');
export type TimeZone = z.infer<typeof TimeZone>;

/**
 * A half-open interval [start, end). Half-open is the only sane choice for a
 * calendar: back-to-back events must not register as overlapping.
 */
export const TimeRange = z
  .object({ start: Instant, end: Instant })
  .refine((r) => Date.parse(r.end) > Date.parse(r.start), {
    message: 'end must be strictly after start',
    path: ['end'],
  });
export type TimeRange = z.infer<typeof TimeRange>;

export const overlaps = (a: TimeRange, b: TimeRange): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

/**
 * Free text supplied by a user and later rendered to other users.
 *
 * Length caps are a denial-of-service control, not a formatting preference.
 * These values are stored raw and escaped at render time; we never sanitise on
 * write, because sanitising on write destroys the original and tends to drift
 * out of sync with whatever the renderer actually does.
 */
export const ShortText = z.string().trim().min(1).max(120);
export const LongText = z.string().trim().max(4000);

/** Display handle: what friends search for. Deliberately narrow. */
export const Handle = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/, 'letters, digits, and . _ - only');
export type Handle = z.infer<typeof Handle>;

/** Money in minor units (cents) to avoid float rounding. */
export const MinorUnits = z.number().int().min(0).max(100_000_00);
