import {
  UpdateDiscoverabilityInput,
  UserId,
  type MeView,
  type PublicProfile,
} from '@friendszone/contracts';
import { assertAllowed, can, PolicyDeniedError } from '@friendszone/policy';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

const empty = z.object({});

export const buildPeopleRoutes = (repos: Repositories) => [
  /**
   * The signed-in user's own profile. The web client calls this on boot to
   * decide whether it is showing a session or a signed-out shell.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/me',
    authz: { kind: 'POLICY', action: 'profile:read' },
    params: empty,
    query: empty,
    handler: async (ctx): Promise<MeView> => {
      if (ctx.actorId === null) {
        throw new PolicyDeniedError('profile:read', 'ANONYMOUS');
      }
      const viewer = await ctx.viewerFor(ctx.actorId);
      assertAllowed(can(viewer, { action: 'profile:read', subjectId: ctx.actorId }));

      const profile = await repos.directory.profile(ctx.actorId);
      if (profile === null) {
        // An authenticated id with no profile row is a broken session, not a
        // missing person. Same outward shape as any other denial.
        throw new PolicyDeniedError('profile:read', 'NOT_OWNER');
      }
      // Read back off the viewer context, so the client's idea of "am I a
      // moderator" and the kernel's come from the same boot-time allowlist.
      return {
        ...profile,
        isModerator: viewer.isModerator,
        discoverability: await repos.directory.discoverability(ctx.actorId),
      };
    },
  }),

  /**
   * The people whose calendars you can ask about.
   *
   * Self-only: exposing this to friends would make the social graph traversable
   * one hop at a time, which the threat model relies on being impossible.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/people',
    authz: { kind: 'POLICY', action: 'friends:list' },
    params: empty,
    query: empty,
    handler: async (ctx): Promise<{ people: PublicProfile[] }> => {
      if (ctx.actorId === null) {
        throw new PolicyDeniedError('friends:list', 'ANONYMOUS');
      }
      const viewer = await ctx.viewerFor(ctx.actorId);
      assertAllowed(can(viewer, { action: 'friends:list', ownerId: ctx.actorId }));

      return { people: await repos.directory.friendsOf(ctx.actorId) };
    },
  }),

  /**
   * How findable you are.
   *
   * Yours alone, in both directions: nobody is told what anyone else's setting
   * is, because "why can't I find them" is itself an answer about them.
   */
  defineRoute({
    method: 'PUT',
    url: '/v1/me/discoverability',
    authz: { kind: 'POLICY', action: 'discoverability:manage' },
    rateLimit: 'WRITE',
    params: empty,
    query: empty,
    body: UpdateDiscoverabilityInput,
    handler: async (ctx): Promise<{ discoverability: MeView['discoverability'] }> => {
      if (ctx.actorId === null) {
        throw new PolicyDeniedError('discoverability:manage', 'ANONYMOUS');
      }
      const viewer = await ctx.viewerFor(ctx.actorId);
      assertAllowed(can(viewer, { action: 'discoverability:manage' }));

      await repos.directory.setDiscoverability(ctx.actorId, ctx.body.discoverability);
      return { discoverability: ctx.body.discoverability };
    },
  }),

  /**
   * A friend's public profile, for the calendar header.
   */
  defineRoute({
    method: 'GET',
    rateLimit: 'READ',
    url: '/v1/people/:userId',
    authz: { kind: 'POLICY', action: 'profile:read' },
    params: z.object({ userId: UserId }),
    query: empty,
    handler: async (ctx): Promise<PublicProfile> => {
      const subjectId = ctx.params.userId;
      const viewer = await ctx.viewerFor(subjectId);
      assertAllowed(can(viewer, { action: 'profile:read', subjectId }));

      const profile = await repos.directory.profile(subjectId);
      if (profile === null) {
        // Indistinguishable from "not allowed" — both surface as 404.
        throw new PolicyDeniedError('profile:read', 'NOT_FRIENDS');
      }
      return profile;
    },
  }),
];
