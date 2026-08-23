import {
  CircleId,
  CreateCircleInput,
  MAX_CIRCLES_PER_USER,
  UpdateCircleInput,
  type Circle,
  type CircleView,
  type UserId,
} from '@friendszone/contracts';
import { assertAllowed, can, PolicyDeniedError } from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../http/errors.js';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Circles - the owner's private groupings of their friends.
 *
 * The rule that governs this file: **a circle is visible only to its owner, and
 * its name most of all.** There is no route here that answers "which circles am
 * I in", and adding one would publish the taxonomy of someone's social life that
 * circles exist to keep private. The tempting version is a sharing checkup that
 * explains *why* a viewer can see something; the checkup already answers the
 * safe form of that question - *what* they can see.
 *
 * See docs/adr/0023-circle-management.md.
 */

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

export function buildCircleRoutes(repos: Repositories) {
  /**
   * Project a circle for its owner, marking members who are no longer friends.
   *
   * Unfriending deliberately does not scrub rosters - `audienceMatches`
   * re-checks friendship at read time, so a stale entry grants nothing - but
   * the owner is shown the truth rather than a quietly edited list.
   */
  const view = async (circle: Circle, ownerId: UserId): Promise<CircleView> => {
    const contexts = await repos.social.contextsFor(ownerId, circle.memberIds);
    return {
      id: circle.id,
      name: circle.name,
      members: circle.memberIds.map((userId) => ({
        userId,
        stillAFriend: contexts.get(userId)?.relationship === 'FRIEND',
      })),
      createdAt: circle.createdAt,
    };
  };

  /** Load a circle you own, or throw the 404 an unknown id would produce. */
  const own = async (id: CircleId, actorId: UserId, action: string): Promise<Circle> => {
    const circle = await repos.circles.byId(id);
    // Unknown and not-yours collapse to one outcome, as everywhere else.
    if (circle === null || circle.ownerId !== actorId) {
      throw new PolicyDeniedError(action, 'NOT_OWNER');
    }
    return circle;
  };

  /**
   * Keep only ids that are actually friends.
   *
   * Not a security control - the friendship re-check at read time is that -
   * but a roster full of people who can never match is a list that lies to its
   * owner about who can see their calendar.
   */
  const friendsOnly = async (ownerId: UserId, ids: readonly UserId[]): Promise<UserId[]> => {
    const unique = [...new Set(ids)].filter((id) => id !== ownerId);
    const contexts = await repos.social.contextsFor(ownerId, unique);
    return unique.filter((id) => contexts.get(id)?.relationship === 'FRIEND');
  };

  return [
    defineRoute({
      method: 'GET',
      url: '/v1/me/circles',
      authz: { kind: 'POLICY', action: 'circle:manage' },
      rateLimit: 'READ',
      params: z.object({}),
      query: z.object({}),
      handler: async (ctx): Promise<{ circles: CircleView[] }> => {
        const actorId = requireActor(ctx.actorId, 'circle:manage');
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'circle:manage', ownerId: actorId }),
        );

        const owned = await repos.circles.ownedBy(actorId);
        return { circles: await Promise.all(owned.map((c) => view(c, actorId))) };
      },
    }),

    defineRoute({
      method: 'POST',
      url: '/v1/me/circles',
      authz: { kind: 'POLICY', action: 'circle:manage' },
      rateLimit: 'WRITE',
      params: z.object({}),
      query: z.object({}),
      body: CreateCircleInput,
      handler: async (ctx): Promise<CircleView> => {
        const actorId = requireActor(ctx.actorId, 'circle:manage');
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'circle:manage', ownerId: actorId }),
        );

        // Bounded, like every other collection in the product.
        if ((await repos.circles.ownedBy(actorId)).length >= MAX_CIRCLES_PER_USER) {
          throw new ValidationError(['circles']);
        }

        const circle: Circle = {
          id: randomUUID() as CircleId,
          ownerId: actorId, // ← from the session, never the body
          name: ctx.body.name,
          memberIds: await friendsOnly(actorId, ctx.body.memberIds),
          createdAt: new Date().toISOString(),
        };

        return view(await repos.circles.create(circle), actorId);
      },
    }),

    defineRoute({
      method: 'PATCH',
      url: '/v1/me/circles/:id',
      authz: { kind: 'POLICY', action: 'circle:manage' },
      rateLimit: 'WRITE',
      params: z.object({ id: CircleId }),
      query: z.object({}),
      body: UpdateCircleInput,
      handler: async (ctx): Promise<CircleView> => {
        const actorId = requireActor(ctx.actorId, 'circle:manage');
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'circle:manage', ownerId: actorId }),
        );

        const existing = await own(ctx.params.id, actorId, 'circle:manage');
        const updated: Circle = {
          ...existing,
          ...(ctx.body.name === undefined ? {} : { name: ctx.body.name }),
          ...(ctx.body.memberIds === undefined
            ? {}
            : { memberIds: await friendsOnly(actorId, ctx.body.memberIds) }),
        };

        return view(await repos.circles.save(updated), actorId);
      },
    }),

    /**
     * Delete a circle, and remove the rules that named it.
     *
     * A rule naming a gone circle already fails closed, so the scrub is
     * tidiness backed by a safe default rather than the control itself. Not
     * refused when the circle is in use: trapping someone inside a grouping
     * they no longer want is not a refusal we get to make (ADR 0023).
     */
    defineRoute({
      method: 'DELETE',
      url: '/v1/me/circles/:id',
      authz: { kind: 'POLICY', action: 'circle:manage' },
      rateLimit: 'WRITE',
      params: z.object({ id: CircleId }),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx): Promise<{ deleted: true }> => {
        const actorId = requireActor(ctx.actorId, 'circle:manage');
        assertAllowed(
          can(await ctx.viewerFor(actorId), { action: 'circle:manage', ownerId: actorId }),
        );

        const circle = await own(ctx.params.id, actorId, 'circle:manage');
        await repos.calendar.scrubCircleRules(actorId, circle.id);
        await repos.circles.remove(circle.id);
        return { deleted: true };
      },
    }),
  ];
}
