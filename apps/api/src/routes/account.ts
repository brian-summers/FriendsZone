import {
  DeleteAccountInput,
  type AccountExport,
  type DeletionReceipt,
  type EventView,
  type ExchangeView,
  type ListingView,
  type OwnClaimView,
  type UserId,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  PolicyDeniedError,
  projectCalendar,
  projectExchange,
  projectListing,
  projectReportForReporter,
  projectReportForSubject,
} from '@friendszone/policy';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Getting your data out, and making it stop existing.
 *
 * The rule that governs this whole file: **an export is a projection, not a
 * dump.** Every section below is built with the same projection functions the
 * API already uses, which is what makes this true structurally rather than by
 * review:
 *
 * > An export can never contain more than the user could already read.
 *
 * The case that matters most is `reportsAboutYou`, which runs through
 * `projectReportForSubject` and therefore carries no reporter identity.
 * Exporting the stored `Report` row would hand a reported person the identity
 * of whoever reported them, in a downloadable file, as a privacy feature. See
 * docs/adr/0022-export-and-deletion.md.
 */

/** How much calendar an export reaches back and forward. */
const EXPORT_WINDOW_DAYS = 365;

const README = [
  'This is a copy of your Friendszone data, as you can see it.',
  '',
  'What is here: your profile, your sharing defaults, your events, things you',
  'offered or claimed, handoffs you arranged, your notifications, and reports',
  'you filed or that a moderator raised with you.',
  '',
  'What is deliberately not here:',
  '  - Who reported you. A report about you never carries the reporter, in this',
  '    file or anywhere else.',
  '  - Other people’s calendars, messages, or claims, including on things you',
  '    offered - you see what you always saw, and no more.',
  '  - Anything a friend shares with you. That is theirs to export, not yours.',
].join('\n');

export function buildAccountRoutes(repos: Repositories) {
  return [
    /**
     * Download everything about you that you are entitled to.
     *
     * `EXPENSIVE`: this is the widest fan-out in the product - every port,
     * every projection, a year of calendar.
     */
    defineRoute({
      method: 'GET',
      url: '/v1/me/export',
      authz: { kind: 'POLICY', action: 'account:export' },
      rateLimit: 'EXPENSIVE',
      params: z.object({}),
      query: z.object({}),
      handler: async (ctx): Promise<AccountExport> => {
        const actorId = ctx.actorId;
        if (actorId === null) throw new PolicyDeniedError('account:export', 'ANONYMOUS');
        const self = await ctx.viewerFor(actorId);
        assertAllowed(can(self, { action: 'account:export' }));

        const profile = await repos.directory.profile(actorId);
        if (profile === null) throw new PolicyDeniedError('account:export', 'NOT_OWNER');

        const now = new Date();
        const from = new Date(now);
        from.setDate(from.getDate() - EXPORT_WINDOW_DAYS);
        const to = new Date(now);
        to.setDate(to.getDate() + EXPORT_WINDOW_DAYS);
        const window = { start: from.toISOString(), end: to.toISOString() };

        const [events, sharingDefaults, notifications] = await Promise.all([
          repos.calendar.eventsInWindow(actorId, window),
          repos.calendar.sharingDefaults(actorId),
          repos.notifications.forUser(actorId),
        ]);

        // Your own calendar, projected for yourself - which resolves to FULL,
        // so this is the complete view rather than a redacted one.
        const own = projectCalendar({
          ownerId: actorId,
          events,
          viewer: self,
          ownerDefaults: sharingDefaults,
          window,
        });

        // ── Things ────────────────────────────────────────────────
        const listings: ListingView[] = [];
        const claims: OwnClaimView[] = [];
        const handoffs: ExchangeView[] = [];

        for (const listing of await repos.listings.recent(500)) {
          const viewer = await ctx.viewerFor(listing.ownerId);
          const listingClaims = await repos.listings.claimsFor(listing.id);

          const exchanges = new Map<string, ExchangeView>();
          for (const claim of listingClaims) {
            const exchange = await repos.exchanges.forClaim(claim.id);
            if (exchange === null) continue;
            const view = projectExchange({ exchange, viewer, listing, claim });
            if (view !== null) {
              exchanges.set(claim.id, view);
              // A handoff you are party to, wherever it hangs.
              if (claim.claimantId === actorId || listing.ownerId === actorId) {
                handoffs.push(view);
              }
            }
          }

          const view = projectListing({ listing, viewer, claims: listingClaims, exchanges });
          if (view === null) continue;

          if (view.isOwner) listings.push(view);
          // A claim you made on someone else's listing is yours to keep.
          else if (view.yourClaim !== undefined) claims.push(view.yourClaim);
        }

        // ── Reports ───────────────────────────────────────────────
        const filed = await repos.reports.filedBy(actorId);
        const about = await repos.reports.notifiedTo(actorId);

        return {
          exportedAt: now.toISOString(),
          readme: README,
          profile,
          sharingDefaults,
          events,
          listings,
          claims,
          handoffs,
          // Hangout-origin events as the calendar shows them to you.
          hangoutEvents: own.details.filter(
            (e: EventView) => 'originHangoutRequestId' in e,
          ),
          notifications,
          reportsYouFiled: await Promise.all(
            filed.map(async (report) =>
              projectReportForReporter({
                report,
                notes: await repos.reports.notesFor(report.id),
              }),
            ),
          ),
          // ← The load-bearing line. `projectReportForSubject` carries no
          // `reporterId`, no `detail`, and no filing time.
          reportsAboutYou: await Promise.all(
            about.map(async (report) =>
              projectReportForSubject({
                report,
                notes: await repos.reports.notesFor(report.id),
              }),
            ),
          ),
        };
      },
    }),

    /**
     * Delete your account. Immediate, irreversible, confirmed by typing.
     *
     * A `POST` with the handle in the body rather than `DELETE /v1/me`, which
     * is one mis-scoped fetch away from firing.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/me/delete',
      authz: { kind: 'POLICY', action: 'account:delete' },
      rateLimit: 'WRITE',
      params: z.object({}),
      query: z.object({}),
      body: DeleteAccountInput,
      handler: async (ctx): Promise<DeletionReceipt> => {
        const actorId: UserId | null = ctx.actorId;
        if (actorId === null) throw new PolicyDeniedError('account:delete', 'ANONYMOUS');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'account:delete' }));

        const profile = await repos.directory.profile(actorId);
        if (profile === null) throw new PolicyDeniedError('account:delete', 'NOT_OWNER');

        // Typing your own handle. Not a checkbox: this cannot be undone.
        if (ctx.body.confirmHandle !== profile.handle) {
          throw new PolicyDeniedError('account:delete', 'WRONG_STATE');
        }

        /**
         * Order matters.
         *
         * Listings before photos (the listing sweep is what reports which keys
         * to drop), claims before exchanges, and the **tombstone last** - every
         * sweep above resolves ids, and a profile emptied first would make
         * their work harder to reason about.
         */
        const { photoKeys } = await repos.listings.eraseUser(actorId);
        for (const key of photoKeys) await repos.photos.remove(key);

        await repos.exchanges.eraseUser(actorId);
        await repos.hangouts.eraseUser(actorId);
        await repos.calendar.eraseUser(actorId);
        await repos.notifications.eraseUser(actorId);
        await repos.reports.eraseUser(actorId);
        await repos.social.eraseUser(actorId);
        // Credentials and sessions last but before the tombstone: a deleted
        // account must not be able to log back in, and any live session must
        // stop working immediately rather than at expiry.
        await repos.credentials.eraseUser(actorId);
        await repos.sessions.revokeAllFor(actorId);
        await repos.directory.tombstone(actorId);

        /**
         * Said plainly, and true. Glossing this would make "your account has
         * been deleted" a claim we do not keep.
         */
        return {
          deletedAt: new Date().toISOString(),
          retained: [
            'Blocks involving you, so that deleting and rejoining cannot reach someone who blocked you.',
            'Open moderation cases about you, and their evidence, until they are closed.',
            'Reports you filed, which protect someone else. Your identity on them is already erased.',
            'Other people’s copies of plans you shared - their record of their own week, not yours to delete.',
          ],
        };
      },
    }),
  ];
}
