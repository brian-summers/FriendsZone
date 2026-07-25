import {
  CONSERVATIVE_SHARING_DEFAULTS,
  overlaps,
  type CalendarEvent,
  type CircleId,
  type EventId,
  type HangoutRequest,
  type HangoutRequestId,
  type Notification,
  type PublicProfile,
  type RelationshipKind,
  type SharingDefaults,
  type TimeRange,
  type UserId,
} from '@friendszone/contracts';
import type {
  CalendarPort,
  DirectoryPort,
  HangoutPort,
  NotificationPort,
  Repositories,
  SocialGraphPort,
} from './ports.js';

/**
 * In-memory adapter for local development and tests.
 *
 * Not a stub with hardcoded `true` returns: it implements the same semantics a
 * real store must, including the bidirectional block rule. Tests written
 * against it therefore remain meaningful once Postgres replaces it.
 */
export interface MemorySeed {
  profiles?: PublicProfile[];
  friendships?: Array<[UserId, UserId]>;
  blocks?: Array<[UserId, UserId]>;
  circles?: Array<{ id: CircleId; ownerId: UserId; memberIds: UserId[] }>;
  events?: CalendarEvent[];
  sharingDefaults?: Array<[UserId, SharingDefaults]>;
  hangouts?: HangoutRequest[];
}

const pairKey = (a: UserId, b: UserId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class MemorySocialGraph implements SocialGraphPort {
  readonly #friends = new Set<string>();
  readonly #blocks = new Set<string>();
  readonly #circles: NonNullable<MemorySeed['circles']>;

  constructor(seed: MemorySeed) {
    for (const [a, b] of seed.friendships ?? []) this.#friends.add(pairKey(a, b));
    // Stored undirected: a block by either party is a block for both.
    for (const [a, b] of seed.blocks ?? []) this.#blocks.add(pairKey(a, b));
    this.#circles = seed.circles ?? [];
  }

  async relationship(viewerId: UserId | null, ownerId: UserId): Promise<RelationshipKind> {
    if (viewerId === null) return 'NONE';
    if (viewerId === ownerId) return 'SELF';
    if (this.#blocks.has(pairKey(viewerId, ownerId))) return 'BLOCKED';
    if (this.#friends.has(pairKey(viewerId, ownerId))) return 'FRIEND';
    return 'NONE';
  }

  async sharedCircles(viewerId: UserId | null, ownerId: UserId): Promise<CircleId[]> {
    if (viewerId === null) return [];
    return this.#circles
      .filter((circle) => circle.ownerId === ownerId && circle.memberIds.includes(viewerId))
      .map((circle) => circle.id);
  }
}

export class MemoryCalendar implements CalendarPort {
  readonly #events: CalendarEvent[];
  readonly #defaults: Map<UserId, SharingDefaults>;

  constructor(seed: MemorySeed) {
    // Copied, not aliased: the seed is shared across a test suite and mutating
    // it in place would leak state between cases.
    this.#events = [...(seed.events ?? [])];
    this.#defaults = new Map(seed.sharingDefaults ?? []);
  }

  async eventsInWindow(ownerId: UserId, window: TimeRange): Promise<CalendarEvent[]> {
    return this.#events.filter(
      (event) => event.ownerId === ownerId && overlaps(event.timeRange, window),
    );
  }

  async eventById(eventId: EventId): Promise<CalendarEvent | null> {
    return this.#events.find((event) => event.id === eventId) ?? null;
  }

  async create(event: CalendarEvent): Promise<CalendarEvent> {
    this.#events.push(event);
    return event;
  }

  async update(event: CalendarEvent): Promise<CalendarEvent> {
    const index = this.#events.findIndex((e) => e.id === event.id);
    if (index === -1) this.#events.push(event);
    else this.#events[index] = event;
    return event;
  }

  async remove(eventId: EventId): Promise<void> {
    const index = this.#events.findIndex((e) => e.id === eventId);
    if (index !== -1) this.#events.splice(index, 1);
  }

  async sharingDefaults(ownerId: UserId): Promise<SharingDefaults> {
    // A user with no configured policy gets the conservative one. The fallback
    // must never be "share everything" — an absent row is not consent.
    return this.#defaults.get(ownerId) ?? CONSERVATIVE_SHARING_DEFAULTS;
  }

  async setSharingDefaults(ownerId: UserId, defaults: SharingDefaults): Promise<SharingDefaults> {
    this.#defaults.set(ownerId, defaults);
    return defaults;
  }
}

export class MemoryDirectory implements DirectoryPort {
  readonly #profiles: Map<UserId, PublicProfile>;
  readonly #friends: Array<[UserId, UserId]>;

  constructor(seed: MemorySeed) {
    this.#profiles = new Map((seed.profiles ?? []).map((p) => [p.id, p]));
    this.#friends = seed.friendships ?? [];
  }

  async profile(userId: UserId): Promise<PublicProfile | null> {
    return this.#profiles.get(userId) ?? null;
  }

  async friendsOf(userId: UserId): Promise<PublicProfile[]> {
    const ids = this.#friends
      .filter(([a, b]) => a === userId || b === userId)
      .map(([a, b]) => (a === userId ? b : a));

    return ids
      .map((id) => this.#profiles.get(id))
      .filter((p): p is PublicProfile => p !== undefined)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}

export class MemoryHangouts implements HangoutPort {
  readonly #requests: HangoutRequest[];

  constructor(seed: MemorySeed) {
    this.#requests = [...(seed.hangouts ?? [])];
  }

  async create(request: HangoutRequest): Promise<HangoutRequest> {
    this.#requests.push(request);
    return request;
  }

  async byId(id: HangoutRequestId): Promise<HangoutRequest | null> {
    return this.#requests.find((r) => r.id === id) ?? null;
  }

  async received(userId: UserId): Promise<HangoutRequest[]> {
    return this.#requests
      .filter((r) => r.inviteeIds.includes(userId))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async sent(userId: UserId): Promise<HangoutRequest[]> {
    return this.#requests
      .filter((r) => r.proposerId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async pendingInvolving(userId: UserId): Promise<HangoutRequest[]> {
    return this.#requests.filter(
      (r) =>
        r.status === 'PENDING' &&
        (r.proposerId === userId || r.inviteeIds.includes(userId)),
    );
  }

  async save(request: HangoutRequest): Promise<HangoutRequest> {
    const index = this.#requests.findIndex((r) => r.id === request.id);
    if (index === -1) this.#requests.push(request);
    else this.#requests[index] = request;
    return request;
  }
}

export class MemoryNotifications implements NotificationPort {
  readonly #items: Notification[] = [];

  async create(notification: Notification): Promise<Notification> {
    this.#items.push(notification);
    return notification;
  }

  async forUser(userId: UserId): Promise<Notification[]> {
    return this.#items
      .filter((n) => n.recipientId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

export const createMemoryRepositories = (seed: MemorySeed = {}): Repositories => ({
  social: new MemorySocialGraph(seed),
  calendar: new MemoryCalendar(seed),
  directory: new MemoryDirectory(seed),
  hangouts: new MemoryHangouts(seed),
  notifications: new MemoryNotifications(),
});
