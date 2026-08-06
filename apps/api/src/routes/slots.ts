import {
  FindSlotsInput,
  MAX_SLOT_PARTICIPANTS,
  type BusyBlock,
  type FindSlotsResult,
  type SlotParticipant,
  type UserId,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  findFreeSlots,
  PolicyDeniedError,
  projectCalendar,
  sharesAvailabilityWith,
  type ViewerContext,
} from '@friendszone/policy';
import { z } from 'zod';
import { ValidationError } from '../http/errors.js';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * "When are we all free?"
 *
 * Read docs/adr/0008-slot-finder-on-projections.md before changing anything.
 * The single load-bearing line in this file is that every participant's
 * availability comes from `projectCalendar` **computed for the requester** —
 * the identical output they would get by opening that person's calendar.
 *
 * Swapping that for `repos.calendar.eventsInWindow` directly would look like an
 * obvious simplification, produce identical results in every test that checks
 * one query, and reopen a differential attack that reconstructs a whole calendar
 * from someone who shared nothing. The projection is not an implementation
 * detail here; it is the entire security argument.
 */

/** Matches the calendar's own cap. A slot query is a calendar read, N times. */
const MAX_WINDOW_DAYS = 62;

export function buildSlotRoutes(repos: Repositories) {
  return [
    defineRoute({
      method: 'POST',
      url: '/v1/slots/find',
      rateLimit: 'EXPENSIVE',
      authz: { kind: 'POLICY', action: 'slots:find' },
      params: z.object({}),
      query: z.object({}),
      // A POST because the participant list is a body, not because it writes.
      // Nothing here mutates anything.
      body: FindSlotsInput,
      handler: async (ctx): Promise<FindSlotsResult> => {
        const actorId = ctx.actorId;
        if (actorId === null) throw new PolicyDeniedError('slots:find', 'ANONYMOUS');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'slots:find' }));

        const { window, durationMinutes, earliestHour, latestHour } = ctx.body;

        if (Date.parse(window.end) - Date.parse(window.start) > MAX_WINDOW_DAYS * 86_400_000) {
          throw new ValidationError(['window']);
        }
        if (latestHour <= earliestHour) throw new ValidationError(['latestHour']);

        /**
         * Deduplicate, and drop the requester if they named themselves.
         *
         * They are always a participant — it is "when are *we* free" — so
         * including them twice would be harmless but listing them twice in the
         * denominator would be confusing.
         */
        const others = [...new Set(ctx.body.participantIds)].filter((id) => id !== actorId);
        const everyone: UserId[] = [actorId, ...others];
        if (everyone.length > MAX_SLOT_PARTICIPANTS) throw new ValidationError(['participantIds']);

        // One batched lookup rather than N round trips — the reason
        // `contextsFor` exists (ADR 0008).
        const contexts = await repos.social.contextsFor(actorId, everyone);

        const busyByParticipant: BusyBlock[][] = [];
        const participants: SlotParticipant[] = [];

        for (const ownerId of everyone) {
          const social = contexts.get(ownerId);
          // The port guarantees an entry for every id; treat an absent one as
          // maximally restrictive rather than trusting the adapter.
          const viewer: ViewerContext = {
            viewerId: actorId,
            relationship: social?.relationship ?? 'NONE',
            sharedCircleIds: social?.sharedCircleIds ?? [],
            // Moderation grants no visibility anywhere, least of all here.
            isModerator: false,
          };

          const [events, ownerDefaults] = await Promise.all([
            repos.calendar.eventsInWindow(ownerId, window),
            repos.calendar.sharingDefaults(ownerId),
          ]);

          // ← The line the ADR is about. Raw events never reach the intersection.
          const view = projectCalendar({ ownerId, events, viewer, ownerDefaults, window });

          busyByParticipant.push(view.busy);

          /**
           * The honest denominator.
           *
           * True when this person's sharing actually reaches the requester —
           * either their defaults grant at least BUSY, or something in the
           * window resolved that far. The first disjunct matters for someone
           * who shares availability and simply has a free week; without it they
           * would be reported as sharing nothing.
           *
           * The requester always "shares" with themselves.
           */
          const shares =
            ownerId === actorId ||
            sharesAvailabilityWith(ownerDefaults, viewer) ||
            view.busy.length > 0 ||
            view.details.length > 0;

          participants.push({ userId: ownerId, sharesAvailability: shares });
        }

        /**
         * Local hour bounds, resolved against the *server's* zone.
         *
         * Honest about what this is: a single-timezone approximation, correct
         * while the API and the browser share a machine and wrong the moment
         * they do not. Travel mode is on the roadmap and owns the real fix; a
         * per-user zone guessed here would be a second, quieter wrong answer.
         */
        const dayBoundsFor = (ms: number) => {
          const d = new Date(ms);
          const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          return {
            dayStart,
            earliest: dayStart + earliestHour * 3_600_000,
            latest: dayStart + latestHour * 3_600_000,
          };
        };

        return {
          slots: findFreeSlots({
            window,
            busyByParticipant,
            durationMinutes,
            dayBoundsFor,
          }),
          participants,
        };
      },
    }),
  ];
}
