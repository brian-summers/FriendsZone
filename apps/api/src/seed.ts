import {
  CONSERVATIVE_SHARING_DEFAULTS,
  type CalendarEvent,
  type Listing,
  type ListingId,
  type CircleId,
  type EventId,
  type HangoutRequest,
  type HangoutRequestId,
  type Instant,
  type PublicProfile,
  type ShareRule,
  type TimeRange,
  type UserId,
  type VisibilityLevel,
} from '@friendszone/contracts';
import type { MemorySeed } from './repositories/memory.js';

/**
 * Demo data for local development.
 *
 * Deliberately built to exercise the *privacy* model rather than to look busy:
 * every visibility level appears at least once, one friend is in a circle and
 * one is not, one contact is blocked, and one friend shares nothing back. If
 * you change this, keep that coverage — it is what makes the running app a
 * usable check on the projection engine.
 *
 * Events are generated relative to the current week so the app is never empty.
 */

export const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
export const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
export const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;
export const DAVE = '44444444-4444-4444-8444-444444444444' as UserId;
export const MALLORY = '55555555-5555-4555-8555-555555555555' as UserId;

export const CLIMBING_CREW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CircleId;

const PROFILES: PublicProfile[] = [
  { id: ALICE, handle: 'alice', displayName: 'Alice Nakamura' },
  { id: BOB, handle: 'bob', displayName: 'Bob Iyer' },
  { id: CAROL, handle: 'carol', displayName: 'Carol Mensah' },
  { id: DAVE, handle: 'dave', displayName: 'Dave Okonkwo' },
  { id: MALLORY, handle: 'mallory', displayName: 'Mallory Quinn' },
];

/**
 * Monday 00:00 of the current week, in the host's local time.
 *
 * Local rather than UTC on purpose. Instants are stored and transmitted in UTC
 * as always, but a seed pinned to UTC hours renders at 3am for anyone west of
 * Greenwich, and a demo calendar whose events fall outside the visible day is
 * useless. In development the API and the browser share a machine, so building
 * from local time puts "9am" at 9am on screen.
 */
function weekStart(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // getDay: 0 = Sunday. Shift so Monday is day 0.
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

const at = (base: Date, dayOffset: number, hour: number, minute = 0): Instant => {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

let counter = 0;
const nextId = (): EventId => {
  counter += 1;
  return `cccccccc-cccc-4ccc-8ccc-${String(counter).padStart(12, '0')}` as EventId;
};

const rule = (audience: ShareRule['audience'], level: VisibilityLevel): ShareRule => ({
  audience,
  level,
});

interface Draft {
  ownerId: UserId;
  day: number;
  from: number;
  to: number;
  /** End day, when the event runs past midnight into a later day. Defaults to `day`. */
  toDay?: number;
  title: string;
  location?: string;
  description?: string;
  ceiling?: VisibilityLevel;
  rules?: ShareRule[];
  attendeeIds?: UserId[];
  status?: CalendarEvent['status'];
  /** Hard block (busy). Omitted = overlappable (the product default). */
  exclusive?: boolean;
}

function build(base: Date, d: Draft): CalendarEvent {
  const now = new Date().toISOString();
  return {
    id: nextId(),
    ownerId: d.ownerId,
    timeRange: { start: at(base, d.day, d.from), end: at(base, d.toDay ?? d.day, d.to) },
    title: d.title,
    status: d.status ?? 'CONFIRMED',
    visibilityCeiling: d.ceiling ?? 'FULL',
    shareRules: d.rules ?? [],
    attendeeIds: d.attendeeIds ?? [],
    exclusive: d.exclusive ?? false,
    createdAt: now,
    updatedAt: now,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.location !== undefined ? { location: d.location } : {}),
  };
}

export function createDemoSeed(now = new Date()): MemorySeed {
  const base = weekStart(now);

  const drafts: Draft[] = [
    // ── Alice ────────────────────────────────────────────────────────────
    // No rules → falls back to her defaults (friends see BUSY only). Exclusive:
    // a real appointment she can't be pulled away from.
    {
      ownerId: ALICE,
      day: 0,
      from: 9,
      to: 11,
      title: 'Dentist',
      location: '400 Elm St, Suite 210',
      description: 'Back left molar, second visit',
      exclusive: true,
    },
    // Ceiling HIDDEN: nobody but Alice, whatever her defaults say. Exclusive.
    {
      ownerId: ALICE,
      day: 1,
      from: 12,
      to: 13,
      title: 'Therapy',
      location: 'Rowan & Associates',
      ceiling: 'HIDDEN',
      exclusive: true,
    },
    {
      ownerId: ALICE,
      day: 1,
      from: 15,
      to: 16,
      title: 'Design review',
      rules: [rule({ kind: 'FRIENDS' }, 'BUSY')],
    },
    // Circle sees everything; other friends get the name only. Bob attends.
    {
      ownerId: ALICE,
      day: 3,
      from: 19,
      to: 21,
      title: 'Climbing at Vertigo',
      location: 'Vertigo Bouldering, 12 Wharf Rd',
      description: 'Bring the good shoes. Bob is driving.',
      rules: [
        rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL'),
        rule({ kind: 'FRIENDS' }, 'TITLE'),
      ],
      attendeeIds: [BOB],
    },
    // The one genuinely public thing on her calendar.
    {
      ownerId: ALICE,
      day: 4,
      from: 18,
      to: 20,
      title: 'Book club — The Dispossessed',
      location: 'Trellis Cafe',
      rules: [rule({ kind: 'PUBLIC' }, 'TITLE')],
    },
    {
      ownerId: ALICE,
      day: 5,
      from: 12,
      to: 14,
      title: "Dad's birthday lunch",
      location: 'Home',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
    },
    {
      ownerId: ALICE,
      day: 2,
      from: 8,
      to: 9,
      title: 'Swim',
      rules: [rule({ kind: 'FRIENDS' }, 'BUSY')],
    },
    // Cancelled: Alice still sees it, nobody else does.
    {
      ownerId: ALICE,
      day: 2,
      from: 17,
      to: 18,
      title: 'Drinks with Sam',
      status: 'CANCELLED',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
    },
    // Overlap by default (non-exclusive): a broad co-working block that other
    // things layer inside. It shows as "open", not busy, and is requestable.
    {
      ownerId: ALICE,
      day: 3,
      from: 13,
      to: 17,
      title: 'Co-working',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
    },
    // …with two calls layered inside that same block — the multi-layer case.
    {
      ownerId: ALICE,
      day: 3,
      from: 14,
      to: 15,
      title: 'Sync with Priya',
      rules: [rule({ kind: 'FRIENDS' }, 'BUSY')],
    },
    {
      ownerId: ALICE,
      day: 3,
      from: 15,
      to: 16,
      title: 'Review call',
      rules: [rule({ kind: 'FRIENDS' }, 'BUSY')],
    },
    // A trip that runs past midnight — the multi-day case. It draws as one
    // continuous band from Saturday afternoon across into Sunday. Exclusive,
    // so it's a real block on both days, and shared with friends by title.
    {
      ownerId: ALICE,
      day: 5,
      from: 16,
      toDay: 6,
      to: 12,
      title: 'Cabin weekend',
      location: 'Pinecrest',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
      exclusive: true,
    },

    // ── Bob ──────────────────────────────────────────────────────────────
    // So that viewing a *friend's* calendar shows something real.
    {
      ownerId: BOB,
      day: 0,
      from: 10,
      to: 12,
      title: 'Physio',
      rules: [rule({ kind: 'FRIENDS' }, 'BUSY')],
    },
    {
      ownerId: BOB,
      day: 3,
      from: 19,
      to: 21,
      title: 'Climbing at Vertigo',
      location: 'Vertigo Bouldering, 12 Wharf Rd',
      rules: [rule({ kind: 'CIRCLE', circleId: CLIMBING_CREW }, 'FULL')],
      attendeeIds: [ALICE],
    },
    {
      ownerId: BOB,
      day: 4,
      from: 9,
      to: 17,
      title: 'Offsite',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
    },

    // ── Carol ────────────────────────────────────────────────────────────
    {
      ownerId: CAROL,
      day: 2,
      from: 13,
      to: 15,
      title: 'Studio time',
      rules: [rule({ kind: 'FRIENDS' }, 'TITLE')],
    },
  ];

  const slot = (day: number, from: number, to: number): TimeRange => ({
    start: at(base, day, from),
    end: at(base, day, to),
  });

  let hangoutCounter = 0;
  const hangoutId = (): HangoutRequestId => {
    hangoutCounter += 1;
    return `eeeeeeee-eeee-4eee-8eee-${String(hangoutCounter).padStart(12, '0')}` as HangoutRequestId;
  };
  const nowIso = new Date().toISOString();
  const inDays = (n: number): Instant => new Date(Date.now() + n * 86_400_000).toISOString();

  const hangouts: HangoutRequest[] = [
    // Bob → Alice: sitting in Alice's inbox, waiting on her.
    {
      id: hangoutId(),
      proposerId: BOB,
      inviteeIds: [ALICE],
      kind: 'FIXED',
      title: 'Climb next week?',
      note: 'Been a while — fancy getting back on the wall?',
      location: 'Vertigo Bouldering',
      proposedSlots: [slot(9, 19, 21), slot(11, 19, 21), slot(12, 10, 12)],
      status: 'PENDING',
      responses: [],
      resultingEventIds: [],
      expiresAt: inDays(6),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    // Carol → Alice: also in Alice's inbox, a lunch.
    {
      id: hangoutId(),
      proposerId: CAROL,
      inviteeIds: [ALICE],
      kind: 'FIXED',
      title: 'Lunch sometime',
      proposedSlots: [slot(8, 12, 13), slot(10, 12, 13)],
      status: 'PENDING',
      responses: [],
      resultingEventIds: [],
      expiresAt: inDays(4),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    // Alice → Dave: in Alice's outbox, still pending (Dave shares nothing, so
    // this is the case where you propose blind).
    {
      id: hangoutId(),
      proposerId: ALICE,
      inviteeIds: [DAVE],
      kind: 'FIXED',
      title: 'Coffee to catch up',
      proposedSlots: [slot(9, 15, 16), slot(11, 15, 16)],
      status: 'PENDING',
      responses: [],
      resultingEventIds: [],
      expiresAt: inDays(5),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    // Bob → Alice: a FLOATING standing invitation over the next two weeks.
    {
      id: hangoutId(),
      proposerId: BOB,
      inviteeIds: [ALICE],
      kind: 'FLOATING',
      title: 'Walk the dog anytime',
      note: 'Grab a walk whenever suits — as often as you like.',
      proposedSlots: [],
      period: { start: at(base, 0, 0), end: at(base, 13, 23) },
      occurrenceMinutes: 60,
      status: 'PENDING',
      responses: [],
      resultingEventIds: [],
      expiresAt: at(base, 13, 23),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  /**
   * One listing per claim mode, so the Things page demonstrates all three
   * without anyone having to create them. Photoless: the demo seed cannot
   * invent image bytes, and a fake photo key would 404 on the way back.
   */
  const listings: Listing[] = [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-000000000001' as ListingId,
      ownerId: ALICE,
      title: 'Cast iron skillet',
      description: 'Seasoned for about ten years. Heavy. Wants a hob that gets used.',
      condition: 'GOOD',
      priceMinorUnits: 0,
      currency: 'USD',
      photoKeys: [],
      audience: { kind: 'FRIENDS' },
      status: 'AVAILABLE',
      claimMode: 'FIRST_COME',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: 'dddddddd-dddd-4ddd-8ddd-000000000002' as ListingId,
      ownerId: ALICE,
      title: 'Climbing shoes, 41',
      description: 'Resoled once. Barely worn since.',
      condition: 'LIKE_NEW',
      priceMinorUnits: 0,
      currency: 'USD',
      photoKeys: [],
      // Circle-scoped: Bob sees this, Carol and Dave do not, which is the whole
      // point of the audience model showing up in a second feature.
      audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW },
      status: 'AVAILABLE',
      claimMode: 'OWNER_SELECTS',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: 'dddddddd-dddd-4ddd-8ddd-000000000003' as ListingId,
      ownerId: CAROL,
      title: 'Record player',
      description: 'Belt needs replacing. Free to whoever draws it.',
      condition: 'WORN',
      currency: 'USD',
      photoKeys: [],
      audience: { kind: 'FRIENDS' },
      status: 'AVAILABLE',
      claimMode: 'LOTTERY',
      claimsCloseAt: at(base, 10, 20),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  return {
    profiles: PROFILES,
    listings,
    friendships: [
      [ALICE, BOB],
      [ALICE, CAROL],
      [ALICE, DAVE],
      [BOB, CAROL],
    ],
    // Directed: Alice blocked Mallory. Mallory has not blocked Alice.
    blocks: [[ALICE, MALLORY]],
    circles: [
      {
        id: CLIMBING_CREW,
        ownerId: ALICE,
        name: 'Climbing crew',
        memberIds: [BOB],
        createdAt: nowIso,
      },
    ],
    events: drafts.map((d) => build(base, d)),
    sharingDefaults: [
      [ALICE, CONSERVATIVE_SHARING_DEFAULTS],
      [BOB, CONSERVATIVE_SHARING_DEFAULTS],
      [CAROL, CONSERVATIVE_SHARING_DEFAULTS],
      // Dave has no entry on purpose: he shares nothing, which is what the
      // slot-finder callout in the design docs is about.
    ],
    hangouts,
  };
}
