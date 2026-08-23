import { z } from 'zod';
import {
  HangoutRequestId,
  Instant,
  ListingId,
  LongText,
  ReportId,
  ReportNoteId,
  ShortText,
  UserId,
} from './primitives.js';

/**
 * Reporting and moderation.
 *
 * The shape to understand before reading the rest: a `Report` is the record, an
 * `EvidenceSnapshot` freezes what was reported at the moment it was reported,
 * and `ReportNote`s form **two independent threads** - one between the moderator
 * and the reporter, one between the moderator and the subject. The two parties
 * never share an object, which is what makes "follow up without revealing the
 * accuser" a property of the data rather than a rule someone has to remember.
 *
 * See docs/adr/0018-reporting-and-moderation.md.
 */

export const ReportReason = z.enum([
  'HARASSMENT',
  'HATE_SPEECH',
  'SEXUAL_CONTENT',
  'VIOLENCE_OR_THREATS',
  'SCAM_OR_FRAUD',
  'PROHIBITED_ITEM',
  'SPAM',
  'IMPERSONATION',
  'SELF_HARM',
  'OTHER',
]);
export type ReportReason = z.infer<typeof ReportReason>;

export const ReportStatus = z.enum([
  /** Filed, nobody has looked yet. */
  'OPEN',
  /** A moderator has asked someone a question and is waiting. */
  'AWAITING_INFO',
  /** Upheld. Something was actually wrong. */
  'UPHELD',
  /** Looked at, no violation found. */
  'DISMISSED',
]);
export type ReportStatus = z.infer<typeof ReportStatus>;

/**
 * What is being reported.
 *
 * A discriminated union rather than a loose `targetType`/`targetId` pair, so
 * that evidence capture switches exhaustively and a new reportable surface
 * breaks the build instead of silently arriving with no snapshot.
 */
export const ReportSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LISTING'), listingId: ListingId }),
  z.object({ kind: z.literal('HANGOUT'), hangoutId: HangoutRequestId }),
  /** The person, not one thing they made. For a pattern rather than an item. */
  z.object({ kind: z.literal('USER'), userId: UserId }),
]);
export type ReportSubject = z.infer<typeof ReportSubject>;

/**
 * The reported material, frozen at report time.
 *
 * Deliberately a flat list of labelled strings rather than a copy of each
 * entity's schema. A snapshot that mirrored `Listing` would need updating every
 * time `Listing` changed, and would drift; a moderator needs to *read* what was
 * said, not to reconstruct the object.
 *
 * This is also the boundary of moderator access: there is no moderator exemption
 * anywhere in the visibility engine, so a moderator sees exactly this and
 * nothing around it.
 */
export const EvidenceSnapshot = z.object({
  capturedAt: Instant,
  /** Who authored or owns the reported material. */
  authorId: UserId,
  fields: z
    .array(z.object({ label: ShortText, value: LongText }))
    .max(20),
  /** Served only through the report, never by key alone. */
  photoKeys: z.array(z.string().uuid()).max(8),
});
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshot>;

/**
 * Which one-way thread a note belongs to.
 *
 * Every note carries this, and no note is visible to both parties. There is no
 * `BOTH` member and adding one would collapse the entire guarantee.
 */
export const NoteAudience = z.enum(['REPORTER', 'SUBJECT']);
export type NoteAudience = z.infer<typeof NoteAudience>;

export const ReportNote = z.object({
  id: ReportNoteId,
  reportId: ReportId,
  /** The thread this belongs to. Never both. */
  audience: NoteAudience,
  /**
   * `null` when a moderator wrote it.
   *
   * Deliberately not the moderator's `UserId`: a party has no business learning
   * which individual is handling their report, and an id that is present in the
   * stored row is an id that a future careless projection can ship.
   */
  authorId: UserId.nullable(),
  body: LongText,
  createdAt: Instant,
});
export type ReportNote = z.infer<typeof ReportNote>;

export const Report = z.object({
  id: ReportId,
  /** Who filed it. Never projected to the subject, at any status. */
  reporterId: UserId,
  subject: ReportSubject,
  /**
   * The person the report is about, resolved at file time.
   *
   * Stored rather than derived so the queue can be grouped and rate-limited
   * without re-reading whatever was reported - which may since have been
   * deleted.
   */
  subjectUserId: UserId,
  reason: ReportReason,
  detail: LongText.optional(),
  status: ReportStatus,
  evidence: EvidenceSnapshot,
  /** Set when a moderator upholds or dismisses. Their words, for the record. */
  resolutionNote: LongText.optional(),
  /** Whether the subject has been contacted. Until then they know nothing. */
  subjectNotified: z.boolean(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Report = z.infer<typeof Report>;

// ── Wire types ────────────────────────────────────────────────────────

export const FileReportInput = z.object({
  subject: ReportSubject,
  reason: ReportReason,
  detail: LongText.optional(),
});
export type FileReportInput = z.infer<typeof FileReportInput>;

/** A party adding to their own thread. The thread is inferred, never named. */
export const ReplyToReportInput = z.object({ body: LongText.min(1) });
export type ReplyToReportInput = z.infer<typeof ReplyToReportInput>;

/** A moderator writing into one specific thread. */
export const ModeratorNoteInput = z.object({
  audience: NoteAudience,
  body: LongText.min(1),
});
export type ModeratorNoteInput = z.infer<typeof ModeratorNoteInput>;

export const DisposeReportInput = z.object({
  status: z.enum(['UPHELD', 'DISMISSED']),
  resolutionNote: LongText.optional(),
  /**
   * Unpublish the reported listing. Only meaningful for a `LISTING` subject and
   * only alongside `UPHELD`; the route refuses other combinations rather than
   * quietly ignoring the flag.
   */
  takeDown: z.boolean().default(false),
});
export type DisposeReportInput = z.infer<typeof DisposeReportInput>;

export const NoteView = z.object({
  id: ReportNoteId,
  /** True when a moderator wrote it. No moderator identity is ever exposed. */
  fromModerator: z.boolean(),
  body: LongText,
  createdAt: Instant,
});
export type NoteView = z.infer<typeof NoteView>;

/**
 * A report as the person who filed it sees it.
 *
 * Carries no evidence snapshot: the reporter already saw the material - they
 * reported it - and echoing a frozen copy back would hand them a durable record
 * of content the author may since have deleted.
 */
export const ReporterReportView = z.object({
  id: ReportId,
  reason: ReportReason,
  detail: LongText.optional(),
  status: ReportStatus,
  subjectKind: z.enum(['LISTING', 'HANGOUT', 'USER']),
  createdAt: Instant,
  /** The reporter's own thread. Never the subject's. */
  notes: z.array(NoteView),
});
export type ReporterReportView = z.infer<typeof ReporterReportView>;

/**
 * A report as the person it is *about* sees it - and only once a moderator has
 * deliberately opened a thread with them.
 *
 * No `reporterId`, no `detail` (the reporter's own words, which are often
 * identifying), no timestamps from the filing, and no evidence. The reason
 * category and the moderator's message are the whole payload.
 */
export const SubjectReportView = z.object({
  id: ReportId,
  reason: ReportReason,
  status: ReportStatus,
  subjectKind: z.enum(['LISTING', 'HANGOUT', 'USER']),
  /** The subject's own thread. Never the reporter's. */
  notes: z.array(NoteView),
});
export type SubjectReportView = z.infer<typeof SubjectReportView>;

/** The queue row. Enough to triage, not enough to read the case from a list. */
export const ModerationQueueRow = z.object({
  id: ReportId,
  reason: ReportReason,
  status: ReportStatus,
  subjectKind: z.enum(['LISTING', 'HANGOUT', 'USER']),
  createdAt: Instant,
  noteCount: z.number().int().min(0),
});
export type ModerationQueueRow = z.infer<typeof ModerationQueueRow>;

/** The full case file. Moderators only. */
export const ModeratorReportView = z.object({
  id: ReportId,
  reporterId: UserId,
  subjectUserId: UserId,
  subject: ReportSubject,
  reason: ReportReason,
  detail: LongText.optional(),
  status: ReportStatus,
  evidence: EvidenceSnapshot,
  resolutionNote: LongText.optional(),
  subjectNotified: z.boolean(),
  createdAt: Instant,
  updatedAt: Instant,
  /** Both threads, kept apart so the UI cannot merge them by accident. */
  reporterNotes: z.array(NoteView),
  subjectNotes: z.array(NoteView),
});
export type ModeratorReportView = z.infer<typeof ModeratorReportView>;
