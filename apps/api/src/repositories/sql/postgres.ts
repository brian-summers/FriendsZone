import type {
  AuthIdentity,
  AuthProvider,
  CalendarEvent,
  Circle,
  CircleId,
  Claim,
  ClaimId,
  EventId,
  Exchange,
  ExchangeId,
  Friendship,
  HangoutRequest,
  HangoutRequestId,
  Listing,
  ListingId,
  Notification,
  PublicProfile,
  RelationshipKind,
  Report,
  ReportId,
  ReportNote,
  ReportReason,
  Session,
  SharingDefaults,
  TimeRange,
  UserId,
} from '@friendszone/contracts';
import { CONSERVATIVE_SHARING_DEFAULTS, TOMBSTONE_DISPLAY_NAME } from '@friendszone/contracts';
import type {
  CalendarPort,
  CirclePort,
  CredentialPort,
  DirectoryPort,
  ExchangePort,
  HangoutPort,
  ListingPort,
  NotificationPort,
  NotifierPort,
  PhotoStorePort,
  Repositories,
  ReportPort,
  SessionPort,
  SocialGraphPort,
} from '../ports.js';
import type { SqlClient } from './client.js';

/**
 * The PostgreSQL adapter.
 *
 * Raw parameterised SQL, per docs/adr/0026-sql-layer.md. Three habits a
 * reviewer should check every query against:
 *
 *  1. **Every value is a bind parameter.** There is no string interpolation of
 *     data anywhere in this file.
 *  2. **Ports return raw, unfiltered rows.** Filtering belongs to the policy
 *     engine, and splitting it across both would mean two places to audit. A
 *     `where` clause here narrows by *ownership or identity*, never by audience.
 *  3. **`doc` holds the domain object.** Columns exist only for what is queried,
 *     indexed, or enforced on, so `select doc` is the normal shape.
 */

/** Canonical pair ordering, matching the `check` constraints in schema.sql. */
const pair = (a: UserId, b: UserId): [UserId, UserId] => (a < b ? [a, b] : [b, a]);

/** `[start, end)` — half-open, so back-to-back events do not overlap. */
const spanOf = (range: TimeRange): string => `[${range.start},${range.end})`;

type DocRow<T> = { doc: T };
const docs = <T>(rows: DocRow<T>[]): T[] => rows.map((r) => r.doc);
const firstDoc = <T>(rows: DocRow<T>[]): T | null => rows[0]?.doc ?? null;

// ── Social graph ──────────────────────────────────────────────────────

class SqlSocialGraph implements SocialGraphPort {
  constructor(private readonly db: SqlClient) {}

  async relationship(viewerId: UserId | null, ownerId: UserId): Promise<RelationshipKind> {
    if (viewerId === null) return 'NONE';
    if (viewerId === ownerId) return 'SELF';
    const [low, high] = pair(viewerId, ownerId);

    // One round trip for both facts. `blocks` is **directed**, so this checks
    // both rows explicitly — a block either way is a block (ADR 0028).
    const rows = await this.db.query<{ blocked: boolean; status: string | null }>(
      `select
         exists (
           select 1 from blocks
            where (blocker_id = $1 and blocked_id = $2)
               or (blocker_id = $2 and blocked_id = $1)
         ) as blocked,
         (select status from friendships where low_user_id = $3 and high_user_id = $4) as status`,
      [viewerId, ownerId, low, high],
    );

    if (rows[0]?.blocked === true) return 'BLOCKED';
    const status = rows[0]?.status ?? null;
    if (status === 'ACCEPTED') return 'FRIEND';
    return status === 'PENDING' ? 'PENDING' : 'NONE';
  }

  async friendship(a: UserId, b: UserId): Promise<Friendship | null> {
    const [low, high] = pair(a, b);
    const rows = await this.db.query<{
      low_user_id: UserId;
      high_user_id: UserId;
      requested_by: UserId;
      status: 'PENDING' | 'ACCEPTED';
      created_at: Date;
      accepted_at: Date | null;
    }>(
      `select low_user_id, high_user_id, requested_by, status, created_at, accepted_at
         from friendships where low_user_id = $1 and high_user_id = $2`,
      [low, high],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      lowUserId: r.low_user_id,
      highUserId: r.high_user_id,
      requestedBy: r.requested_by,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
      ...(r.accepted_at === null ? {} : { acceptedAt: new Date(r.accepted_at).toISOString() }),
    };
  }

  async saveFriendship(friendship: Friendship): Promise<Friendship> {
    await this.db.query(
      `insert into friendships
         (low_user_id, high_user_id, requested_by, status, created_at, accepted_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (low_user_id, high_user_id)
       do update set status = excluded.status, accepted_at = excluded.accepted_at`,
      [
        friendship.lowUserId,
        friendship.highUserId,
        friendship.requestedBy,
        friendship.status,
        friendship.createdAt,
        friendship.acceptedAt ?? null,
      ],
    );
    return friendship;
  }

  async removeFriendship(a: UserId, b: UserId): Promise<void> {
    const [low, high] = pair(a, b);
    await this.db.query(
      `delete from friendships where low_user_id = $1 and high_user_id = $2`,
      [low, high],
    );
  }

  async pendingFriendships(userId: UserId): Promise<Friendship[]> {
    const rows = await this.db.query<{ low_user_id: UserId; high_user_id: UserId }>(
      `select low_user_id, high_user_id from friendships
        where status = 'PENDING' and (low_user_id = $1 or high_user_id = $1)
        order by created_at desc`,
      [userId],
    );
    const out: Friendship[] = [];
    for (const r of rows) {
      const found = await this.friendship(r.low_user_id, r.high_user_id);
      if (found !== null) out.push(found);
    }
    return out;
  }

  async block(blockerId: UserId, blockedId: UserId): Promise<void> {
    await this.db.query(
      `insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`,
      [blockerId, blockedId],
    );
  }

  async unblock(blockerId: UserId, blockedId: UserId): Promise<void> {
    // Only this caller's row — theirs, if any, survives. An undirected delete
    // here would hand one party control of the other's protection (ADR 0028).
    await this.db.query(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [
      blockerId,
      blockedId,
    ]);
  }

  async blockedBy(blockerId: UserId): Promise<UserId[]> {
    const rows = await this.db.query<{ blocked_id: UserId }>(
      `select blocked_id from blocks where blocker_id = $1`,
      [blockerId],
    );
    return rows.map((r) => r.blocked_id);
  }

  async sharedCircles(viewerId: UserId | null, ownerId: UserId): Promise<CircleId[]> {
    if (viewerId === null) return [];
    const rows = await this.db.query<{ circle_id: CircleId }>(
      `select cm.circle_id
         from circle_members cm
         join circles c on c.id = cm.circle_id
        where cm.user_id = $1 and c.owner_id = $2`,
      [viewerId, ownerId],
    );
    return rows.map((r) => r.circle_id);
  }

  async contextsFor(
    viewerId: UserId | null,
    ownerIds: readonly UserId[],
  ): Promise<Map<UserId, { relationship: RelationshipKind; sharedCircleIds: CircleId[] }>> {
    const out = new Map<UserId, { relationship: RelationshipKind; sharedCircleIds: CircleId[] }>();
    // Every id asked about gets an entry, even one that does not exist — a
    // missing key would distinguish "no such user" from "shares nothing".
    for (const ownerId of ownerIds) {
      out.set(ownerId, {
        relationship: await this.relationship(viewerId, ownerId),
        sharedCircleIds: await this.sharedCircles(viewerId, ownerId),
      });
    }
    return out;
  }

  async eraseUser(userId: UserId): Promise<void> {
    await this.db.query(
      `delete from friendships where low_user_id = $1 or high_user_id = $1`,
      [userId],
    );
    await this.db.query(`delete from circle_members where user_id = $1`, [userId]);
    // `blocks` is deliberately untouched, and has no `on delete cascade` for the
    // same reason: clearing one would make delete-and-rejoin a route back to
    // someone who blocked you (ADR 0004, ADR 0022).
  }
}

// ── Directory ─────────────────────────────────────────────────────────

const profileOf = (r: {
  id: UserId;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}): PublicProfile => ({
  id: r.id,
  handle: r.handle,
  displayName: r.display_name,
  ...(r.avatar_url === null ? {} : { avatarUrl: r.avatar_url }),
});

const PROFILE_COLS = 'id, handle, display_name, avatar_url';

class SqlDirectory implements DirectoryPort {
  constructor(private readonly db: SqlClient) {}

  async profile(userId: UserId): Promise<PublicProfile | null> {
    const rows = await this.db.query<Parameters<typeof profileOf>[0]>(
      `select ${PROFILE_COLS} from users where id = $1`,
      [userId],
    );
    return rows[0] === undefined ? null : profileOf(rows[0]);
  }

  async friendsOf(userId: UserId): Promise<PublicProfile[]> {
    const rows = await this.db.query<Parameters<typeof profileOf>[0]>(
      `select ${PROFILE_COLS.split(', ').map((c) => `u.${c}`).join(', ')}
         from friendships f
         join users u
           on u.id = case when f.low_user_id = $1 then f.high_user_id else f.low_user_id end
        where (f.low_user_id = $1 or f.high_user_id = $1)
          and f.status = 'ACCEPTED'
        order by u.display_name`,
      [userId],
    );
    return rows.map(profileOf);
  }

  async search(query: string, limit: number): Promise<PublicProfile[]> {
    // Raw rows, unfiltered by blocks — the route removes anyone in a block
    // relationship so a blocked pair look exactly like people who do not
    // exist. Tombstoned accounts are dropped here: a deleted user is not
    // someone any caller could befriend (ADR 0028).
    const rows = await this.db.query<Parameters<typeof profileOf>[0]>(
      `select ${PROFILE_COLS} from users
        where not tombstoned
          and (lower(handle) like lower($1) || '%' or lower(display_name) like '%' || lower($1) || '%')
        order by display_name
        limit $2`,
      [query.trim(), limit],
    );
    return rows.map(profileOf);
  }

  async create(profile: PublicProfile): Promise<PublicProfile> {
    await this.db.query(
      `insert into users (id, handle, display_name, avatar_url) values ($1, $2, $3, $4)`,
      [profile.id, profile.handle, profile.displayName, profile.avatarUrl ?? null],
    );
    return profile;
  }

  async handleTaken(handle: string): Promise<boolean> {
    const rows = await this.db.query<{ taken: boolean }>(
      `select exists (select 1 from users where lower(handle) = lower($1)) as taken`,
      [handle],
    );
    return rows[0]?.taken === true;
  }

  async tombstone(userId: UserId): Promise<void> {
    // Emptied in place, id kept, so every reference stays resolvable and
    // resolves to nothing (ADR 0022).
    await this.db.query(
      `update users
          set handle = 'deleted-' || left($1::text, 8),
              display_name = $2,
              avatar_url = null,
              tombstoned = true
        where id = $1`,
      [userId, TOMBSTONE_DISPLAY_NAME],
    );
  }

  async isTombstoned(userId: UserId): Promise<boolean> {
    const rows = await this.db.query<{ tombstoned: boolean }>(
      `select tombstoned from users where id = $1`,
      [userId],
    );
    return rows[0]?.tombstoned === true;
  }
}

// ── Credentials and sessions ──────────────────────────────────────────

const identityOf = (r: {
  user_id: UserId;
  provider: AuthProvider;
  subject: string;
  secret_hash: string | null;
  created_at: Date;
}): AuthIdentity => ({
  userId: r.user_id,
  provider: r.provider,
  subject: r.subject,
  ...(r.secret_hash === null ? {} : { secretHash: r.secret_hash }),
  createdAt: new Date(r.created_at).toISOString(),
});

class SqlCredentials implements CredentialPort {
  constructor(private readonly db: SqlClient) {}

  async identity(provider: AuthProvider, subject: string): Promise<AuthIdentity | null> {
    const rows = await this.db.query<Parameters<typeof identityOf>[0]>(
      `select user_id, provider, subject, secret_hash, created_at
         from auth_identities where provider = $1 and subject = $2`,
      [provider, subject],
    );
    return rows[0] === undefined ? null : identityOf(rows[0]);
  }

  async identitiesFor(userId: UserId): Promise<AuthIdentity[]> {
    const rows = await this.db.query<Parameters<typeof identityOf>[0]>(
      `select user_id, provider, subject, secret_hash, created_at
         from auth_identities where user_id = $1`,
      [userId],
    );
    return rows.map(identityOf);
  }

  async create(identity: AuthIdentity): Promise<AuthIdentity> {
    await this.db.query(
      `insert into auth_identities (provider, subject, user_id, secret_hash, created_at)
       values ($1, $2, $3, $4, $5)`,
      [
        identity.provider,
        identity.subject,
        identity.userId,
        identity.secretHash ?? null,
        identity.createdAt,
      ],
    );
    return identity;
  }

  async save(identity: AuthIdentity): Promise<AuthIdentity> {
    await this.db.query(
      `insert into auth_identities (provider, subject, user_id, secret_hash, created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (provider, subject)
       do update set user_id = excluded.user_id, secret_hash = excluded.secret_hash`,
      [
        identity.provider,
        identity.subject,
        identity.userId,
        identity.secretHash ?? null,
        identity.createdAt,
      ],
    );
    return identity;
  }

  async eraseUser(userId: UserId): Promise<void> {
    await this.db.query(`delete from auth_identities where user_id = $1`, [userId]);
  }
}

class SqlSessions implements SessionPort {
  constructor(private readonly db: SqlClient) {}

  async byTokenHash(tokenHash: string): Promise<Session | null> {
    const rows = await this.db.query<{
      token_hash: string;
      user_id: UserId;
      created_at: Date;
      expires_at: Date;
    }>(`select token_hash, user_id, created_at, expires_at from sessions where token_hash = $1`, [
      tokenHash,
    ]);
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tokenHash: r.token_hash,
      userId: r.user_id,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
    };
  }

  async create(session: Session): Promise<Session> {
    await this.db.query(
      `insert into sessions (token_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)`,
      [session.tokenHash, session.userId, session.createdAt, session.expiresAt],
    );
    return session;
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.db.query(`delete from sessions where token_hash = $1`, [tokenHash]);
  }

  async revokeAllFor(userId: UserId): Promise<void> {
    await this.db.query(`delete from sessions where user_id = $1`, [userId]);
  }
}

// ── Calendar ──────────────────────────────────────────────────────────

class SqlCalendar implements CalendarPort {
  constructor(private readonly db: SqlClient) {}

  async eventsInWindow(ownerId: UserId, window: TimeRange): Promise<CalendarEvent[]> {
    // `&&` on tstzrange, which is what the GiST index answers. Half-open on both
    // sides, so an event ending exactly when the window starts is not returned.
    return docs(
      await this.db.query<DocRow<CalendarEvent>>(
        `select doc from events where owner_id = $1 and span && $2::tstzrange`,
        [ownerId, spanOf(window)],
      ),
    );
  }

  async eventById(eventId: EventId): Promise<CalendarEvent | null> {
    return firstDoc(
      await this.db.query<DocRow<CalendarEvent>>(`select doc from events where id = $1`, [eventId]),
    );
  }

  async create(event: CalendarEvent): Promise<CalendarEvent> {
    await this.db.query(
      `insert into events (id, owner_id, span, doc) values ($1, $2, $3::tstzrange, $4)`,
      [event.id, event.ownerId, spanOf(event.timeRange), JSON.stringify(event)],
    );
    return event;
  }

  async update(event: CalendarEvent): Promise<CalendarEvent> {
    await this.db.query(
      `insert into events (id, owner_id, span, doc) values ($1, $2, $3::tstzrange, $4)
       on conflict (id) do update set owner_id = excluded.owner_id,
                                      span = excluded.span,
                                      doc = excluded.doc`,
      [event.id, event.ownerId, spanOf(event.timeRange), JSON.stringify(event)],
    );
    return event;
  }

  async remove(eventId: EventId): Promise<void> {
    await this.db.query(`delete from events where id = $1`, [eventId]);
  }

  async sharingDefaults(ownerId: UserId): Promise<SharingDefaults> {
    const found = firstDoc(
      await this.db.query<DocRow<SharingDefaults>>(
        `select doc from sharing_defaults where user_id = $1`,
        [ownerId],
      ),
    );
    // An absent row is not consent to share more (ADR 0021).
    return found ?? CONSERVATIVE_SHARING_DEFAULTS;
  }

  async setSharingDefaults(ownerId: UserId, defaults: SharingDefaults): Promise<SharingDefaults> {
    await this.db.query(
      `insert into sharing_defaults (user_id, doc) values ($1, $2)
       on conflict (user_id) do update set doc = excluded.doc`,
      [ownerId, JSON.stringify(defaults)],
    );
    return defaults;
  }

  async hasExplicitSharingDefaults(ownerId: UserId): Promise<boolean> {
    const rows = await this.db.query<{ chosen: boolean }>(
      `select exists (select 1 from sharing_defaults where user_id = $1) as chosen`,
      [ownerId],
    );
    return rows[0]?.chosen === true;
  }

  async scrubCircleRules(ownerId: UserId, circleId: CircleId): Promise<void> {
    // Read-modify-write rather than a jsonb path surgery: the rule shape is
    // owned by `packages/contracts`, and expressing it twice — once in Zod and
    // once in a jsonb expression — is exactly the drift this design avoids.
    const drop = <T extends { shareRules?: unknown }>(doc: T): T => {
      const rules = (doc.shareRules ?? []) as Array<{
        audience: { kind: string; circleId?: string };
      }>;
      return {
        ...doc,
        shareRules: rules.filter(
          (r) => !(r.audience.kind === 'CIRCLE' && r.audience.circleId === circleId),
        ),
      };
    };

    const events = await this.db.query<DocRow<CalendarEvent>>(
      `select doc from events where owner_id = $1`,
      [ownerId],
    );
    for (const { doc } of events) {
      const next = drop(doc);
      if (next.shareRules.length !== doc.shareRules.length) await this.update(next);
    }

    const defaults = await this.sharingDefaults(ownerId);
    const keptRules = defaults.rules.filter(
      (r) => !(r.audience.kind === 'CIRCLE' && r.audience.circleId === circleId),
    );
    if (keptRules.length !== defaults.rules.length) {
      await this.setSharingDefaults(ownerId, { rules: keptRules });
    }
  }

  async eraseUser(ownerId: UserId): Promise<void> {
    await this.db.query(`delete from events where owner_id = $1`, [ownerId]);
    await this.db.query(`delete from sharing_defaults where user_id = $1`, [ownerId]);

    // Someone else's event that named this user as an attendee survives — it is
    // their record of their own week — but stops naming them (ADR 0022).
    const attended = await this.db.query<DocRow<CalendarEvent>>(
      `select doc from events where doc -> 'attendeeIds' ? $1`,
      [ownerId],
    );
    for (const { doc } of attended) {
      await this.update({ ...doc, attendeeIds: doc.attendeeIds.filter((id) => id !== ownerId) });
    }
  }
}

// ── Circles ───────────────────────────────────────────────────────────

class SqlCircles implements CirclePort {
  constructor(private readonly db: SqlClient) {}

  async #hydrate(rows: Array<{ id: CircleId; owner_id: UserId; name: string; created_at: Date }>) {
    const out: Circle[] = [];
    for (const r of rows) {
      const members = await this.db.query<{ user_id: UserId }>(
        `select user_id from circle_members where circle_id = $1`,
        [r.id],
      );
      out.push({
        id: r.id,
        ownerId: r.owner_id,
        name: r.name,
        memberIds: members.map((m) => m.user_id),
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return out;
  }

  async ownedBy(ownerId: UserId): Promise<Circle[]> {
    return this.#hydrate(
      await this.db.query(
        `select id, owner_id, name, created_at from circles where owner_id = $1 order by created_at`,
        [ownerId],
      ),
    );
  }

  async byId(id: CircleId): Promise<Circle | null> {
    const found = await this.#hydrate(
      await this.db.query(`select id, owner_id, name, created_at from circles where id = $1`, [id]),
    );
    return found[0] ?? null;
  }

  async create(circle: Circle): Promise<Circle> {
    await this.db.query(
      `insert into circles (id, owner_id, name, created_at) values ($1, $2, $3, $4)`,
      [circle.id, circle.ownerId, circle.name, circle.createdAt],
    );
    await this.#setMembers(circle);
    return circle;
  }

  async save(circle: Circle): Promise<Circle> {
    await this.db.query(
      `insert into circles (id, owner_id, name, created_at) values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name`,
      [circle.id, circle.ownerId, circle.name, circle.createdAt],
    );
    await this.db.query(`delete from circle_members where circle_id = $1`, [circle.id]);
    await this.#setMembers(circle);
    return circle;
  }

  async #setMembers(circle: Circle): Promise<void> {
    for (const userId of circle.memberIds) {
      await this.db.query(
        `insert into circle_members (circle_id, user_id) values ($1, $2) on conflict do nothing`,
        [circle.id, userId],
      );
    }
  }

  async remove(id: CircleId): Promise<void> {
    await this.db.query(`delete from circles where id = $1`, [id]);
  }
}

// ── Hangouts ──────────────────────────────────────────────────────────

class SqlHangouts implements HangoutPort {
  constructor(private readonly db: SqlClient) {}

  async create(request: HangoutRequest): Promise<HangoutRequest> {
    await this.db.query(
      `insert into hangouts (id, proposer_id, invitee_ids, doc, created_at)
       values ($1, $2, $3::uuid[], $4, $5)`,
      [
        request.id,
        request.proposerId,
        request.inviteeIds,
        JSON.stringify(request),
        request.createdAt,
      ],
    );
    return request;
  }

  async byId(id: HangoutRequestId): Promise<HangoutRequest | null> {
    return firstDoc(
      await this.db.query<DocRow<HangoutRequest>>(`select doc from hangouts where id = $1`, [id]),
    );
  }

  async received(userId: UserId): Promise<HangoutRequest[]> {
    return docs(
      await this.db.query<DocRow<HangoutRequest>>(
        `select doc from hangouts where $1 = any (invitee_ids) order by created_at desc`,
        [userId],
      ),
    );
  }

  async sent(userId: UserId): Promise<HangoutRequest[]> {
    return docs(
      await this.db.query<DocRow<HangoutRequest>>(
        `select doc from hangouts where proposer_id = $1 order by created_at desc`,
        [userId],
      ),
    );
  }

  async pendingInvolving(userId: UserId): Promise<HangoutRequest[]> {
    return docs(
      await this.db.query<DocRow<HangoutRequest>>(
        `select doc from hangouts
          where doc ->> 'status' = 'PENDING'
            and (proposer_id = $1 or $1 = any (invitee_ids))`,
        [userId],
      ),
    );
  }

  async save(request: HangoutRequest): Promise<HangoutRequest> {
    await this.db.query(
      `insert into hangouts (id, proposer_id, invitee_ids, doc, created_at)
       values ($1, $2, $3::uuid[], $4, $5)
       on conflict (id) do update set invitee_ids = excluded.invitee_ids, doc = excluded.doc`,
      [
        request.id,
        request.proposerId,
        request.inviteeIds,
        JSON.stringify(request),
        request.createdAt,
      ],
    );
    return request;
  }

  async eraseUser(userId: UserId): Promise<void> {
    await this.db.query(`delete from hangouts where proposer_id = $1`, [userId]);

    const involved = await this.db.query<DocRow<HangoutRequest>>(
      `select doc from hangouts where $1 = any (invitee_ids)`,
      [userId],
    );
    for (const { doc } of involved) {
      const inviteeIds = doc.inviteeIds.filter((id) => id !== userId);
      // A request with nobody left to answer it records nothing.
      if (inviteeIds.length === 0) await this.db.query(`delete from hangouts where id = $1`, [doc.id]);
      else await this.save({ ...doc, inviteeIds });
    }
  }
}

// ── Things ────────────────────────────────────────────────────────────

class SqlListings implements ListingPort {
  constructor(private readonly db: SqlClient) {}

  async create(listing: Listing): Promise<Listing> {
    await this.db.query(
      `insert into listings (id, owner_id, doc, created_at) values ($1, $2, $3, $4)`,
      [listing.id, listing.ownerId, JSON.stringify(listing), listing.createdAt],
    );
    return listing;
  }

  async byId(id: ListingId): Promise<Listing | null> {
    return firstDoc(
      await this.db.query<DocRow<Listing>>(`select doc from listings where id = $1`, [id]),
    );
  }

  async save(listing: Listing): Promise<Listing> {
    await this.db.query(
      `insert into listings (id, owner_id, doc, created_at) values ($1, $2, $3, $4)
       on conflict (id) do update set doc = excluded.doc`,
      [listing.id, listing.ownerId, JSON.stringify(listing), listing.createdAt],
    );
    return listing;
  }

  async recent(limit: number): Promise<Listing[]> {
    // Raw rows, newest first, unfiltered by visibility — `projectListing`
    // decides what survives, and pushing the audience test in here would be the
    // second implementation of the lattice this architecture exists to prevent.
    return docs(
      await this.db.query<DocRow<Listing>>(
        `select doc from listings order by created_at desc limit $1`,
        [limit],
      ),
    );
  }

  async claimsFor(listingId: ListingId): Promise<Claim[]> {
    // Oldest first: FIRST_COME depends on this being arrival order, and a draw
    // over a stably-ordered list is reproducible from its seed (ADR 0017).
    return docs(
      await this.db.query<DocRow<Claim>>(
        `select doc from claims where listing_id = $1 order by created_at`,
        [listingId],
      ),
    );
  }

  async claimById(id: ClaimId): Promise<Claim | null> {
    return firstDoc(await this.db.query<DocRow<Claim>>(`select doc from claims where id = $1`, [id]));
  }

  async createClaim(claim: Claim): Promise<Claim> {
    await this.db.query(
      `insert into claims (id, listing_id, claimant_id, doc, created_at) values ($1, $2, $3, $4, $5)`,
      [claim.id, claim.listingId, claim.claimantId, JSON.stringify(claim), claim.createdAt],
    );
    return claim;
  }

  async saveClaim(claim: Claim): Promise<Claim> {
    await this.db.query(
      `insert into claims (id, listing_id, claimant_id, doc, created_at) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set doc = excluded.doc`,
      [claim.id, claim.listingId, claim.claimantId, JSON.stringify(claim), claim.createdAt],
    );
    return claim;
  }

  async eraseUser(userId: UserId): Promise<{ photoKeys: string[] }> {
    const mine = await this.db.query<DocRow<Listing>>(
      `select doc from listings where owner_id = $1`,
      [userId],
    );
    const photoKeys = mine.flatMap((r) => r.doc.photoKeys);

    // `claims` cascades from `listings`, so everyone's claims on a gone listing
    // go with it — which is the behaviour the memory adapter implements by hand.
    await this.db.query(`delete from listings where owner_id = $1`, [userId]);
    await this.db.query(`delete from claims where claimant_id = $1`, [userId]);
    return { photoKeys };
  }
}

class SqlPhotos implements PhotoStorePort {
  constructor(private readonly db: SqlClient) {}

  async put(key: string, photo: { contentType: string; bytes: Uint8Array }): Promise<void> {
    await this.db.query(
      `insert into photos (key, content_type, bytes) values ($1, $2, $3)
       on conflict (key) do update set content_type = excluded.content_type, bytes = excluded.bytes`,
      [key, photo.contentType, Buffer.from(photo.bytes)],
    );
  }

  async get(key: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
    const rows = await this.db.query<{ content_type: string; bytes: Uint8Array }>(
      `select content_type, bytes from photos where key = $1`,
      [key],
    );
    const r = rows[0];
    return r === undefined ? null : { contentType: r.content_type, bytes: new Uint8Array(r.bytes) };
  }

  async remove(key: string): Promise<void> {
    await this.db.query(`delete from photos where key = $1`, [key]);
  }
}

class SqlExchanges implements ExchangePort {
  constructor(private readonly db: SqlClient) {}

  async create(exchange: Exchange): Promise<Exchange> {
    await this.db.query(
      `insert into exchanges (id, claim_id, proposed_by, doc, created_at) values ($1, $2, $3, $4, $5)`,
      [exchange.id, exchange.claimId, exchange.proposedBy, JSON.stringify(exchange), exchange.createdAt],
    );
    return exchange;
  }

  async byId(id: ExchangeId): Promise<Exchange | null> {
    return firstDoc(
      await this.db.query<DocRow<Exchange>>(`select doc from exchanges where id = $1`, [id]),
    );
  }

  async forClaim(claimId: ClaimId): Promise<Exchange | null> {
    // Newest wins: a cancelled handoff may be followed by a fresh attempt, and
    // the live one is the one being arranged now.
    return firstDoc(
      await this.db.query<DocRow<Exchange>>(
        `select doc from exchanges where claim_id = $1 order by created_at desc limit 1`,
        [claimId],
      ),
    );
  }

  async save(exchange: Exchange): Promise<Exchange> {
    await this.db.query(
      `insert into exchanges (id, claim_id, proposed_by, doc, created_at) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set doc = excluded.doc`,
      [exchange.id, exchange.claimId, exchange.proposedBy, JSON.stringify(exchange), exchange.createdAt],
    );
    return exchange;
  }

  async eraseUser(userId: UserId): Promise<void> {
    await this.db.query(`delete from exchanges where proposed_by = $1`, [userId]);
  }
}

// ── Moderation ────────────────────────────────────────────────────────

class SqlReports implements ReportPort {
  constructor(private readonly db: SqlClient) {}

  async create(report: Report): Promise<Report> {
    await this.db.query(
      `insert into reports (id, reporter_id, subject_user_id, status, doc, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [report.id, report.reporterId, report.subjectUserId, report.status, JSON.stringify(report), report.createdAt],
    );
    return report;
  }

  async byId(id: ReportId): Promise<Report | null> {
    return firstDoc(await this.db.query<DocRow<Report>>(`select doc from reports where id = $1`, [id]));
  }

  async save(report: Report): Promise<Report> {
    await this.db.query(
      `insert into reports (id, reporter_id, subject_user_id, status, doc, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set status = excluded.status, doc = excluded.doc`,
      [report.id, report.reporterId, report.subjectUserId, report.status, JSON.stringify(report), report.createdAt],
    );
    return report;
  }

  async filedBy(reporterId: UserId): Promise<Report[]> {
    return docs(
      await this.db.query<DocRow<Report>>(
        `select doc from reports where reporter_id = $1 order by created_at desc`,
        [reporterId],
      ),
    );
  }

  async notifiedTo(subjectUserId: UserId): Promise<Report[]> {
    // The `subjectNotified` test lives in the query, not the caller: a report
    // the subject has not been contacted about must never leave this method.
    return docs(
      await this.db.query<DocRow<Report>>(
        `select doc from reports
          where subject_user_id = $1 and (doc ->> 'subjectNotified')::boolean
          order by created_at desc`,
        [subjectUserId],
      ),
    );
  }

  async queue(limit: number): Promise<Report[]> {
    return docs(
      await this.db.query<DocRow<Report>>(
        `select doc from reports order by created_at desc limit $1`,
        [limit],
      ),
    );
  }

  async openCount(reporterId: UserId, subjectUserId: UserId): Promise<number> {
    const rows = await this.db.query<{ n: string }>(
      `select count(*) as n from reports
        where reporter_id = $1 and subject_user_id = $2
          and status in ('OPEN', 'AWAITING_INFO')`,
      [reporterId, subjectUserId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async notesFor(reportId: ReportId): Promise<ReportNote[]> {
    return docs(
      await this.db.query<DocRow<ReportNote>>(
        `select doc from report_notes where report_id = $1 order by created_at`,
        [reportId],
      ),
    );
  }

  async addNote(note: ReportNote): Promise<ReportNote> {
    await this.db.query(
      `insert into report_notes (id, report_id, audience, doc, created_at) values ($1, $2, $3, $4, $5)`,
      [note.id, note.reportId, note.audience, JSON.stringify(note), note.createdAt],
    );
    return note;
  }

  async eraseUser(userId: UserId): Promise<void> {
    // A live case survives, whichever side is leaving: otherwise deletion is an
    // escape hatch from moderation, and a reporter's departure would abandon a
    // case that protects someone else (ADR 0022).
    await this.db.query(
      `delete from reports
        where (reporter_id = $1 or subject_user_id = $1)
          and status not in ('OPEN', 'AWAITING_INFO')`,
      [userId],
    );
  }
}

class SqlNotifications implements NotificationPort {
  constructor(private readonly db: SqlClient) {}

  async create(notification: Notification): Promise<Notification> {
    await this.db.query(
      `insert into notifications (id, recipient_id, actor_id, doc, created_at) values ($1, $2, $3, $4, $5)`,
      [
        notification.id,
        notification.recipientId,
        notification.actorId,
        JSON.stringify(notification),
        notification.createdAt,
      ],
    );
    return notification;
  }

  async forUser(userId: UserId): Promise<Notification[]> {
    return docs(
      await this.db.query<DocRow<Notification>>(
        `select doc from notifications where recipient_id = $1 order by created_at desc`,
        [userId],
      ),
    );
  }

  async eraseUser(userId: UserId): Promise<void> {
    await this.db.query(`delete from notifications where recipient_id = $1 or actor_id = $1`, [
      userId,
    ]);
  }
}

/**
 * Development notifier.
 *
 * Mail delivery does not exist, and the pointer carries a reason and an id and
 * nothing else — the signature has no parameter that could hold content
 * (ADR 0018).
 */
class LoggingNotifier implements NotifierPort {
  async reportFiled(pointer: {
    reportId: ReportId;
    reason: ReportReason;
    subjectKind: 'LISTING' | 'HANGOUT' | 'USER';
  }): Promise<void> {
    console.info(
      `[report] filed ${pointer.reportId} reason=${pointer.reason} kind=${pointer.subjectKind}`,
    );
  }
}

export function createSqlRepositories(db: SqlClient): Repositories {
  return {
    social: new SqlSocialGraph(db),
    calendar: new SqlCalendar(db),
    directory: new SqlDirectory(db),
    hangouts: new SqlHangouts(db),
    notifications: new SqlNotifications(db),
    listings: new SqlListings(db),
    photos: new SqlPhotos(db),
    circles: new SqlCircles(db),
    credentials: new SqlCredentials(db),
    sessions: new SqlSessions(db),
    exchanges: new SqlExchanges(db),
    reports: new SqlReports(db),
    notifier: new LoggingNotifier(),
  };
}
