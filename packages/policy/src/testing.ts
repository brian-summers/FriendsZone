import type {
  CalendarEvent,
  CircleId,
  EventId,
  HangoutRequest,
  HangoutRequestId,
  SharingDefaults,
  ShareRule,
  TimeRange,
  UserId,
  VisibilityLevel,
} from '@friendszone/contracts';
import type { ViewerContext } from './viewer.js';

/**
 * Fixtures for exercising the policy engine.
 *
 * Exported from `@friendszone/policy/testing` so that the API layer and any
 * future service can build the same scenarios without redefining them. Shared
 * fixtures matter here specifically: when a security test in one package and a
 * security test in another disagree about what "a friend in a circle" looks
 * like, one of them is testing nothing.
 */

export const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
export const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
export const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;
export const CLIMBING_CREW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CircleId;
export const WORK_CIRCLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CircleId;

export const viewer = (overrides: Partial<ViewerContext> = {}): ViewerContext => ({
  viewerId: BOB,
  relationship: 'NONE',
  sharedCircleIds: [],
  ...overrides,
});

export const asOwner = (): ViewerContext =>
  viewer({ viewerId: ALICE, relationship: 'SELF' });

export const asFriend = (circles: CircleId[] = []): ViewerContext =>
  viewer({ relationship: 'FRIEND', sharedCircleIds: circles });

export const asStranger = (): ViewerContext => viewer({ relationship: 'NONE' });

export const asBlocked = (): ViewerContext => viewer({ relationship: 'BLOCKED' });

export const asAnonymous = (): ViewerContext =>
  viewer({ viewerId: null, relationship: 'NONE' });

/** `hours(9, 10)` → 09:00–10:00 UTC on the reference day. */
export const hours = (startHour: number, endHour: number): TimeRange => ({
  start: `2026-03-02T${String(startHour).padStart(2, '0')}:00:00.000Z`,
  end: `2026-03-02T${String(endHour).padStart(2, '0')}:00:00.000Z`,
});

/** The whole reference day. Written out because "24:00" is not portable. */
export const DAY: TimeRange = {
  start: '2026-03-02T00:00:00.000Z',
  end: '2026-03-03T00:00:00.000Z',
};

let eventCounter = 0;

export const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => {
  eventCounter += 1;
  const suffix = String(eventCounter).padStart(12, '0');
  return {
    id: `cccccccc-cccc-4ccc-8ccc-${suffix}` as EventId,
    ownerId: ALICE,
    timeRange: hours(9, 10),
    title: 'Dentist',
    description: 'Back left molar',
    location: '400 Elm St',
    status: 'CONFIRMED',
    visibilityCeiling: 'FULL',
    shareRules: [],
    attendeeIds: [],
    // The fixture defaults to *exclusive* so tests that reason about `busy`
    // exercise a hard commitment. The product default is the opposite —
    // non-exclusive/overlappable — which the "overlap by default" tests set
    // explicitly.
    exclusive: true,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
};

export const rule = (audience: ShareRule['audience'], level: VisibilityLevel): ShareRule => ({
  audience,
  level,
});

export const defaults = (rules: ShareRule[] = []): SharingDefaults => ({ rules });

export const DAVE = '44444444-4444-4444-8444-444444444444' as UserId;

let hangoutCounter = 0;

export const hangout = (overrides: Partial<HangoutRequest> = {}): HangoutRequest => {
  hangoutCounter += 1;
  const suffix = String(hangoutCounter).padStart(12, '0');
  return {
    id: `eeeeeeee-eeee-4eee-8eee-${suffix}` as HangoutRequestId,
    proposerId: BOB,
    inviteeIds: [ALICE],
    kind: 'FIXED',
    title: 'Climb?',
    proposedSlots: [hours(19, 21)],
    status: 'PENDING',
    responses: [],
    resultingEventIds: [],
    expiresAt: '2026-03-09T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
};
