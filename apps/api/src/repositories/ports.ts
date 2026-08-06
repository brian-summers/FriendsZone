import type {
  AuthIdentity,
  AuthProvider,
  CalendarEvent,
  Circle,
  CircleId,
  Claim,
  Friendship,
  ClaimId,
  EventId,
  Exchange,
  ExchangeId,
  HangoutRequest,
  HangoutRequestId,
  Listing,
  ListingId,
  Notification,
  PublicProfile,
  RelationshipKind,
  Report,
  Session,
  ReportId,
  ReportNote,
  ReportReason,
  SharingDefaults,
  TimeRange,
  UserId,
} from '@friendszone/contracts';

/**
 * The interfaces the application depends on, defined here rather than in the
 * adapter that implements them.
 *
 * The first pass ships an in-memory adapter so the architecture can be exercised
 * end to end before a database exists. Swapping in Postgres means writing a new
 * implementation of these ports and changing one line in `server.ts` — no route
 * or policy code moves. See docs/adr/0004-persistence.md.
 */

export interface SocialGraphPort {
  /**
   * The viewer's relationship to `ownerId`, from the viewer's perspective.
   *
   * Implementations MUST return `'BLOCKED'` when a block exists in *either*
   * direction. Collapsing both directions into one answer here means no caller
   * can forget to check the other way round.
   */
  relationship(viewerId: UserId | null, ownerId: UserId): Promise<RelationshipKind>;

  /** Circles owned by `ownerId` that `viewerId` belongs to. Empty if none. */
  sharedCircles(viewerId: UserId | null, ownerId: UserId): Promise<CircleId[]>;

  /**
   * The same two facts, for many owners at once.
   *
   * Exists because the slot finder needs one relationship lookup *per
   * participant* per query, and doing that through the single-owner methods is
   * an N+1 on the hottest new endpoint (ADR 0008).
   *
   * Implementations MUST return an entry for **every** id asked about, falling
   * back to `'NONE'` with no circles for an owner that does not exist. A missing
   * key would let a caller distinguish "no such user" from "a user who shares
   * nothing", which is exactly the difference the rest of the API works to
   * erase.
   */
  contextsFor(
    viewerId: UserId | null,
    ownerIds: readonly UserId[],
  ): Promise<Map<UserId, { relationship: RelationshipKind; sharedCircleIds: CircleId[] }>>;

  /** The friendship row for a pair, accepted or pending. `null` if none. */
  friendship(a: UserId, b: UserId): Promise<Friendship | null>;

  /** Create or replace one. The caller has decided it is allowed. */
  saveFriendship(friendship: Friendship): Promise<Friendship>;

  /** Remove it. Covers unfriend, withdraw, and decline — one write, three words. */
  removeFriendship(a: UserId, b: UserId): Promise<void>;

  /** Pending requests involving this user, either direction. */
  pendingFriendships(userId: UserId): Promise<Friendship[]>;

  /**
   * Block `blockedId` on behalf of `blockerId`. **Directed**: this must not
   * disturb a block the other party holds (ADR 0028).
   */
  block(blockerId: UserId, blockedId: UserId): Promise<void>;

  /** Remove only *this* caller's block. Idempotent. */
  unblock(blockerId: UserId, blockedId: UserId): Promise<void>;

  /** Who this user has blocked. Theirs alone — never projected to anyone else. */
  blockedBy(blockerId: UserId): Promise<UserId[]>;

  /**
   * Erase this user's friendships and circle memberships.
   *
   * **Blocks are deliberately not erased.** ADR 0004 commits to retaining a
   * one-way hash of a blocked pair, and ADR 0022 explains why deletion must not
   * clear one: otherwise deleting and re-registering is a documented route back
   * to someone who blocked you. Implementations MUST keep blocks answerable
   * after this call.
   */
  eraseUser(userId: UserId): Promise<void>;
}

export interface CalendarPort {
  /**
   * Every event owned by `ownerId` overlapping `window`, unfiltered.
   *
   * This returns raw rows on purpose. Filtering belongs to the policy engine,
   * and splitting it between here and there would mean two places to audit and
   * two places to get it wrong. Callers are responsible for passing the result
   * through `projectCalendar` before it reaches a client.
   */
  eventsInWindow(ownerId: UserId, window: TimeRange): Promise<CalendarEvent[]>;

  /** A single event by id, or `null`. Ownership is the caller's to enforce. */
  eventById(eventId: EventId): Promise<CalendarEvent | null>;

  /**
   * Persist a new event and return the stored row.
   *
   * The port takes a fully-formed `CalendarEvent`: the caller has already set
   * `ownerId` from the authenticated actor and minted the id. Keeping identity
   * assignment in the route rather than here means the trust boundary — "the
   * owner is the caller, never the request body" — lives next to the auth
   * check, where a reviewer can see both at once.
   */
  create(event: CalendarEvent): Promise<CalendarEvent>;

  /**
   * Replace an existing event. Used to move, edit, or cancel hangout events on
   * both participants' calendars. Ownership/authorization is the caller's to
   * enforce (a hangout operation authorized by participation), never inferred
   * here.
   */
  update(event: CalendarEvent): Promise<CalendarEvent>;

  /** Remove an event. No-op if it is already gone. */
  remove(eventId: EventId): Promise<void>;

  /** The owner's baseline sharing policy, used for events with no own rules. */
  sharingDefaults(ownerId: UserId): Promise<SharingDefaults>;

  /**
   * Drop every `CIRCLE` share rule naming `circleId` from this owner's events
   * and sharing defaults.
   *
   * Called when a circle is deleted. A rule naming a gone circle already fails
   * closed — `sharedCircles` cannot return an id that no longer exists — so
   * this is tidiness backed by a safe default, not the control itself
   * (ADR 0023).
   */
  scrubCircleRules(ownerId: UserId, circleId: CircleId): Promise<void>;

  /** Erase every event this user owns, plus their sharing defaults. */
  eraseUser(ownerId: UserId): Promise<void>;

  /** Replace the owner's baseline sharing policy. */
  setSharingDefaults(ownerId: UserId, defaults: SharingDefaults): Promise<SharingDefaults>;

  /**
   * Has this owner ever explicitly saved sharing defaults?
   *
   * Separate from `sharingDefaults`, which deliberately answers "what applies"
   * and returns the conservative fallback for an absent row. This answers the
   * different question "did they choose", which onboarding needs and which the
   * fallback would otherwise hide (ADR 0021).
   */
  hasExplicitSharingDefaults(ownerId: UserId): Promise<boolean>;
}

export interface NotificationPort {
  create(notification: Notification): Promise<Notification>;

  /** Notifications addressed to `userId`, newest first. Theirs alone. */
  forUser(userId: UserId): Promise<Notification[]>;

  eraseUser(userId: UserId): Promise<void>;
}

export interface DirectoryPort {
  /**
   * Returns `null` for an unknown id rather than throwing.
   *
   * "No such user" and "not allowed to see this user" must be the same
   * observable outcome at the HTTP edge, so the port deliberately does not
   * distinguish them either — a thrown NotFound here would tempt a handler
   * into a distinguishable error path.
   */
  profile(userId: UserId): Promise<PublicProfile | null>;

  /** Accepted friends only. Pending requests and blocks are excluded. */
  friendsOf(userId: UserId): Promise<PublicProfile[]>;

  /**
   * Create a profile. The caller has already minted the id and checked that
   * the handle is free — the port stores what it is given.
   */
  create(profile: PublicProfile): Promise<PublicProfile>;

  /** Whether a handle is taken. Handles are public, so this leaks nothing. */
  handleTaken(handle: string): Promise<boolean>;

  /**
   * Prefix search over handle and display name, **unfiltered by blocks**.
   *
   * Like every other port this returns raw rows; the route removes anyone in a
   * block relationship, in either direction, so that a blocked pair are
   * indistinguishable from people who do not exist (ADR 0028). Tombstoned
   * accounts are excluded here, because a deleted user is not a person any
   * caller could befriend.
   */
  search(query: string, limit: number): Promise<PublicProfile[]>;

  /**
   * Empty this user's profile in place, keeping the id.
   *
   * A tombstone rather than a removal: every hangout, handoff, and moderation
   * case that references this id must stay resolvable, and a dangling reference
   * in a system whose safety depends on resolving ids correctly is how one
   * person's data reappears attached to another (ADR 0022).
   */
  tombstone(userId: UserId): Promise<void>;

  /** Whether this id belongs to a deleted account. */
  isTombstoned(userId: UserId): Promise<boolean>;
}

export interface HangoutPort {
  create(request: HangoutRequest): Promise<HangoutRequest>;

  byId(id: HangoutRequestId): Promise<HangoutRequest | null>;

  /** Requests where `userId` is an invitee — their inbox. Newest first. */
  received(userId: UserId): Promise<HangoutRequest[]>;

  /** Requests `userId` proposed — their outbox. Newest first. */
  sent(userId: UserId): Promise<HangoutRequest[]>;

  /**
   * Pending requests `userId` is a party to (as proposer or invitee). Feeds the
   * tentative holds shown on their calendar. Terminal requests are excluded —
   * they are no longer tentative.
   */
  pendingInvolving(userId: UserId): Promise<HangoutRequest[]>;

  /** Persist a status/response change to an existing request. */
  save(request: HangoutRequest): Promise<HangoutRequest>;

  /**
   * Remove requests this user proposed, and drop them from others' invitee
   * lists. A request with no remaining parties goes too.
   *
   * The calendar events a resolved hangout produced are **not** touched here:
   * each belongs to its own owner, and the counterparty's copy is their record
   * of their own week (ADR 0022).
   */
  eraseUser(userId: UserId): Promise<void>;
}

/**
 * Circles: the owner's private groupings of their friends.
 *
 * Every method takes the owner's id and the route proves it is the caller.
 * There is deliberately no lookup by *member* — "which circles am I in" is a
 * question this product does not answer (ADR 0023).
 */
/**
 * Credentials and sessions. 🔴 Restricted — nothing here is ever projected.
 *
 * Kept apart from `DirectoryPort` on purpose: profiles are read on almost every
 * request, credentials on two routes. A store that answers both is a store where
 * an over-broad query returns a password hash.
 */
export interface CredentialPort {
  /** Look up an identity by provider and subject. `null` if there is none. */
  identity(provider: AuthProvider, subject: string): Promise<AuthIdentity | null>;

  /** Every identity a user holds. Used when revoking or listing sign-in methods. */
  identitiesFor(userId: UserId): Promise<AuthIdentity[]>;

  create(identity: AuthIdentity): Promise<AuthIdentity>;

  /** Replace the stored secret — a password change. */
  save(identity: AuthIdentity): Promise<AuthIdentity>;

  eraseUser(userId: UserId): Promise<void>;
}

export interface SessionPort {
  /**
   * Look a session up by the **hash** of its token. There is deliberately no
   * method taking a raw token: hashing is the caller's job and the port cannot
   * be handed a credential it might log.
   */
  byTokenHash(tokenHash: string): Promise<Session | null>;

  create(session: Session): Promise<Session>;

  revoke(tokenHash: string): Promise<void>;

  /** Every session for a user. Used on password change and on deletion. */
  revokeAllFor(userId: UserId): Promise<void>;
}

export interface CirclePort {
  /** Circles this user owns. Theirs alone. */
  ownedBy(ownerId: UserId): Promise<Circle[]>;

  /** A single circle, or `null`. Ownership is the caller's to enforce. */
  byId(id: CircleId): Promise<Circle | null>;

  create(circle: Circle): Promise<Circle>;

  save(circle: Circle): Promise<Circle>;

  remove(id: CircleId): Promise<void>;
}

export interface ListingPort {
  create(listing: Listing): Promise<Listing>;

  byId(id: ListingId): Promise<Listing | null>;

  /** Persist a status/field change to an existing listing. */
  save(listing: Listing): Promise<Listing>;

  /**
   * The most recently created listings, newest first, **unfiltered by
   * visibility** — like every other port, this returns raw rows and leaves
   * filtering to the policy engine.
   *
   * `limit` is required rather than defaulted: an unbounded listing feed is a
   * bulk-export vector, and a default is a cap someone forgets to pass.
   *
   * A note for whoever writes the Postgres adapter: it will be tempting to push
   * the audience test into SQL so the database does not scan every row. Doing
   * that as a *pre-narrowing* (owner is self, a friend, or the listing is
   * public) is fine and necessary. Doing it as a *replacement* for
   * `projectListing` is the second implementation of the visibility model that
   * this architecture exists to prevent — the projection must still run.
   */
  recent(limit: number): Promise<Listing[]>;

  /** Every claim on a listing, oldest first. The order the draw sees. */
  claimsFor(listingId: ListingId): Promise<Claim[]>;

  claimById(id: ClaimId): Promise<Claim | null>;

  createClaim(claim: Claim): Promise<Claim>;

  saveClaim(claim: Claim): Promise<Claim>;

  /**
   * Remove this user's listings and their claims.
   *
   * Returns the photo keys that were referenced, so the caller can erase the
   * bytes too — the blob store has no index by owner and should not grow one.
   */
  eraseUser(userId: UserId): Promise<{ photoKeys: string[] }>;
}

/**
 * Binary storage for listing photos.
 *
 * Separate from `ListingPort` because the backing store is different in kind —
 * object storage rather than a row — and because photos are the one place the
 * product accepts arbitrary bytes from a user. Keeping that surface behind its
 * own interface makes it easy to see what touches it.
 *
 * The store is deliberately dumb: it holds bytes under a key and has no opinion
 * about who may read them. Authorization happens at the route, which resolves
 * the key through the listing that references it, so a leaked key is not a
 * bearer token.
 */
export interface PhotoStorePort {
  /** `contentType` is the *sniffed* type, never the client's claim. */
  put(key: string, photo: { contentType: string; bytes: Uint8Array }): Promise<void>;

  get(key: string): Promise<{ contentType: string; bytes: Uint8Array } | null>;

  remove(key: string): Promise<void>;
}

export interface ExchangePort {
  create(exchange: Exchange): Promise<Exchange>;

  byId(id: ExchangeId): Promise<Exchange | null>;

  /**
   * The handoff for a claim, if one is being arranged.
   *
   * At most one live exchange per claim: re-proposing a time edits the existing
   * record rather than stacking a second, so there is never a question of which
   * proposal is the real one.
   */
  forClaim(claimId: ClaimId): Promise<Exchange | null>;

  save(exchange: Exchange): Promise<Exchange>;

  /** Cancel and remove handoffs this user is a party to. */
  eraseUser(userId: UserId): Promise<void>;
}

export interface ReportPort {
  create(report: Report): Promise<Report>;

  byId(id: ReportId): Promise<Report | null>;

  save(report: Report): Promise<Report>;

  /** Reports this user filed, newest first. */
  filedBy(reporterId: UserId): Promise<Report[]>;

  /**
   * Reports *about* this user that a moderator has opened a thread on.
   *
   * Scoped to `subjectNotified` in the adapter rather than filtered later: a
   * port that returned every report about someone would put the un-notified
   * ones one forgotten `.filter()` away from the person they are about.
   */
  notifiedTo(subjectUserId: UserId): Promise<Report[]>;

  /** The moderation queue, newest first. Bounded. */
  queue(limit: number): Promise<Report[]>;

  /**
   * How many live reports this reporter already has against this subject.
   *
   * One at a time: the queue must not be floodable by one person, and a report
   * count must never become a signal about how popular a grievance is.
   */
  openCount(reporterId: UserId, subjectUserId: UserId): Promise<number>;

  notesFor(reportId: ReportId): Promise<ReportNote[]>;

  addNote(note: ReportNote): Promise<ReportNote>;

  /**
   * Erase what deletion is allowed to erase, and keep what it is not.
   *
   * Implementations MUST retain reports where this user is the **subject of a
   * live case** (`OPEN` or `AWAITING_INFO`), evidence included. Otherwise
   * deletion is an escape hatch from moderation: harass, get reported, delete,
   * and the case evaporates (ADR 0022).
   *
   * Reports this user *filed* are retained too — the case protects someone
   * else — but the filer is already tombstoned by then, so anonymity holds.
   */
  eraseUser(userId: UserId): Promise<void>;
}

/**
 * Outbound mail.
 *
 * One method, and it takes no content — see
 * docs/adr/0018-reporting-and-moderation.md. The signature is the control: a
 * notifier that cannot be handed a title or a name cannot leak one, whatever
 * the adapter behind it does with what it gets.
 */
export interface NotifierPort {
  reportFiled(pointer: {
    reportId: ReportId;
    reason: ReportReason;
    subjectKind: 'LISTING' | 'HANGOUT' | 'USER';
  }): Promise<void>;
}

export interface Repositories {
  readonly social: SocialGraphPort;
  readonly calendar: CalendarPort;
  readonly directory: DirectoryPort;
  readonly hangouts: HangoutPort;
  readonly notifications: NotificationPort;
  readonly listings: ListingPort;
  readonly photos: PhotoStorePort;
  readonly circles: CirclePort;
  readonly credentials: CredentialPort;
  readonly sessions: SessionPort;
  readonly exchanges: ExchangePort;
  readonly reports: ReportPort;
  readonly notifier: NotifierPort;
}
