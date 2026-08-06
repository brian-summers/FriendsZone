import {
  CONSERVATIVE_SHARING_DEFAULTS,
  type AuthIdentity,
  type AuthProvider,
  type Session,
  overlaps,
  type CalendarEvent,
  type Circle,
  type CircleId,
  type ShareRule,
  type Claim,
  type ClaimId,
  type EventId,
  type Exchange,
  type ExchangeId,
  type Friendship,
  type HangoutRequest,
  type HangoutRequestId,
  type Listing,
  type ListingId,
  type Notification,
  type PublicProfile,
  TOMBSTONE_DISPLAY_NAME,
  type Report,
  type ReportId,
  type ReportNote,
  type ReportReason,
  type RelationshipKind,
  type SharingDefaults,
  type TimeRange,
  type UserId,
} from '@friendszone/contracts';
import type {
  CalendarPort,
  CirclePort,
  CredentialPort,
  SessionPort,
  DirectoryPort,
  HangoutPort,
  ListingPort,
  ExchangePort,
  NotificationPort,
  NotifierPort,
  PhotoStorePort,
  ReportPort,
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
  circles?: Array<{
    id: CircleId;
    ownerId: UserId;
    memberIds: UserId[];
    name?: string;
    createdAt?: string;
  }>;
  events?: CalendarEvent[];
  sharingDefaults?: Array<[UserId, SharingDefaults]>;
  hangouts?: HangoutRequest[];
  listings?: Listing[];
  claims?: Claim[];
  identities?: AuthIdentity[];
  sessions?: Session[];
  notifications?: Notification[];
  exchanges?: Exchange[];
  reports?: Report[];
  reportNotes?: ReportNote[];
  tombstoned?: UserId[];
  /** Photo bytes, base64-encoded so the whole seed is JSON-serialisable. */
  photos?: Array<{ key: string; contentType: string; base64: string }>;
}

/**
 * Everything the process holds, in one JSON-safe value.
 *
 * `MemorySeed` and a snapshot are the *same shape* on purpose: a snapshot can
 * be fed straight back in as a seed, which is what makes restart-durability a
 * round trip rather than a translation layer (docs/adr/0025-durable-file-store.md).
 */
export type StoreSnapshot = Required<
  Pick<
    MemorySeed,
    | 'profiles'
    | 'friendships'
    | 'blocks'
    | 'circles'
    | 'events'
    | 'sharingDefaults'
    | 'hangouts'
    | 'listings'
    | 'claims'
    | 'identities'
    | 'sessions'
    | 'notifications'
    | 'exchanges'
    | 'reports'
    | 'reportNotes'
    | 'tombstoned'
    | 'photos'
  >
>;

/** Stand-in for seed circles written before circles carried a timestamp. */
const EPOCH = '2026-01-01T00:00:00.000Z';

const ordered = (a: UserId, b: UserId): [UserId, UserId] => (a < b ? [a, b] : [b, a]);
const pairKey = (a: UserId, b: UserId): string => ordered(a, b).join('|');

export class MemorySocialGraph implements SocialGraphPort {
  readonly #friendships = new Map<string, Friendship>();
  /**
   * **Directed**, keyed `blocker|blocked`. Not a canonical pair: if both
   * parties block each other there must be two entries, or one unblocking
   * would take the other's protection with it (ADR 0028).
   */
  readonly #blocks = new Set<string>();
  readonly #circles: NonNullable<MemorySeed['circles']>;

  constructor(seed: MemorySeed) {
    for (const [a, b] of seed.friendships ?? []) {
      const [low, high] = ordered(a, b);
      this.#friendships.set(pairKey(a, b), {
        lowUserId: low,
        highUserId: high,
        requestedBy: low,
        status: 'ACCEPTED',
        createdAt: EPOCH,
      });
    }
    // Seed pairs are written as [blocker, blocked].
    for (const [blocker, blocked] of seed.blocks ?? []) {
      this.#blocks.add(`${blocker}|${blocked}`);
    }
    this.#circles = seed.circles ?? [];
  }

  /**
   * ⚠️ **Lossy, and unsafely so.** `MemorySeed.friendships` is a bare pair, and
   * the constructor reads every pair back as `ACCEPTED` — so a round trip
   * through here silently promotes a *pending request* into a real friendship,
   * which is a grant of calendar visibility nobody made.
   *
   * Harmless today: nothing consumes `snapshot()`. It existed for the durable
   * file store of ADR 0025, which ADR 0026 replaced with Postgres and deleted.
   * Left in place because the seed shape is still how tests build a world —
   * but if anything ever persists this again, `friendships` has to carry
   * `status` and `requestedBy` first.
   */
  snapshot(): Pick<StoreSnapshot, 'friendships' | 'blocks'> {
    return {
      friendships: [...this.#friendships.values()]
        .filter((f) => f.status === 'ACCEPTED')
        .map((f) => [f.lowUserId, f.highUserId] as [UserId, UserId]),
      // `blocker|blocked`, matching the order the constructor reads them in.
      blocks: [...this.#blocks].map((k) => k.split('|') as [UserId, UserId]),
    };
  }

  #blockedEitherWay(a: UserId, b: UserId): boolean {
    return this.#blocks.has(`${a}|${b}`) || this.#blocks.has(`${b}|${a}`);
  }

  async relationship(viewerId: UserId | null, ownerId: UserId): Promise<RelationshipKind> {
    if (viewerId === null) return 'NONE';
    if (viewerId === ownerId) return 'SELF';
    // A block in *either* direction is a block, so no caller has to remember
    // to check both ways.
    if (this.#blockedEitherWay(viewerId, ownerId)) return 'BLOCKED';

    const friendship = this.#friendships.get(pairKey(viewerId, ownerId));
    if (friendship === undefined) return 'NONE';
    return friendship.status === 'ACCEPTED' ? 'FRIEND' : 'PENDING';
  }

  async friendship(a: UserId, b: UserId): Promise<Friendship | null> {
    return this.#friendships.get(pairKey(a, b)) ?? null;
  }

  async saveFriendship(friendship: Friendship): Promise<Friendship> {
    this.#friendships.set(pairKey(friendship.lowUserId, friendship.highUserId), friendship);
    return friendship;
  }

  async removeFriendship(a: UserId, b: UserId): Promise<void> {
    this.#friendships.delete(pairKey(a, b));
  }

  async pendingFriendships(userId: UserId): Promise<Friendship[]> {
    return [...this.#friendships.values()].filter(
      (f) =>
        f.status === 'PENDING' && (f.lowUserId === userId || f.highUserId === userId),
    );
  }

  async block(blockerId: UserId, blockedId: UserId): Promise<void> {
    this.#blocks.add(`${blockerId}|${blockedId}`);
  }

  async unblock(blockerId: UserId, blockedId: UserId): Promise<void> {
    // Only this caller's row. Theirs, if any, survives.
    this.#blocks.delete(`${blockerId}|${blockedId}`);
  }

  /** Accepted friends only, for `DirectoryPort.friendsOf`. */
  async friendIdsOf(userId: UserId): Promise<UserId[]> {
    return [...this.#friendships.values()]
      .filter((f) => f.status === 'ACCEPTED')
      .filter((f) => f.lowUserId === userId || f.highUserId === userId)
      .map((f) => (f.lowUserId === userId ? f.highUserId : f.lowUserId));
  }

  async blockedBy(blockerId: UserId): Promise<UserId[]> {
    return [...this.#blocks]
      .filter((k) => k.startsWith(`${blockerId}|`))
      .map((k) => k.split('|')[1] as UserId);
  }

  async sharedCircles(viewerId: UserId | null, ownerId: UserId): Promise<CircleId[]> {
    if (viewerId === null) return [];
    return this.#circles
      .filter((circle) => circle.ownerId === ownerId && circle.memberIds.includes(viewerId))
      .map((circle) => circle.id);
  }

  async eraseUser(userId: UserId): Promise<void> {
    for (const key of [...this.#friendships.keys()]) {
      if (key.split('|').includes(userId)) this.#friendships.delete(key);
    }
    for (const circle of this.#circles) {
      circle.memberIds = circle.memberIds.filter((id) => id !== userId);
    }
    // #blocks is deliberately untouched. ADR 0004 commits to retaining a
    // one-way hash of a blocked pair, and clearing it here would make
    // delete-and-rejoin a route back to someone who blocked you.
  }

  async contextsFor(
    viewerId: UserId | null,
    ownerIds: readonly UserId[],
  ): Promise<Map<UserId, { relationship: RelationshipKind; sharedCircleIds: CircleId[] }>> {
    const out = new Map<UserId, { relationship: RelationshipKind; sharedCircleIds: CircleId[] }>();
    // Every id asked about gets an entry, including ones that do not exist —
    // a missing key would distinguish "no such user" from "shares nothing".
    for (const ownerId of ownerIds) {
      out.set(ownerId, {
        relationship: await this.relationship(viewerId, ownerId),
        sharedCircleIds: await this.sharedCircles(viewerId, ownerId),
      });
    }
    return out;
  }
}

export class MemoryCredentials implements CredentialPort {
  readonly #identities: AuthIdentity[];

  constructor(seed: MemorySeed = {}) {
    this.#identities = [...(seed.identities ?? [])];
  }

  snapshot(): AuthIdentity[] {
    return [...this.#identities];
  }

  async identity(provider: AuthProvider, subject: string): Promise<AuthIdentity | null> {
    return (
      this.#identities.find((i) => i.provider === provider && i.subject === subject) ?? null
    );
  }

  async identitiesFor(userId: UserId): Promise<AuthIdentity[]> {
    return this.#identities.filter((i) => i.userId === userId);
  }

  async create(identity: AuthIdentity): Promise<AuthIdentity> {
    this.#identities.push(identity);
    return identity;
  }

  async save(identity: AuthIdentity): Promise<AuthIdentity> {
    const index = this.#identities.findIndex(
      (i) => i.provider === identity.provider && i.subject === identity.subject,
    );
    if (index === -1) this.#identities.push(identity);
    else this.#identities[index] = identity;
    return identity;
  }

  async eraseUser(userId: UserId): Promise<void> {
    for (let i = this.#identities.length - 1; i >= 0; i -= 1) {
      if (this.#identities[i]!.userId === userId) this.#identities.splice(i, 1);
    }
  }
}

export class MemorySessions implements SessionPort {
  readonly #sessions = new Map<string, Session>();

  constructor(seed: MemorySeed = {}) {
    for (const s of seed.sessions ?? []) this.#sessions.set(s.tokenHash, s);
  }

  snapshot(): Session[] {
    return [...this.#sessions.values()];
  }

  async byTokenHash(tokenHash: string): Promise<Session | null> {
    return this.#sessions.get(tokenHash) ?? null;
  }

  async create(session: Session): Promise<Session> {
    this.#sessions.set(session.tokenHash, session);
    return session;
  }

  async revoke(tokenHash: string): Promise<void> {
    this.#sessions.delete(tokenHash);
  }

  async revokeAllFor(userId: UserId): Promise<void> {
    for (const [hash, session] of this.#sessions) {
      if (session.userId === userId) this.#sessions.delete(hash);
    }
  }
}

/**
 * Circles share the seed array with `MemorySocialGraph`, so a circle created
 * here is immediately visible to `sharedCircles` — the same row, not a copy.
 * A relational adapter gets this for free; in memory it has to be deliberate.
 */
export class MemoryCircles implements CirclePort {
  readonly #circles: NonNullable<MemorySeed['circles']>;

  constructor(shared: NonNullable<MemorySeed['circles']>) {
    this.#circles = shared;
  }

  snapshot(): NonNullable<MemorySeed['circles']> {
    return [...this.#circles];
  }

  async ownedBy(ownerId: UserId): Promise<Circle[]> {
    return this.#circles
      .filter((c) => c.ownerId === ownerId)
      .map((c) => ({ ...c, name: c.name ?? 'Circle', createdAt: c.createdAt ?? EPOCH }));
  }

  async byId(id: CircleId): Promise<Circle | null> {
    const found = this.#circles.find((c) => c.id === id);
    if (found === undefined) return null;
    return { ...found, name: found.name ?? 'Circle', createdAt: found.createdAt ?? EPOCH };
  }

  async create(circle: Circle): Promise<Circle> {
    this.#circles.push(circle);
    return circle;
  }

  async save(circle: Circle): Promise<Circle> {
    const index = this.#circles.findIndex((c) => c.id === circle.id);
    if (index === -1) this.#circles.push(circle);
    else this.#circles[index] = circle;
    return circle;
  }

  async remove(id: CircleId): Promise<void> {
    const index = this.#circles.findIndex((c) => c.id === id);
    if (index !== -1) this.#circles.splice(index, 1);
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

  snapshot(): Pick<StoreSnapshot, 'events' | 'sharingDefaults'> {
    return { events: [...this.#events], sharingDefaults: [...this.#defaults] };
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

  async scrubCircleRules(ownerId: UserId, circleId: CircleId): Promise<void> {
    const drops = (rules: readonly ShareRule[]): ShareRule[] =>
      rules.filter((r) => !(r.audience.kind === 'CIRCLE' && r.audience.circleId === circleId));

    for (let i = 0; i < this.#events.length; i += 1) {
      const event = this.#events[i]!;
      if (event.ownerId !== ownerId) continue;
      const kept = drops(event.shareRules);
      if (kept.length !== event.shareRules.length) {
        this.#events[i] = { ...event, shareRules: kept };
      }
    }

    const defaults = this.#defaults.get(ownerId);
    if (defaults !== undefined) {
      this.#defaults.set(ownerId, { rules: drops(defaults.rules) });
    }
  }

  async eraseUser(ownerId: UserId): Promise<void> {
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      const event = this.#events[i]!;
      if (event.ownerId === ownerId) {
        this.#events.splice(i, 1);
        continue;
      }
      // Someone else's event that named this user as an attendee stays — it is
      // their record of their own week — but stops naming them.
      if (event.attendeeIds.includes(ownerId)) {
        this.#events[i] = {
          ...event,
          attendeeIds: event.attendeeIds.filter((id) => id !== ownerId),
        };
      }
    }
    this.#defaults.delete(ownerId);
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

  async hasExplicitSharingDefaults(ownerId: UserId): Promise<boolean> {
    return this.#defaults.has(ownerId);
  }
}

export class MemoryDirectory implements DirectoryPort {
  readonly #profiles: Map<UserId, PublicProfile>;
  readonly #tombstoned = new Set<UserId>();
  /**
   * Friendship is read back through the social graph rather than kept here.
   *
   * An earlier version copied the seed's friend pairs into this class, which
   * meant a friendship accepted through `saveFriendship` never appeared in
   * `friendsOf` — a request could be accepted and the friend would not show up.
   * The Postgres adapter joins one table, so only the in-memory one could
   * drift, and it did.
   */
  readonly #social: MemorySocialGraph;

  constructor(seed: MemorySeed, social: MemorySocialGraph) {
    this.#profiles = new Map((seed.profiles ?? []).map((p) => [p.id, p]));
    this.#social = social;
    for (const id of seed.tombstoned ?? []) this.#tombstoned.add(id);
  }

  snapshot(): Pick<StoreSnapshot, 'profiles' | 'tombstoned'> {
    return { profiles: [...this.#profiles.values()], tombstoned: [...this.#tombstoned] };
  }

  async profile(userId: UserId): Promise<PublicProfile | null> {
    return this.#profiles.get(userId) ?? null;
  }

  async create(profile: PublicProfile): Promise<PublicProfile> {
    this.#profiles.set(profile.id, profile);
    return profile;
  }

  async search(query: string, limit: number): Promise<PublicProfile[]> {
    const needle = query.trim().toLowerCase();
    return [...this.#profiles.values()]
      .filter((p) => !this.#tombstoned.has(p.id))
      .filter(
        (p) =>
          p.handle.toLowerCase().startsWith(needle) ||
          p.displayName.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, limit);
  }

  async handleTaken(handle: string): Promise<boolean> {
    for (const profile of this.#profiles.values()) {
      if (profile.handle === handle) return true;
    }
    return false;
  }

  async tombstone(userId: UserId): Promise<void> {
    if (!this.#profiles.has(userId)) return;
    // Emptied in place, id kept. Every hangout, handoff, and moderation case
    // referencing this id stays resolvable — and resolves to nothing.
    this.#profiles.set(userId, {
      id: userId,
      handle: `deleted-${userId.slice(0, 8)}`,
      displayName: TOMBSTONE_DISPLAY_NAME,
    });
    this.#tombstoned.add(userId);
  }

  async isTombstoned(userId: UserId): Promise<boolean> {
    return this.#tombstoned.has(userId);
  }

  async friendsOf(userId: UserId): Promise<PublicProfile[]> {
    // Accepted only. A pending request granting friend-level visibility would
    // mean asking to be someone's friend was enough to read their calendar.
    const ids = await this.#social.friendIdsOf(userId);

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

  snapshot(): HangoutRequest[] {
    return [...this.#requests];
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

  async eraseUser(userId: UserId): Promise<void> {
    for (let i = this.#requests.length - 1; i >= 0; i -= 1) {
      const request = this.#requests[i]!;
      if (request.proposerId === userId) {
        this.#requests.splice(i, 1);
        continue;
      }
      if (!request.inviteeIds.includes(userId)) continue;

      const inviteeIds = request.inviteeIds.filter((id) => id !== userId);
      // A request with nobody left to answer it records nothing.
      if (inviteeIds.length === 0) this.#requests.splice(i, 1);
      else this.#requests[i] = { ...request, inviteeIds };
    }
  }
}

export class MemoryNotifications implements NotificationPort {
  readonly #items: Notification[];

  constructor(seed: MemorySeed = {}) {
    this.#items = [...(seed.notifications ?? [])];
  }

  snapshot(): Notification[] {
    return [...this.#items];
  }

  async create(notification: Notification): Promise<Notification> {
    this.#items.push(notification);
    return notification;
  }

  async forUser(userId: UserId): Promise<Notification[]> {
    return this.#items
      .filter((n) => n.recipientId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async eraseUser(userId: UserId): Promise<void> {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i]!;
      if (item.recipientId === userId || item.actorId === userId) this.#items.splice(i, 1);
    }
  }
}

export class MemoryListings implements ListingPort {
  readonly #listings: Listing[];
  readonly #claims: Claim[];

  constructor(seed: MemorySeed) {
    this.#listings = [...(seed.listings ?? [])];
    this.#claims = [...(seed.claims ?? [])];
  }

  async create(listing: Listing): Promise<Listing> {
    this.#listings.push(listing);
    return listing;
  }

  snapshot(): Pick<StoreSnapshot, 'listings' | 'claims'> {
    return { listings: [...this.#listings], claims: [...this.#claims] };
  }

  async byId(id: ListingId): Promise<Listing | null> {
    return this.#listings.find((l) => l.id === id) ?? null;
  }

  async save(listing: Listing): Promise<Listing> {
    const index = this.#listings.findIndex((l) => l.id === listing.id);
    if (index === -1) this.#listings.push(listing);
    else this.#listings[index] = listing;
    return listing;
  }

  async recent(limit: number): Promise<Listing[]> {
    return this.#listings
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  async claimsFor(listingId: ListingId): Promise<Claim[]> {
    // Oldest first: FIRST_COME depends on this order being arrival order, and a
    // draw over a stably-ordered list is reproducible from its seed.
    return this.#claims
      .filter((c) => c.listingId === listingId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async claimById(id: ClaimId): Promise<Claim | null> {
    return this.#claims.find((c) => c.id === id) ?? null;
  }

  async createClaim(claim: Claim): Promise<Claim> {
    this.#claims.push(claim);
    return claim;
  }

  async saveClaim(claim: Claim): Promise<Claim> {
    const index = this.#claims.findIndex((c) => c.id === claim.id);
    if (index === -1) this.#claims.push(claim);
    else this.#claims[index] = claim;
    return claim;
  }

  async eraseUser(userId: UserId): Promise<{ photoKeys: string[] }> {
    const photoKeys: string[] = [];
    const goneListingIds = new Set<string>();

    for (let i = this.#listings.length - 1; i >= 0; i -= 1) {
      const listing = this.#listings[i]!;
      if (listing.ownerId !== userId) continue;
      photoKeys.push(...listing.photoKeys);
      goneListingIds.add(listing.id);
      this.#listings.splice(i, 1);
    }

    for (let i = this.#claims.length - 1; i >= 0; i -= 1) {
      const claim = this.#claims[i]!;
      // Their own claims, and everyone's claims on a listing that is now gone.
      if (claim.claimantId === userId || goneListingIds.has(claim.listingId)) {
        this.#claims.splice(i, 1);
      }
    }

    return { photoKeys };
  }
}

export class MemoryPhotoStore implements PhotoStorePort {
  readonly #photos = new Map<string, { contentType: string; bytes: Uint8Array }>();

  constructor(seed: MemorySeed = {}) {
    for (const p of seed.photos ?? []) {
      this.#photos.set(p.key, {
        contentType: p.contentType,
        bytes: new Uint8Array(Buffer.from(p.base64, 'base64')),
      });
    }
  }

  /** Base64 so the snapshot stays JSON. Inflates bytes by a third — the
   *  reason object storage is the real answer (ADR 0025). */
  snapshot(): NonNullable<MemorySeed['photos']> {
    return [...this.#photos].map(([key, p]) => ({
      key,
      contentType: p.contentType,
      base64: Buffer.from(p.bytes).toString('base64'),
    }));
  }

  async put(key: string, photo: { contentType: string; bytes: Uint8Array }): Promise<void> {
    this.#photos.set(key, photo);
  }

  async get(key: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
    return this.#photos.get(key) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.#photos.delete(key);
  }
}

export class MemoryExchanges implements ExchangePort {
  readonly #exchanges: Exchange[];

  constructor(seed: MemorySeed = {}) {
    this.#exchanges = [...(seed.exchanges ?? [])];
  }

  snapshot(): Exchange[] {
    return [...this.#exchanges];
  }

  async create(exchange: Exchange): Promise<Exchange> {
    this.#exchanges.push(exchange);
    return exchange;
  }

  async byId(id: ExchangeId): Promise<Exchange | null> {
    return this.#exchanges.find((e) => e.id === id) ?? null;
  }

  async forClaim(claimId: ClaimId): Promise<Exchange | null> {
    // Newest wins. A cancelled handoff may be followed by a fresh attempt, and
    // the live one is the one being arranged now.
    return (
      this.#exchanges
        .filter((e) => e.claimId === claimId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
    );
  }

  async save(exchange: Exchange): Promise<Exchange> {
    const index = this.#exchanges.findIndex((e) => e.id === exchange.id);
    if (index === -1) this.#exchanges.push(exchange);
    else this.#exchanges[index] = exchange;
    return exchange;
  }

  async eraseUser(userId: UserId): Promise<void> {
    // Claims are swept first, so this catches what they left behind.
    // `proposedBy` is the only user id an exchange carries directly.
    for (let i = this.#exchanges.length - 1; i >= 0; i -= 1) {
      if (this.#exchanges[i]!.proposedBy === userId) this.#exchanges.splice(i, 1);
    }
  }
}

export class MemoryReports implements ReportPort {
  readonly #reports: Report[];
  readonly #notes: ReportNote[];

  constructor(seed: MemorySeed = {}) {
    this.#reports = [...(seed.reports ?? [])];
    this.#notes = [...(seed.reportNotes ?? [])];
  }

  snapshot(): Pick<StoreSnapshot, 'reports' | 'reportNotes'> {
    return { reports: [...this.#reports], reportNotes: [...this.#notes] };
  }

  async create(report: Report): Promise<Report> {
    this.#reports.push(report);
    return report;
  }

  async byId(id: ReportId): Promise<Report | null> {
    return this.#reports.find((r) => r.id === id) ?? null;
  }

  async save(report: Report): Promise<Report> {
    const index = this.#reports.findIndex((r) => r.id === report.id);
    if (index === -1) this.#reports.push(report);
    else this.#reports[index] = report;
    return report;
  }

  async filedBy(reporterId: UserId): Promise<Report[]> {
    return this.#reports
      .filter((r) => r.reporterId === reporterId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async notifiedTo(subjectUserId: UserId): Promise<Report[]> {
    // The `subjectNotified` test lives here, not at the call site: a report the
    // subject has not been contacted about must never leave this method.
    return this.#reports
      .filter((r) => r.subjectUserId === subjectUserId && r.subjectNotified)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async queue(limit: number): Promise<Report[]> {
    return this.#reports
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  async openCount(reporterId: UserId, subjectUserId: UserId): Promise<number> {
    return this.#reports.filter(
      (r) =>
        r.reporterId === reporterId &&
        r.subjectUserId === subjectUserId &&
        (r.status === 'OPEN' || r.status === 'AWAITING_INFO'),
    ).length;
  }

  async notesFor(reportId: ReportId): Promise<ReportNote[]> {
    return this.#notes
      .filter((n) => n.reportId === reportId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async addNote(note: ReportNote): Promise<ReportNote> {
    this.#notes.push(note);
    return note;
  }

  async eraseUser(userId: UserId): Promise<void> {
    const live = (r: Report): boolean => r.status === 'OPEN' || r.status === 'AWAITING_INFO';

    for (let i = this.#reports.length - 1; i >= 0; i -= 1) {
      const report = this.#reports[i]!;
      const involved = report.subjectUserId === userId || report.reporterId === userId;
      if (!involved) continue;

      /**
       * A live case survives, whichever side is leaving.
       *
       * Kept when they are the *subject*, or deletion is an escape hatch from
       * moderation: harass, get reported, delete, case evaporates. Kept when
       * they are the *reporter*, because the case protects someone else — and
       * the filer is tombstoned by the time this runs, so anonymity holds
       * (ADR 0022).
       */
      if (live(report)) continue;

      const goneId = report.id;
      this.#reports.splice(i, 1);
      for (let j = this.#notes.length - 1; j >= 0; j -= 1) {
        if (this.#notes[j]!.reportId === goneId) this.#notes.splice(j, 1);
      }
    }
  }
}

/**
 * Development notifier: writes the pointer to the log and nothing leaves the
 * process. No SMTP credential exists yet, and inventing one to make a demo feel
 * real is how a half-configured mail path reaches production.
 */
export class LoggingNotifier implements NotifierPort {
  readonly sent: Array<{ reportId: string; reason: string; subjectKind: string }> = [];

  async reportFiled(pointer: {
    reportId: ReportId;
    reason: ReportReason;
    subjectKind: 'LISTING' | 'HANGOUT' | 'USER';
  }): Promise<void> {
    this.sent.push({
      reportId: pointer.reportId,
      reason: pointer.reason,
      subjectKind: pointer.subjectKind,
    });
    // Reason and kind only. There is no parameter here that could carry a name,
    // a title, or a line of someone's message, which is the point of the port's
    // signature rather than a discipline this adapter has to keep.
    console.info(
      `[report] filed ${pointer.reportId} reason=${pointer.reason} kind=${pointer.subjectKind}`,
    );
  }
}

export const createMemoryRepositories = (seed: MemorySeed = {}): Repositories => {
  // One array, two adapters. A circle created through `CirclePort` has to be
  // visible to `sharedCircles` immediately or audiences would lag behind edits.
  const circles = seed.circles ?? [];
  const withShared: MemorySeed = { ...seed, circles };

  // One social graph, two adapters: `friendsOf` reads it rather than keeping a
  // second copy, so an accepted request shows up in the friend list at once.
  const social = new MemorySocialGraph(withShared);

  return {
  social,
  calendar: new MemoryCalendar(seed),
  directory: new MemoryDirectory(seed, social),
  hangouts: new MemoryHangouts(seed),
  notifications: new MemoryNotifications(withShared),
  listings: new MemoryListings(seed),
  photos: new MemoryPhotoStore(withShared),
  circles: new MemoryCircles(circles),
  credentials: new MemoryCredentials(withShared),
  sessions: new MemorySessions(withShared),
  exchanges: new MemoryExchanges(withShared),
  reports: new MemoryReports(withShared),
  notifier: new LoggingNotifier(),
  };
};
