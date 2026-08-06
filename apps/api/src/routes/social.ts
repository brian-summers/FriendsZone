import {
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  RespondToFriendRequestInput,
  UserId,
  type Friendship,
  type FriendRequestView,
  type PersonSearchResult,
  type PublicProfile,
  type SearchResultStatus,
} from '@friendszone/contracts';
import { assertAllowed, can, PolicyDeniedError } from '@friendszone/policy';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Friend requests, unfriending, and blocking.
 *
 * Two rules govern this file, and both are easy to lose in a refactor:
 *
 *  1. **A block is directed.** Every write here touches only the caller's own
 *     row. Unblocking someone who also blocked you must leave their protection
 *     standing, which means no query in this file may treat a pair as one fact.
 *  2. **A blocked pair cannot find each other.** Search, request, and respond
 *     all deny before they confirm the other person exists, and every denial
 *     is the same 404 a nonexistent id produces.
 *
 * See docs/adr/0028-friend-requests-and-blocking.md.
 */

const empty = z.object({});

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

/** Canonical ordering, matching the storage constraint. */
const ordered = (a: UserId, b: UserId): [UserId, UserId] => (a < b ? [a, b] : [b, a]);

export function buildSocialRoutes(repos: Repositories) {
  /**
   * How the actor stands with someone, as a search result renders it.
   *
   * Derived from the friendship row rather than `relationship()` because the
   * client needs to know *who asked* — "cancel request" and "accept" are
   * different buttons — and `RelationshipKind` deliberately collapses both
   * into `PENDING`.
   */
  const statusFor = async (actorId: UserId, otherId: UserId): Promise<SearchResultStatus> => {
    const friendship = await repos.social.friendship(actorId, otherId);
    if (friendship === null) return 'NONE';
    if (friendship.status === 'ACCEPTED') return 'FRIEND';
    return friendship.requestedBy === actorId ? 'REQUESTED' : 'AWAITING_YOU';
  };

  const requestView = async (
    actorId: UserId,
    friendship: Friendship,
  ): Promise<FriendRequestView | null> => {
    const otherId =
      friendship.lowUserId === actorId ? friendship.highUserId : friendship.lowUserId;
    const profile = await repos.directory.profile(otherId);
    // A pending request from an account that has since been deleted is not a
    // person you can answer. Dropped rather than rendered as a tombstone.
    if (profile === null) return null;
    return {
      userId: otherId,
      handle: profile.handle,
      displayName: profile.displayName,
      ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
      sentByYou: friendship.requestedBy === actorId,
      createdAt: friendship.createdAt,
    };
  };

  return [
    /**
     * Find someone by handle or display name.
     *
     * The only endpoint in the product that returns people the caller has no
     * relationship with, which is why it is `EXPENSIVE` and hard-bounded: an
     * unbounded directory search is the enumeration vector the threat model
     * names. `PublicProfile` is kept minimal precisely so that scraping the
     * whole directory yields a handle and a display name and nothing else.
     */
    defineRoute({
      method: 'GET',
      url: '/v1/people/search',
      authz: { kind: 'POLICY', action: 'people:search' },
      rateLimit: 'EXPENSIVE',
      params: empty,
      query: z.object({ q: z.string().min(MIN_SEARCH_LENGTH).max(64) }),
      handler: async (ctx): Promise<{ results: PersonSearchResult[] }> => {
        const actorId = requireActor(ctx.actorId, 'people:search');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'people:search' }));

        // Over-fetch, because the block filter below removes rows and a limit
        // applied after filtering would let a caller detect a block by
        // noticing a short page. The bound is still hard.
        const raw = await repos.directory.search(ctx.query.q, MAX_SEARCH_RESULTS * 2);

        const results: PersonSearchResult[] = [];
        for (const profile of raw) {
          if (profile.id === actorId) continue;
          if (results.length >= MAX_SEARCH_RESULTS) break;
          // `relationship()` collapses a block in either direction, so this
          // single check covers both "you blocked them" and "they blocked
          // you" — and the two are indistinguishable in the output, as they
          // must be.
          const relationship = await repos.social.relationship(actorId, profile.id);
          if (relationship === 'BLOCKED') continue;
          results.push({
            id: profile.id,
            handle: profile.handle,
            displayName: profile.displayName,
            ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
            status: await statusFor(actorId, profile.id),
          });
        }
        return { results };
      },
    }),

    /** Requests you have sent and received, in one list. */
    defineRoute({
      method: 'GET',
      url: '/v1/me/friend-requests',
      authz: { kind: 'POLICY', action: 'friends:list' },
      rateLimit: 'READ',
      params: empty,
      query: empty,
      handler: async (ctx): Promise<{ requests: FriendRequestView[] }> => {
        const actorId = requireActor(ctx.actorId, 'friends:list');
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'friends:list', ownerId: actorId }),
        );

        const pending = await repos.social.pendingFriendships(actorId);
        const views = await Promise.all(pending.map((f) => requestView(actorId, f)));
        return { requests: views.filter((v): v is FriendRequestView => v !== null) };
      },
    }),

    /**
     * Ask someone to be friends.
     *
     * A request from a blocked party must be indistinguishable from a request
     * to a user who does not exist, so the block check and the missing-profile
     * check throw the same thing.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/people/:userId/friend-request',
      authz: { kind: 'POLICY', action: 'friend:request' },
      rateLimit: 'WRITE',
      params: z.object({ userId: UserId }),
      query: empty,
      body: empty,
      handler: async (ctx): Promise<FriendRequestView> => {
        const actorId = requireActor(ctx.actorId, 'friend:request');
        const targetId = ctx.params.userId;
        const viewer = await ctx.viewerFor(actorId);

        const existing = await repos.social.relationship(actorId, targetId);
        if (existing === 'BLOCKED' || (await repos.directory.profile(targetId)) === null) {
          throw new PolicyDeniedError('friend:request', 'BLOCKED');
        }
        assertAllowed(can(viewer, { action: 'friend:request', targetId, existing }));

        const [lowUserId, highUserId] = ordered(actorId, targetId);
        const friendship: Friendship = {
          lowUserId,
          highUserId,
          requestedBy: actorId, // ← from the session, never the body
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        };
        const saved = await repos.social.saveFriendship(friendship);

        const view = await requestView(actorId, saved);
        if (view === null) throw new PolicyDeniedError('friend:request', 'BLOCKED');
        return view;
      },
    }),

    /**
     * Accept or decline a request someone sent you.
     *
     * Declining *removes the row* rather than marking it declined. A stored
     * "declined" would answer "did they turn me down, or just not look yet?",
     * and the sender is not owed that (ADR 0028). It also means a second
     * request later is an ordinary request rather than a special case.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/me/friend-requests/:userId',
      authz: { kind: 'POLICY', action: 'friend:respond' },
      rateLimit: 'WRITE',
      params: z.object({ userId: UserId }),
      query: empty,
      body: RespondToFriendRequestInput,
      handler: async (ctx): Promise<{ status: 'FRIEND' | 'NONE' }> => {
        const actorId = requireActor(ctx.actorId, 'friend:respond');
        const otherId = ctx.params.userId;
        const viewer = await ctx.viewerFor(actorId);

        const request = await repos.social.friendship(actorId, otherId);
        // No such request, and a request you are not party to, are one outcome.
        if (request === null) throw new PolicyDeniedError('friend:respond', 'NOT_PARTICIPANT');
        assertAllowed(can(viewer, { action: 'friend:respond', request }));

        if (ctx.body.decision === 'DECLINE') {
          await repos.social.removeFriendship(actorId, otherId);
          return { status: 'NONE' };
        }

        await repos.social.saveFriendship({
          ...request,
          status: 'ACCEPTED',
          acceptedAt: new Date().toISOString(),
        });
        return { status: 'FRIEND' };
      },
    }),

    /**
     * Unfriend, or withdraw a request you sent.
     *
     * One route, because they are the same write and the kernel allows either
     * party to make it. Deliberately **does not scrub circle rosters** — the
     * friendship re-check in `audienceMatches` makes a stale entry grant
     * nothing, and rewriting someone's circles as a side effect of their
     * friend's action is a worse outcome than a name they can remove
     * themselves (ADR 0023).
     */
    defineRoute({
      method: 'DELETE',
      url: '/v1/people/:userId/friendship',
      authz: { kind: 'POLICY', action: 'friend:remove' },
      rateLimit: 'WRITE',
      params: z.object({ userId: UserId }),
      query: empty,
      body: empty,
      handler: async (ctx): Promise<{ removed: true }> => {
        const actorId = requireActor(ctx.actorId, 'friend:remove');
        const otherId = ctx.params.userId;

        const friendship = await repos.social.friendship(actorId, otherId);
        if (friendship === null) throw new PolicyDeniedError('friend:remove', 'NOT_PARTICIPANT');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'friend:remove', friendship }));

        await repos.social.removeFriendship(actorId, otherId);
        return { removed: true };
      },
    }),

    /**
     * Block someone.
     *
     * Blocking also **removes the friendship or pending request**, because a
     * block that left a friendship standing would be a lie the moment the
     * block were lifted, and a pending request surviving a block would let the
     * blocked party's ask reappear in the blocker's inbox.
     *
     * Deliberately succeeds for a target you have no relationship with, and
     * for one that does not exist: "that user does not exist" in response to a
     * block attempt is an existence oracle, and blocking is exactly the moment
     * a user is least owed a bad experience.
     */
    defineRoute({
      method: 'PUT',
      url: '/v1/people/:userId/block',
      authz: { kind: 'POLICY', action: 'block:create' },
      rateLimit: 'WRITE',
      params: z.object({ userId: UserId }),
      query: empty,
      body: empty,
      handler: async (ctx): Promise<{ blocked: true }> => {
        const actorId = requireActor(ctx.actorId, 'block:create');
        const targetId = ctx.params.userId;
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'block:create', targetId }),
        );

        await repos.social.block(actorId, targetId);
        await repos.social.removeFriendship(actorId, targetId);
        return { blocked: true };
      },
    }),

    /**
     * Unblock someone.
     *
     * Removes **only your row**. If they also blocked you, that block stands
     * and you remain invisible to each other — which is why `blocks` is
     * directed at all. This does not restore a friendship: blocking severed
     * it, and re-forming it is a new request either party may send.
     */
    defineRoute({
      method: 'DELETE',
      url: '/v1/people/:userId/block',
      authz: { kind: 'POLICY', action: 'block:remove' },
      rateLimit: 'WRITE',
      params: z.object({ userId: UserId }),
      query: empty,
      body: empty,
      handler: async (ctx): Promise<{ blocked: false }> => {
        const actorId = requireActor(ctx.actorId, 'block:remove');
        const targetId = ctx.params.userId;
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'block:remove', targetId }),
        );

        await repos.social.unblock(actorId, targetId);
        return { blocked: false };
      },
    }),

    /**
     * Who you have blocked.
     *
     * Yours alone — there is no endpoint anywhere that answers "who blocked
     * me", for the same reason there is no "circles you're in": the answer is
     * the other party's, and knowing it is what makes a block evadable.
     */
    defineRoute({
      method: 'GET',
      url: '/v1/me/blocks',
      authz: { kind: 'POLICY', action: 'block:list' },
      rateLimit: 'READ',
      params: empty,
      query: empty,
      handler: async (ctx): Promise<{ blocked: PublicProfile[] }> => {
        const actorId = requireActor(ctx.actorId, 'block:list');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'block:list' }));

        const ids = await repos.social.blockedBy(actorId);
        const profiles = await Promise.all(ids.map((id) => repos.directory.profile(id)));
        return { blocked: profiles.filter((p): p is PublicProfile => p !== null) };
      },
    }),
  ];
}
