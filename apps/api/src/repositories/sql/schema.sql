-- Friendszone schema.
--
-- Design rationale: docs/adr/0004-persistence.md (PostgreSQL with RLS) and
-- docs/adr/0026-sql-layer.md (raw SQL, jsonb payloads, RLS as a backstop).
--
-- Two rules a reviewer should hold while reading this file:
--
--   1. Columns exist for exactly what is queried, indexed, or enforced on.
--      Everything else lives in `doc jsonb`, because `packages/contracts`
--      already describes these shapes once and a third description would drift.
--
--   2. The RLS policies express **ownership only**. The visibility lattice is
--      not in here and must never be: it belongs in `packages/policy`, where it
--      is readable and exhaustively tested. These policies are the wall a
--      handler bug hits, not the thing that decides.

-- ── Identity ────────────────────────────────────────────────────────

create table if not exists users (
  id            uuid primary key,
  handle        text        not null,
  display_name  text        not null,
  avatar_url    text,
  -- Deletion empties the row and keeps the id, so every hangout, handoff, and
  -- moderation case that references it stays resolvable (ADR 0022).
  tombstoned    boolean     not null default false,
  -- How findable this account is in people search. A column rather than `doc`
  -- because the search query filters on it (ADR 0026: columns exist for what
  -- is queried). There is deliberately no FRIENDS_OF_FRIENDS value: answering
  -- it would require walking the graph, which the threat model forbids.
  discoverability text      not null default 'EVERYONE'
    constraint users_discoverability_check
    check (discoverability in ('EVERYONE', 'EXACT_HANDLE', 'NOBODY')),
  created_at    timestamptz not null default now()
);

-- Handles are compared case-insensitively; `citext` would need an extension.
create unique index if not exists users_handle_key on users (lower(handle));

-- ── Direct messages ────────────────────────────────────────────────
--
-- A conversation is exactly two people, canonically ordered like `friendships`
-- so a pair cannot drift into two half-threads. Unlike `blocks`, one row is
-- correct: the only per-side state is the read bookmark, and that is two
-- columns rather than two rows.
create table if not exists conversations (
  id              uuid primary key,
  low_user_id     uuid        not null,
  high_user_id    uuid        not null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  -- Each participant's own bookmark. Two columns, never one shared value:
  -- one party's reading must not clear the other's unread count. Neither is
  -- ever projected to the other side - there are no read receipts (ADR 0007).
  low_read_at     timestamptz,
  high_read_at    timestamptz,
  constraint conversations_ordered check (low_user_id < high_user_id),
  constraint conversations_pair unique (low_user_id, high_user_id)
);

create index if not exists conversations_low_idx  on conversations (low_user_id, last_message_at desc);
create index if not exists conversations_high_idx on conversations (high_user_id, last_message_at desc);

create table if not exists messages (
  id              uuid primary key,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  sender_id       uuid        not null,
  -- 🟠 Sensitive: free text between two named people. Never logged.
  body            text        not null,
  sent_at         timestamptz not null default now()
);

create index if not exists messages_thread_idx on messages (conversation_id, sent_at);

create table if not exists auth_identities (
  provider    text        not null,
  subject     text        not null,
  user_id     uuid        not null references users (id) on delete cascade,
  -- 🔴 Restricted. scrypt, self-describing: `scrypt$N$r$p$salt$hash`.
  secret_hash text,
  created_at  timestamptz not null default now(),
  primary key (provider, subject)
);

create index if not exists auth_identities_user_idx on auth_identities (user_id);

create table if not exists sessions (
  -- The **hash** of the token, never the token. A dump of this table yields
  -- values that cannot be presented (ADR 0024).
  token_hash text        primary key,
  user_id    uuid        not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- ── Social graph ────────────────────────────────────────────────────

-- One row per pair, canonically ordered, so a pair cannot drift into a
-- half-accepted state visible from one side only (domain-model.md).
create table if not exists friendships (
  low_user_id  uuid not null references users (id) on delete cascade,
  high_user_id uuid not null references users (id) on delete cascade,
  -- Who asked. Lets the interface tell "Bob wants to be friends" from "you
  -- asked Bob" without a second query (ADR 0028).
  requested_by uuid not null references users (id) on delete cascade,
  status       text not null default 'ACCEPTED'
               check (status in ('PENDING', 'ACCEPTED')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (low_user_id, high_user_id),
  constraint friendships_ordered check (low_user_id < high_user_id)
);

create index if not exists friendships_pending_idx
  on friendships (requested_by) where status = 'PENDING';

-- Blocks are a separate record, not a friendship status, so a block survives
-- every other change (domain-model.md). **Never deleted by account deletion**:
-- clearing one would make delete-and-rejoin a route back to someone who blocked
-- you (ADR 0004, ADR 0022). No `on delete cascade` here, deliberately.
-- **Directed**, one row per direction, unlike `friendships`. If Alice blocks
-- Bob and Bob blocks Alice there are two rows, so Alice unblocking cannot take
-- Bob's block with it - which an undirected pair would (ADR 0028). `relationship()`
-- still collapses to BLOCKED if a row exists either way.
create table if not exists blocks (
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

create index if not exists blocks_blocked_idx on blocks (blocked_id);

create table if not exists circles (
  id         uuid primary key,
  owner_id   uuid        not null references users (id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now()
);

create index if not exists circles_owner_idx on circles (owner_id);

-- Membership is a join, not a blob: an orphaned membership row is a potential
-- authorization bug, so it gets referential integrity (ADR 0004).
create table if not exists circle_members (
  circle_id uuid not null references circles (id) on delete cascade,
  user_id   uuid not null references users (id) on delete cascade,
  primary key (circle_id, user_id)
);

create index if not exists circle_members_user_idx on circle_members (user_id);

-- ── Calendar ────────────────────────────────────────────────────────

create table if not exists events (
  id       uuid primary key,
  owner_id uuid      not null references users (id) on delete cascade,
  -- Half-open `[start, end)`, matching `TimeRange` exactly. A closed range
  -- would make back-to-back events register as overlapping (ADR 0004).
  span     tstzrange not null,
  doc      jsonb     not null
);

-- `eventsInWindow` is the hot path and it is an overlap query, so the range gets
-- a GiST index rather than a btree (ADR 0004).
--
-- Two indexes rather than one composite `gist (owner_id, span)`: GiST has no
-- default operator class for `uuid`, so a composite needs the `btree_gist`
-- extension. Requiring an extension would mean the test engine and production
-- could diverge on whether it is present, and the planner combines these two
-- perfectly well for a query that filters one owner and overlaps one window.
create index if not exists events_span_idx on events using gist (span);
create index if not exists events_owner_idx on events (owner_id);

create table if not exists sharing_defaults (
  user_id uuid primary key references users (id) on delete cascade,
  doc     jsonb not null
);

-- A recurring daily window in which nobody may propose a plan. Config, not
-- content: no id, no title, and never an entry on the calendar.
create table if not exists quiet_hours (
  user_id uuid primary key references users (id) on delete cascade,
  doc     jsonb not null
);

create table if not exists hangouts (
  id          uuid primary key,
  proposer_id uuid        not null references users (id) on delete cascade,
  -- Denormalised out of the doc so the inbox is an index lookup rather than a
  -- scan over every request in the system.
  invitee_ids uuid[]      not null,
  doc         jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists hangouts_proposer_idx on hangouts (proposer_id);
create index if not exists hangouts_invitees_idx on hangouts using gin (invitee_ids);

-- ── Things ──────────────────────────────────────────────────────────

create table if not exists listings (
  id         uuid primary key,
  owner_id   uuid        not null references users (id) on delete cascade,
  doc        jsonb       not null,
  created_at timestamptz not null default now()
);

create index if not exists listings_recent_idx on listings (created_at desc);

create table if not exists claims (
  id          uuid primary key,
  listing_id  uuid        not null references listings (id) on delete cascade,
  claimant_id uuid        not null references users (id) on delete cascade,
  doc         jsonb       not null,
  created_at  timestamptz not null default now(),
  -- One person, one entry. The kernel refuses a second claim, and this is the
  -- wall that refusal hits if a handler ever forgets (ADR 0017).
  unique (listing_id, claimant_id)
);

create index if not exists claims_listing_idx on claims (listing_id, created_at);

create table if not exists exchanges (
  id          uuid primary key,
  claim_id    uuid        not null references claims (id) on delete cascade,
  proposed_by uuid        not null references users (id) on delete cascade,
  doc         jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists exchanges_claim_idx on exchanges (claim_id, created_at desc);

create table if not exists photos (
  key          uuid primary key,
  -- The *sniffed* type, never the client's claim (apps/api/src/http/images.ts).
  content_type text  not null,
  bytes        bytea not null
);

-- ── Moderation ──────────────────────────────────────────────────────

create table if not exists reports (
  id              uuid primary key,
  -- 🔴 Restricted. Never projected to the subject, at any status (ADR 0018).
  reporter_id     uuid        not null references users (id) on delete cascade,
  subject_user_id uuid        not null references users (id) on delete cascade,
  status          text        not null,
  doc             jsonb       not null,
  created_at      timestamptz not null default now()
);

create index if not exists reports_reporter_idx on reports (reporter_id, created_at desc);
create index if not exists reports_subject_idx on reports (subject_user_id, created_at desc);
create index if not exists reports_queue_idx on reports (created_at desc);

create table if not exists report_notes (
  id         uuid primary key,
  report_id  uuid        not null references reports (id) on delete cascade,
  -- Which one-way thread. There is no `BOTH`, and adding one collapses the
  -- guarantee that the two parties never share an object (ADR 0018).
  audience   text        not null check (audience in ('REPORTER', 'SUBJECT')),
  doc        jsonb       not null,
  created_at timestamptz not null default now()
);

create index if not exists report_notes_report_idx on report_notes (report_id, created_at);

create table if not exists notifications (
  id           uuid primary key,
  recipient_id uuid        not null references users (id) on delete cascade,
  actor_id     uuid        not null references users (id) on delete cascade,
  doc          jsonb       not null,
  created_at   timestamptz not null default now()
);

create index if not exists notifications_recipient_idx
  on notifications (recipient_id, created_at desc);

-- ── Additive migrations ────────────────────────────────────────────
--
-- `create table if not exists` above does nothing to a table that already
-- exists, so a column added to this file after a database was created would
-- never appear in it. That is not a hypothetical: the production database was
-- created before `users.discoverability` existed, and deploying without this
-- block would have left every search query referencing a column that was not
-- there.
--
-- Each statement here must be idempotent and safe to run on every boot, since
-- `applySchema` is called unconditionally at start-up. This is a deliberate
-- stand-in for a migration tool, not a substitute for one - see
-- docs/product/road-to-ga.md.

alter table users
  add column if not exists discoverability text not null default 'EVERYONE';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_discoverability_check'
  ) then
    alter table users add constraint users_discoverability_check
      check (discoverability in ('EVERYONE', 'EXACT_HANDLE', 'NOBODY'));
  end if;
end
$$;

-- ── Row-level security ──────────────────────────────────────────────
--
-- Ownership only. `app.actor_id` is set with SET LOCAL inside a transaction -
-- never per connection, because a pooled connection leaks session state between
-- requests.
--
-- `app.cross_owner` admits the sanctioned cross-owner writes the product is
-- built around: accepting a hangout writes an event to *both* calendars
-- (ADR 0010), and so does booking a handoff (ADR 0019). Making that an explicit
-- setting turns "this writes to someone else's calendar" into a grep-able act
-- rather than a capability every query silently carries (ADR 0026).

create or replace function app_actor_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid
$$;

create or replace function app_cross_owner() returns boolean language sql stable as $$
  select coalesce(current_setting('app.cross_owner', true), 'off') = 'on'
$$;

alter table events           enable row level security;
alter table sharing_defaults enable row level security;
alter table quiet_hours      enable row level security;
alter table circles          enable row level security;
alter table listings         enable row level security;

-- FORCE so the policies apply to the table owner too. A superuser still
-- bypasses them, which is why this is a backstop and not the control.
alter table events           force row level security;
alter table sharing_defaults force row level security;
alter table quiet_hours      force row level security;
alter table circles          force row level security;
alter table listings         force row level security;

drop policy if exists events_owner on events;
create policy events_owner on events
  using (owner_id = app_actor_id() or app_cross_owner())
  with check (owner_id = app_actor_id() or app_cross_owner());

drop policy if exists sharing_defaults_owner on sharing_defaults;
create policy sharing_defaults_owner on sharing_defaults
  using (user_id = app_actor_id())
  with check (user_id = app_actor_id());

-- Ownership only, like every other policy here: RLS is a backstop, never the
-- control. The lattice stays in packages/policy (ADR 0026).
drop policy if exists quiet_hours_owner on quiet_hours;
create policy quiet_hours_owner on quiet_hours
  using (user_id = app_actor_id())
  with check (user_id = app_actor_id());

drop policy if exists circles_owner on circles;
create policy circles_owner on circles
  using (owner_id = app_actor_id())
  with check (owner_id = app_actor_id());

-- Listings are *read* by their audience, which RLS deliberately does not model -
-- that is the lattice, and it stays in the kernel. Reads are open here and the
-- projection decides; writes are the owner's alone.
drop policy if exists listings_read on listings;
create policy listings_read on listings for select using (true);

drop policy if exists listings_write on listings;
create policy listings_write on listings for all
  using (owner_id = app_actor_id())
  with check (owner_id = app_actor_id());
