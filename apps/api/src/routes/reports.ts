import {
  DisposeReportInput,
  FileReportInput,
  ModeratorNoteInput,
  ReplyToReportInput,
  ReportId,
  type EvidenceSnapshot,
  type ModerationQueueRow,
  type ModeratorReportView,
  type Report,
  type ReporterReportView,
  type ReportNote,
  type ReportNoteId,
  type ReportSubject,
  type SubjectReportView,
  type UserId,
} from '@friendszone/contracts';
import {
  assertAllowed,
  assertNever,
  can,
  PolicyDeniedError,
  projectListing,
  projectReportForModerator,
  projectReportForReporter,
  projectReportForSubject,
  queueRow,
  type ViewerContext,
} from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../http/errors.js';
import { defineRoute, rawResponse, type RawResponse } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Reporting and moderation.
 *
 * Two things in this file carry the whole design, and both are easy to undo by
 * accident:
 *
 * 1. **Every context here is built against the caller** - `viewerFor(actorId)`,
 *    never `viewerFor(subjectUserId)`. A report is about a pair of people who
 *    have very often blocked each other, and a context built against the other
 *    party would come back `BLOCKED` and deny the victim access to their own
 *    case. The report decisions do not consult `relationship` at all.
 *
 * 2. **Which projection runs is decided by who is asking**, and the two party
 *    projections never see the other party's thread. See
 *    docs/adr/0018-reporting-and-moderation.md.
 */

const MAX_QUEUE = 100;

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

export function buildReportRoutes(repos: Repositories) {
  /**
   * Freeze the reported material, refusing if the reporter cannot see it.
   *
   * The visibility check is not a nicety: without it, `POST /v1/reports` is a
   * probe for whether an arbitrary id exists. Reporting something outside your
   * audience and reporting something imaginary produce the identical 404.
   *
   * Exhaustive over `ReportSubject`, so a new reportable surface cannot ship
   * without deciding what evidence it captures.
   */
  const captureEvidence = async (
    subject: ReportSubject,
    viewer: ViewerContext,
    viewerFor: (ownerId: UserId) => Promise<ViewerContext>,
    capturedAt: string,
  ): Promise<EvidenceSnapshot> => {
    const unseen = () => new PolicyDeniedError('report:create', 'NO_MATCHING_AUDIENCE');

    switch (subject.kind) {
      case 'LISTING': {
        const listing = await repos.listings.byId(subject.listingId);
        if (listing === null) throw unseen();

        // Projected as the *reporter* sees it: if this returns null they were
        // never entitled to the material, and a report would leak that it exists.
        const seen = projectListing({
          listing,
          viewer: await viewerFor(listing.ownerId),
          claims: [],
        });
        if (seen === null) throw unseen();

        return {
          capturedAt,
          authorId: listing.ownerId,
          fields: [
            { label: 'Title', value: seen.title },
            ...(seen.description === undefined
              ? []
              : [{ label: 'Description', value: seen.description }]),
            { label: 'Condition', value: seen.condition },
          ],
          photoKeys: [...seen.photoKeys],
        };
      }

      case 'HANGOUT': {
        const request = await repos.hangouts.byId(subject.hangoutId);
        if (request === null) throw unseen();

        // Parties only. A hangout is not projected for outsiders at all, so
        // participation is the visibility test.
        assertAllowed(
          can(viewer, {
            action: 'hangout:read',
            request: { proposerId: request.proposerId, inviteeIds: request.inviteeIds },
          }),
        );

        return {
          capturedAt,
          authorId: request.proposerId,
          fields: [
            { label: 'Title', value: request.title },
            ...(request.note === undefined ? [] : [{ label: 'Note', value: request.note }]),
          ],
          photoKeys: [],
        };
      }

      case 'USER': {
        /**
         * No material, by design.
         *
         * "This person is harassing me" is the case a blocked victim needs, and
         * a block means there is nothing of theirs left to capture. Requiring
         * evidence here would make the report impossible for exactly the person
         * who most needs to file it - so the moderator gets the reporter's
         * account and works from there.
         */
        const profile = await repos.directory.profile(subject.userId);
        if (profile === null) throw unseen();
        return { capturedAt, authorId: subject.userId, fields: [], photoKeys: [] };
      }

      default:
        return assertNever(subject, 'captureEvidence');
    }
  };

  const subjectUserOf = async (subject: ReportSubject): Promise<UserId | null> => {
    switch (subject.kind) {
      case 'LISTING':
        return (await repos.listings.byId(subject.listingId))?.ownerId ?? null;
      case 'HANGOUT':
        return (await repos.hangouts.byId(subject.hangoutId))?.proposerId ?? null;
      case 'USER':
        return subject.userId;
      default:
        return assertNever(subject, 'subjectUserOf');
    }
  };

  return [
    /** File a report. */
    defineRoute({
      method: 'POST',
      url: '/v1/reports',
      authz: { kind: 'POLICY', action: 'report:create' },
      rateLimit: 'WRITE',
      params: z.object({}),
      query: z.object({}),
      body: FileReportInput,
      handler: async (ctx): Promise<ReporterReportView> => {
        const actorId = requireActor(ctx.actorId, 'report:create');
        // Against the caller, never the subject - see the note at the top.
        const viewer = await ctx.viewerFor(actorId);

        const subjectUserId = await subjectUserOf(ctx.body.subject);
        if (subjectUserId === null) {
          throw new PolicyDeniedError('report:create', 'NO_MATCHING_AUDIENCE');
        }

        assertAllowed(can(viewer, { action: 'report:create', subjectUserId }));

        if ((await repos.reports.openCount(actorId, subjectUserId)) > 0) {
          // One live report per pair. Not silently deduplicated: the reporter
          // should know their existing case is still the live one.
          throw new PolicyDeniedError('report:create', 'WRONG_STATE');
        }

        const now = new Date().toISOString();
        const evidence = await captureEvidence(
          ctx.body.subject,
          viewer,
          ctx.viewerFor,
          now,
        );

        const report: Report = {
          id: randomUUID() as ReportId,
          reporterId: actorId, // ← from the session, never the body
          subject: ctx.body.subject,
          subjectUserId,
          reason: ctx.body.reason,
          status: 'OPEN',
          evidence,
          subjectNotified: false,
          createdAt: now,
          updatedAt: now,
          ...(ctx.body.detail === undefined ? {} : { detail: ctx.body.detail }),
        };

        const stored = await repos.reports.create(report);

        // Content-free pointer. The signature cannot carry anything else.
        await repos.notifier.reportFiled({
          reportId: stored.id,
          reason: stored.reason,
          subjectKind: stored.subject.kind,
        });

        return projectReportForReporter({ report: stored, notes: [] });
      },
    }),

    /** Reports you filed. Never reports about you. */
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/reports',
      authz: { kind: 'POLICY', action: 'report:read' },
      params: z.object({}),
      query: z.object({}),
      handler: async (ctx): Promise<{ reports: ReporterReportView[] }> => {
        const actorId = requireActor(ctx.actorId, 'report:read');
        const filed = await repos.reports.filedBy(actorId);

        return {
          reports: await Promise.all(
            filed.map(async (report) =>
              projectReportForReporter({
                report,
                notes: await repos.reports.notesFor(report.id),
              }),
            ),
          ),
        };
      },
    }),

    /**
     * Reports about you that a moderator has opened a thread on.
     *
     * Separate route from the one above, and separate projection, so that "my
     * reports" and "reports about me" can never be accidentally merged into one
     * list where a filter decides which projection ran.
     */
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/reports/about-me',
      authz: { kind: 'POLICY', action: 'report:read' },
      params: z.object({}),
      query: z.object({}),
      handler: async (ctx): Promise<{ reports: SubjectReportView[] }> => {
        const actorId = requireActor(ctx.actorId, 'report:read');
        const about = await repos.reports.notifiedTo(actorId);

        return {
          reports: await Promise.all(
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
     * Reply on your own thread.
     *
     * The thread is *derived* from who you are, never named in the body. A
     * request that could say which thread to write to is a request that could
     * be pointed at the other party's.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/reports/:id/reply',
      authz: { kind: 'POLICY', action: 'report:reply' },
      params: z.object({ id: ReportId }),
      query: z.object({}),
      body: ReplyToReportInput,
      handler: async (ctx): Promise<{ posted: true }> => {
        const actorId = requireActor(ctx.actorId, 'report:reply');
        const viewer = await ctx.viewerFor(actorId);

        const report = await repos.reports.byId(ctx.params.id);
        if (report === null) throw new PolicyDeniedError('report:reply', 'NOT_PARTICIPANT');

        assertAllowed(
          can(viewer, {
            action: 'report:reply',
            report: {
              reporterId: report.reporterId,
              subjectUserId: report.subjectUserId,
              status: report.status,
              subjectNotified: report.subjectNotified,
            },
          }),
        );

        await repos.reports.addNote({
          id: randomUUID() as ReportNoteId,
          reportId: report.id,
          audience: actorId === report.reporterId ? 'REPORTER' : 'SUBJECT',
          authorId: actorId,
          body: ctx.body.body,
          createdAt: new Date().toISOString(),
        });

        // Deliberately not the updated report: a reply is an append, and
        // returning the case would re-derive a projection for no reason.
        return { posted: true };
      },
    }),

    // ── Moderation ───────────────────────────────────────────────────
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/moderation/reports',
      authz: { kind: 'POLICY', action: 'moderation:review' },
      params: z.object({}),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(MAX_QUEUE).default(50),
      }),
      handler: async (ctx): Promise<{ reports: ModerationQueueRow[] }> => {
        const actorId = requireActor(ctx.actorId, 'moderation:review');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'moderation:review' }));

        const reports = await repos.reports.queue(ctx.query.limit);
        return {
          reports: await Promise.all(
            reports.map(async (report) =>
              queueRow(report, (await repos.reports.notesFor(report.id)).length),
            ),
          ),
        };
      },
    }),

    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/moderation/reports/:id',
      authz: { kind: 'POLICY', action: 'moderation:review' },
      params: z.object({ id: ReportId }),
      query: z.object({}),
      handler: async (ctx): Promise<ModeratorReportView> => {
        const actorId = requireActor(ctx.actorId, 'moderation:review');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'moderation:review' }));

        const report = await repos.reports.byId(ctx.params.id);
        // A non-moderator never reaches here, so a plain 404 for a bad id is
        // safe - the existence of a report is not secret from a moderator.
        if (report === null) throw new PolicyDeniedError('moderation:review', 'NOT_PARTICIPANT');

        return projectReportForModerator({
          report,
          notes: await repos.reports.notesFor(report.id),
        });
      },
    }),

    /**
     * Write into one thread.
     *
     * Writing to the `SUBJECT` thread is what first tells a reported person
     * anything at all - it flips `subjectNotified`. Until a moderator does this
     * deliberately, the subject cannot see the report, cannot reply, and cannot
     * confirm it exists.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/moderation/reports/:id/notes',
      authz: { kind: 'POLICY', action: 'moderation:correspond' },
      params: z.object({ id: ReportId }),
      query: z.object({}),
      body: ModeratorNoteInput,
      handler: async (ctx): Promise<ModeratorReportView> => {
        const actorId = requireActor(ctx.actorId, 'moderation:correspond');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'moderation:correspond' }));

        const report = await repos.reports.byId(ctx.params.id);
        if (report === null) {
          throw new PolicyDeniedError('moderation:correspond', 'NOT_PARTICIPANT');
        }

        const now = new Date().toISOString();
        await repos.reports.addNote({
          id: randomUUID() as ReportNoteId,
          reportId: report.id,
          audience: ctx.body.audience,
          // `null`, never the moderator's id. A party learns that a moderator
          // replied, never which one - stored that way so no future projection
          // can ship an identity that was never recorded.
          authorId: null,
          body: ctx.body.body,
          createdAt: now,
        });

        const stored = await repos.reports.save({
          ...report,
          status: report.status === 'OPEN' ? 'AWAITING_INFO' : report.status,
          subjectNotified: report.subjectNotified || ctx.body.audience === 'SUBJECT',
          updatedAt: now,
        });

        return projectReportForModerator({
          report: stored,
          notes: await repos.reports.notesFor(stored.id),
        });
      },
    }),

    /** Uphold or dismiss, optionally taking the listing down. */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/moderation/reports/:id/dispose',
      authz: { kind: 'POLICY', action: 'moderation:dispose' },
      params: z.object({ id: ReportId }),
      query: z.object({}),
      body: DisposeReportInput,
      handler: async (ctx): Promise<ModeratorReportView> => {
        const actorId = requireActor(ctx.actorId, 'moderation:dispose');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'moderation:dispose' }));

        const report = await repos.reports.byId(ctx.params.id);
        if (report === null) throw new PolicyDeniedError('moderation:dispose', 'NOT_PARTICIPANT');
        if (report.status === 'UPHELD' || report.status === 'DISMISSED') {
          throw new PolicyDeniedError('moderation:dispose', 'WRONG_STATE');
        }

        if (ctx.body.takeDown) {
          // Refused rather than ignored: a moderator who ticked "take down" and
          // got a silent no-op would believe content was gone when it is not.
          if (ctx.body.status !== 'UPHELD' || report.subject.kind !== 'LISTING') {
            throw new ValidationError(['takeDown']);
          }
        }

        const now = new Date().toISOString();

        if (ctx.body.takeDown && report.subject.kind === 'LISTING') {
          const listing = await repos.listings.byId(report.subject.listingId);
          if (listing !== null) {
            await repos.listings.save({ ...listing, status: 'WITHDRAWN', updatedAt: now });
            for (const claim of await repos.listings.claimsFor(listing.id)) {
              if (claim.status !== 'PENDING') continue;
              await repos.listings.saveClaim({ ...claim, status: 'CANCELLED', updatedAt: now });
            }
          }
        }

        const stored = await repos.reports.save({
          ...report,
          status: ctx.body.status,
          updatedAt: now,
          ...(ctx.body.resolutionNote === undefined
            ? {}
            : { resolutionNote: ctx.body.resolutionNote }),
        });

        return projectReportForModerator({
          report: stored,
          notes: await repos.reports.notesFor(stored.id),
        });
      },
    }),

    /**
     * An evidence photo, served through its report.
     *
     * This is the one place a moderator reads user-supplied bytes, and the key
     * must be in *this report's* snapshot. Without that check the moderation
     * role would be a read-anything capability over the whole photo store -
     * which is precisely the master key ADR 0018 refuses to grant.
     */
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/moderation/reports/:id/photos/:key',
      authz: { kind: 'POLICY', action: 'moderation:review' },
      params: z.object({ id: ReportId, key: z.string().uuid() }),
      query: z.object({}),
      handler: async (ctx): Promise<RawResponse> => {
        const actorId = requireActor(ctx.actorId, 'moderation:review');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'moderation:review' }));

        const report = await repos.reports.byId(ctx.params.id);
        if (report === null) throw new PolicyDeniedError('moderation:review', 'NOT_PARTICIPANT');

        if (!report.evidence.photoKeys.includes(ctx.params.key)) {
          throw new PolicyDeniedError('moderation:review', 'NOT_PARTICIPANT');
        }

        const photo = await repos.photos.get(ctx.params.key);
        if (photo === null) throw new PolicyDeniedError('moderation:review', 'NOT_PARTICIPANT');

        return rawResponse(photo.contentType, photo.bytes);
      },
    }),
  ];
}
