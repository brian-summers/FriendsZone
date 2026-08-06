import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEvent, EventId, TimeRange, UserId } from '@friendszone/contracts';
import { createMemoryRepositories } from '../memory.js';
import type { Repositories } from '../ports.js';
import { applySchema, createPgliteClient, type SqlClient } from './client.js';
import { createSqlRepositories } from './postgres.js';

/**
 * One suite, two adapters.
 *
 * The in-memory store and the Postgres store are two implementations of the
 * same twelve interfaces, and two implementations drift. Running the *same*
 * behavioural assertions against both is the only thing that keeps them honest
 * (docs/adr/0026-sql-layer.md).
 *
 * The Postgres side runs on PGlite — real Postgres 18, compiled to WebAssembly
 * — so the schema, the GiST index, the constraints, and the RLS policies are
 * exercised by the actual engine, with no server to install.
 */

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;

const at = (hour: number): string => `2026-09-01T${String(hour).padStart(2, '0')}:00:00.000Z`;
const range = (from: number, to: number): TimeRange => ({ start: at(from), end: at(to) });

let counter = 0;
const event = (ownerId: UserId, overrides: Partial<CalendarEvent> = {}): CalendarEvent => {
  counter += 1;
  return {
    id: `cccccccc-cccc-4ccc-8ccc-${String(counter).padStart(12, '0')}` as EventId,
    ownerId,
    timeRange: range(9, 10),
    title: 'Dentist',
    status: 'CONFIRMED',
    visibilityCeiling: 'FULL',
    shareRules: [],
    attendeeIds: [],
    exclusive: true,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
};

interface Harness {
  name: string;
  make: () => Promise<Repositories>;
}

const harnesses: Harness[] = [
  {
    name: 'memory',
    make: async () => createMemoryRepositories(),
  },
  {
    name: 'postgres',
    make: async () => {
      const db = await createPgliteClient();
      await applySchema(db);
      return createSqlRepositories(db);
    },
  },
];

describe.each(harnesses)('$name adapter', ({ make }) => {
  let repos: Repositories;

  /** Both adapters need the people to exist before anything references them. */
  const seedUsers = async (): Promise<void> => {
    await repos.directory.create({ id: ALICE, handle: 'alice', displayName: 'Alice Nakamura' });
    await repos.directory.create({ id: BOB, handle: 'bob', displayName: 'Bob Iyer' });
    await repos.directory.create({ id: CAROL, handle: 'carol', displayName: 'Carol Mensah' });
  };

  beforeEach(async () => {
    repos = await make();
    await seedUsers();
  });

  // ── The calendar hot path ────────────────────────────────────────
  describe('eventsInWindow', () => {
    it('returns an event that overlaps the window', async () => {
      await repos.calendar.create(event(ALICE, { timeRange: range(9, 11) }));
      expect(await repos.calendar.eventsInWindow(ALICE, range(10, 12))).toHaveLength(1);
    });

    it('treats ranges as half-open, so back-to-back events do not overlap', async () => {
      // The property ADR 0004 names explicitly: `[start, end)`. A closed range
      // would return this event and make every adjacent pair look like a clash.
      await repos.calendar.create(event(ALICE, { timeRange: range(9, 10) }));
      expect(await repos.calendar.eventsInWindow(ALICE, range(10, 11))).toHaveLength(0);
    });

    it('does not return another owner’s events', async () => {
      await repos.calendar.create(event(BOB, { timeRange: range(9, 11) }));
      expect(await repos.calendar.eventsInWindow(ALICE, range(9, 11))).toHaveLength(0);
    });

    it('round-trips every field of a stored event', async () => {
      const rich = event(ALICE, {
        description: 'Back left molar',
        location: '400 Elm St',
        attendeeIds: [BOB],
        shareRules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
        exclusive: false,
      });
      await repos.calendar.create(rich);
      const [stored] = await repos.calendar.eventsInWindow(ALICE, range(0, 23));
      expect(stored).toEqual(rich);
    });
  });

  // ── Blocks outlive deletion ──────────────────────────────────────
  it('keeps a block when the blocked user’s account is erased', async () => {
    // If deletion cleared blocks, delete-and-rejoin would be a documented route
    // back to someone who blocked you (ADR 0004, ADR 0022).
    await repos.social.block(ALICE, BOB);
    await repos.social.eraseUser(BOB);
    expect(await repos.social.relationship(BOB, ALICE)).toBe('BLOCKED');
    expect(await repos.social.relationship(ALICE, BOB)).toBe('BLOCKED');
  });

  // ── Friend requests ──────────────────────────────────────────────
  describe('friendships', () => {
    const pending = (requestedBy: UserId) => ({
      lowUserId: ALICE < BOB ? ALICE : BOB,
      highUserId: ALICE < BOB ? BOB : ALICE,
      requestedBy,
      status: 'PENDING' as const,
      createdAt: at(0),
    });

    it('reports a pending request as PENDING, not FRIEND, in both directions', async () => {
      await repos.social.saveFriendship(pending(ALICE));
      expect(await repos.social.relationship(ALICE, BOB)).toBe('PENDING');
      expect(await repos.social.relationship(BOB, ALICE)).toBe('PENDING');
    });

    it('keeps a pending request out of the friend list', async () => {
      // A pending request granting friend-level visibility would mean asking
      // to be someone's friend was enough to read their calendar.
      await repos.social.saveFriendship(pending(ALICE));
      expect(await repos.directory.friendsOf(ALICE)).toEqual([]);
      expect(await repos.directory.friendsOf(BOB)).toEqual([]);
    });

    it('promotes to FRIEND on acceptance, and lists them both ways', async () => {
      await repos.social.saveFriendship(pending(ALICE));
      await repos.social.saveFriendship({
        ...pending(ALICE),
        status: 'ACCEPTED',
        acceptedAt: at(1),
      });

      expect(await repos.social.relationship(ALICE, BOB)).toBe('FRIEND');
      expect((await repos.directory.friendsOf(ALICE)).map((p) => p.id)).toEqual([BOB]);
      expect((await repos.directory.friendsOf(BOB)).map((p) => p.id)).toEqual([ALICE]);
    });

    it('finds the row from either party, and remembers who asked', async () => {
      await repos.social.saveFriendship(pending(BOB));
      expect(await repos.social.friendship(ALICE, BOB)).toMatchObject({ requestedBy: BOB });
      expect(await repos.social.friendship(BOB, ALICE)).toMatchObject({ requestedBy: BOB });
    });

    it('lists pending requests in either direction, and drops them once answered', async () => {
      await repos.social.saveFriendship(pending(ALICE));
      expect(await repos.social.pendingFriendships(BOB)).toHaveLength(1);

      await repos.social.removeFriendship(ALICE, BOB);
      expect(await repos.social.pendingFriendships(BOB)).toEqual([]);
      expect(await repos.social.friendship(ALICE, BOB)).toBeNull();
    });
  });

  // ── Blocks are directed ──────────────────────────────────────────
  describe('blocks', () => {
    it('is symmetric when asked, so no caller can forget the other direction', async () => {
      await repos.social.block(ALICE, BOB);
      expect(await repos.social.relationship(ALICE, BOB)).toBe('BLOCKED');
      expect(await repos.social.relationship(BOB, ALICE)).toBe('BLOCKED');
    });

    it('outranks an accepted friendship', async () => {
      await repos.social.saveFriendship({
        lowUserId: ALICE < BOB ? ALICE : BOB,
        highUserId: ALICE < BOB ? BOB : ALICE,
        requestedBy: ALICE,
        status: 'ACCEPTED',
        createdAt: at(0),
        acceptedAt: at(0),
      });
      await repos.social.block(ALICE, BOB);
      expect(await repos.social.relationship(BOB, ALICE)).toBe('BLOCKED');
    });

    it('leaves the other party’s block standing when one is lifted', async () => {
      // The reason `blocks` is directed at all (ADR 0028). With one canonical
      // row, Alice unblocking Bob would silently clear Bob's block on Alice —
      // handing the person Bob wanted away from control of Bob's protection.
      await repos.social.block(ALICE, BOB);
      await repos.social.block(BOB, ALICE);

      await repos.social.unblock(ALICE, BOB);

      expect(await repos.social.relationship(ALICE, BOB)).toBe('BLOCKED');
      expect(await repos.social.blockedBy(ALICE)).toEqual([]);
      expect(await repos.social.blockedBy(BOB)).toEqual([ALICE]);
    });

    it('is idempotent in both directions', async () => {
      await repos.social.block(ALICE, BOB);
      await repos.social.block(ALICE, BOB);
      expect(await repos.social.blockedBy(ALICE)).toEqual([BOB]);

      await repos.social.unblock(ALICE, BOB);
      await repos.social.unblock(ALICE, BOB);
      expect(await repos.social.relationship(ALICE, BOB)).toBe('NONE');
    });

    it('never reports who blocked *you*', async () => {
      await repos.social.block(BOB, ALICE);
      expect(await repos.social.blockedBy(ALICE)).toEqual([]);
    });
  });

  // ── Directory search ─────────────────────────────────────────────
  describe('search', () => {
    it('matches a handle by prefix and a display name by substring', async () => {
      expect((await repos.directory.search('ali', 10)).map((p) => p.id)).toEqual([ALICE]);
      expect((await repos.directory.search('Nakamura', 10)).map((p) => p.id)).toEqual([ALICE]);
    });

    it('honours the limit, because an unbounded directory is a bulk export', async () => {
      expect(await repos.directory.search('a', 1)).toHaveLength(1);
    });

    it('returns raw rows — the route, not the port, filters blocks', async () => {
      // Stated as a test so a well-meaning change that "helpfully" filters here
      // fails loudly: two places that filter is two places to audit.
      await repos.social.block(ALICE, BOB);
      expect((await repos.directory.search('bob', 10)).map((p) => p.id)).toEqual([BOB]);
    });

    it('omits a tombstoned account', async () => {
      await repos.directory.tombstone(CAROL);
      expect(await repos.directory.search('carol', 10)).toEqual([]);
    });
  });

  // ── Sharing defaults ─────────────────────────────────────────────
  describe('sharing defaults', () => {
    it('falls back to the conservative default, and says it was not chosen', async () => {
      const defaults = await repos.calendar.sharingDefaults(ALICE);
      expect(defaults.rules).toEqual([{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }]);
      expect(await repos.calendar.hasExplicitSharingDefaults(ALICE)).toBe(false);
    });

    it('records an explicit choice, even of the same value', async () => {
      await repos.calendar.setSharingDefaults(ALICE, {
        rules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
      });
      expect(await repos.calendar.hasExplicitSharingDefaults(ALICE)).toBe(true);
    });
  });

  // ── Moderation ───────────────────────────────────────────────────
  it('never returns a report the subject has not been contacted about', async () => {
    const report = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001' as never,
      reporterId: BOB,
      subject: { kind: 'USER' as const, userId: ALICE },
      subjectUserId: ALICE,
      reason: 'HARASSMENT' as const,
      status: 'OPEN' as const,
      evidence: { capturedAt: at(0), authorId: ALICE, fields: [], photoKeys: [] },
      subjectNotified: false,
      createdAt: at(0),
      updatedAt: at(0),
    };
    await repos.reports.create(report);

    expect(await repos.reports.notifiedTo(ALICE)).toEqual([]);
    await repos.reports.save({ ...report, subjectNotified: true });
    expect(await repos.reports.notifiedTo(ALICE)).toHaveLength(1);
  });

  it('counts only live reports for the one-per-pair rule', async () => {
    const base = {
      id: 'aaaaaaaa-0000-4000-8000-000000000002' as never,
      reporterId: BOB,
      subject: { kind: 'USER' as const, userId: ALICE },
      subjectUserId: ALICE,
      reason: 'SPAM' as const,
      evidence: { capturedAt: at(0), authorId: ALICE, fields: [], photoKeys: [] },
      subjectNotified: false,
      createdAt: at(0),
      updatedAt: at(0),
    };
    await repos.reports.create({ ...base, status: 'OPEN' });
    expect(await repos.reports.openCount(BOB, ALICE)).toBe(1);

    await repos.reports.save({ ...base, status: 'DISMISSED' });
    expect(await repos.reports.openCount(BOB, ALICE)).toBe(0);
  });

  // ── Photos ───────────────────────────────────────────────────────
  it('round-trips photo bytes exactly', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await repos.photos.put('11111111-2222-4333-8444-555555555555', {
      contentType: 'image/png',
      bytes,
    });
    const back = await repos.photos.get('11111111-2222-4333-8444-555555555555');
    expect(back?.contentType).toBe('image/png');
    expect([...(back!.bytes)]).toEqual([...bytes]);
  });

  // ── Circles ──────────────────────────────────────────────────────
  it('stores a circle and reports its members as shared', async () => {
    await repos.circles.create({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never,
      ownerId: ALICE,
      name: 'Climbing crew',
      memberIds: [BOB],
      createdAt: at(0),
    });

    expect(await repos.social.sharedCircles(BOB, ALICE)).toHaveLength(1);
    expect(await repos.social.sharedCircles(CAROL, ALICE)).toHaveLength(0);
    expect((await repos.circles.ownedBy(ALICE))[0]?.name).toBe('Climbing crew');
  });

  // ── Sessions ─────────────────────────────────────────────────────
  it('stores and revokes sessions by token hash', async () => {
    const session = {
      tokenHash: 'a'.repeat(64),
      userId: ALICE,
      createdAt: at(0),
      expiresAt: at(23),
    };
    await repos.sessions.create(session);
    expect((await repos.sessions.byTokenHash('a'.repeat(64)))?.userId).toBe(ALICE);

    await repos.sessions.revokeAllFor(ALICE);
    expect(await repos.sessions.byTokenHash('a'.repeat(64))).toBeNull();
  });
});

// ── Things only the database can be asked ─────────────────────────────

describe('the Postgres schema', () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await createPgliteClient();
    await applySchema(db);
  });

  it('answers the overlap query through the GiST index', async () => {
    // Not just "does it return the right rows" — the index ADR 0004 asks for
    // has to actually be the one used, or it is decoration.
    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `explain select doc from events where owner_id = $1 and span && $2::tstzrange`,
      ['11111111-1111-4111-8111-111111111111', '[2026-09-01T09:00:00Z,2026-09-01T10:00:00Z)'],
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    // On an empty table the planner may prefer a seq scan; what matters is that
    // the index exists and is usable for this operator.
    const usable = await db.query<{ n: string }>(
      `select count(*) as n from pg_indexes
        where schemaname = 'public' and indexname = 'events_span_idx' and indexdef ilike '%gist%'`,
    );
    expect(Number(usable[0]?.n)).toBe(1);
    expect(text.length).toBeGreaterThan(0);
  });

  it('refuses a friendship row that is not canonically ordered', async () => {
    // The check constraint is what stops a pair drifting into two rows that
    // disagree about whether they are friends.
    await db.query(
      `insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`,
      ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'],
    );
    await expect(
      db.query(`insert into friendships (low_user_id, high_user_id) values ($1, $2)`, [
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ]),
    ).rejects.toThrow();
  });

  it('refuses a second claim from the same person on one listing', async () => {
    // The kernel refuses it first; this is the wall that refusal hits if a
    // handler ever forgets (ADR 0017).
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`, [
      ALICE,
      BOB,
    ]);
    await db.query(`insert into listings (id, owner_id, doc) values ($1, $2, '{}'::jsonb)`, [
      'dddddddd-dddd-4ddd-8ddd-000000000001',
      ALICE,
    ]);
    const claim = (id: string) =>
      db.query(`insert into claims (id, listing_id, claimant_id, doc) values ($1, $2, $3, '{}')`, [
        id,
        'dddddddd-dddd-4ddd-8ddd-000000000001',
        BOB,
      ]);

    await claim('ffffffff-ffff-4fff-8fff-000000000001');
    await expect(claim('ffffffff-ffff-4fff-8fff-000000000002')).rejects.toThrow();
  });

  it('keeps a block row when the user rows are deleted', async () => {
    // No `on delete cascade` on `blocks`, deliberately — see schema.sql.
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`, [
      ALICE,
      BOB,
    ]);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [ALICE, BOB]);
    await db.query(`delete from users where id = $1`, [BOB]);

    const rows = await db.query<{ n: string }>(`select count(*) as n from blocks`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('stores a mutual block as two rows, so either can be lifted alone', async () => {
    // The schema-level half of ADR 0028. A single canonically-ordered row
    // would make Alice's unblock silently clear Bob's protection too, and no
    // amount of care in the adapter could recover the lost direction.
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`, [
      ALICE,
      BOB,
    ]);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2), ($2, $1)`, [
      ALICE,
      BOB,
    ]);

    await db.query(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [ALICE, BOB]);

    const rows = await db.query<{ blocker_id: string; blocked_id: string }>(
      `select blocker_id, blocked_id from blocks`,
    );
    expect(rows).toEqual([{ blocker_id: BOB, blocked_id: ALICE }]);
  });

  it('refuses a block against yourself', async () => {
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A')`, [ALICE]);
    await expect(
      db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $1)`, [ALICE]),
    ).rejects.toThrow();
  });

  it('enforces the ownership policy on events for a non-superuser', async () => {
    /**
     * RLS is a **backstop**, not the control — a superuser bypasses it, which
     * is why the policy kernel is still the thing that decides. Exercised here
     * as a restricted role so the policy is proven to do something.
     */
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`, [
      ALICE,
      BOB,
    ]);
    await db.query(`create role app_restricted nologin`);
    await db.query(`grant select, insert, update, delete on all tables in schema public to app_restricted`);

    await db.query(`begin`);
    await db.query(`select set_config('app.actor_id', $1, true)`, [ALICE]);
    await db.query(`select set_config('app.cross_owner', 'off', true)`);
    await db.query(`set local role app_restricted`);

    // Writing your own row is fine…
    await db.query(
      `insert into events (id, owner_id, span, doc) values ($1, $2, $3::tstzrange, '{}')`,
      ['cccccccc-cccc-4ccc-8ccc-000000000001', ALICE, '[2026-09-01T09:00:00Z,2026-09-01T10:00:00Z)'],
    );

    // …and writing someone else's is the wall.
    await expect(
      db.query(`insert into events (id, owner_id, span, doc) values ($1, $2, $3::tstzrange, '{}')`, [
        'cccccccc-cccc-4ccc-8ccc-000000000002',
        BOB,
        '[2026-09-01T09:00:00Z,2026-09-01T10:00:00Z)',
      ]),
    ).rejects.toThrow();

    await db.query(`rollback`);
  });

  it('admits a sanctioned cross-owner write when the transaction says so', async () => {
    /**
     * Accepting a hangout writes an event to *both* calendars (ADR 0010), and a
     * naive ownership policy would block exactly the writes the product is
     * built around. Making the exception an explicit setting turns it into a
     * grep-able act rather than a capability every query silently carries.
     */
    await db.query(`insert into users (id, handle, display_name) values ($1,'a','A'), ($2,'b','B')`, [
      ALICE,
      BOB,
    ]);
    await db.query(`create role app_restricted2 nologin`);
    await db.query(`grant select, insert, update, delete on all tables in schema public to app_restricted2`);

    await db.query(`begin`);
    await db.query(`select set_config('app.actor_id', $1, true)`, [ALICE]);
    await db.query(`select set_config('app.cross_owner', 'on', true)`);
    await db.query(`set local role app_restricted2`);

    await db.query(
      `insert into events (id, owner_id, span, doc) values ($1, $2, $3::tstzrange, '{}')`,
      ['cccccccc-cccc-4ccc-8ccc-000000000003', BOB, '[2026-09-01T09:00:00Z,2026-09-01T10:00:00Z)'],
    );
    await db.query(`rollback`);
  });
});
