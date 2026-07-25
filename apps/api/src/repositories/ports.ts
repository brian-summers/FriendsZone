import type {
  CalendarEvent,
  CircleId,
  EventId,
  HangoutRequest,
  HangoutRequestId,
  Notification,
  PublicProfile,
  RelationshipKind,
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

  /** Replace the owner's baseline sharing policy. */
  setSharingDefaults(ownerId: UserId, defaults: SharingDefaults): Promise<SharingDefaults>;
}

export interface NotificationPort {
  create(notification: Notification): Promise<Notification>;

  /** Notifications addressed to `userId`, newest first. Theirs alone. */
  forUser(userId: UserId): Promise<Notification[]>;
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
}

export interface Repositories {
  readonly social: SocialGraphPort;
  readonly calendar: CalendarPort;
  readonly directory: DirectoryPort;
  readonly hangouts: HangoutPort;
  readonly notifications: NotificationPort;
}
