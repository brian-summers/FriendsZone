import { describe, expect, it } from 'vitest';
import type { Report, ReportId, ReportNote, ReportNoteId } from '@friendszone/contracts';
import { can } from './actions.js';
import {
  projectReportForModerator,
  projectReportForReporter,
  projectReportForSubject,
} from './projection.js';
import {
  ALICE,
  asAnonymous,
  asFriend,
  asModerator,
  asOwner,
  BOB,
  CAROL,
  viewer,
} from './testing.js';

/**
 * BOB reports ALICE. CAROL is the moderator.
 *
 * The question every test here asks is the same one: can either party learn
 * anything about the other that they did not already know?
 */
const report = (overrides: Partial<Report> = {}): Report => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001' as ReportId,
  reporterId: BOB,
  subject: { kind: 'USER', userId: ALICE },
  subjectUserId: ALICE,
  reason: 'HARASSMENT',
  detail: 'He keeps messaging me about the bike after I asked him to stop.',
  status: 'OPEN',
  evidence: {
    capturedAt: '2026-03-02T00:00:00.000Z',
    authorId: ALICE,
    fields: [{ label: 'Title', value: 'Free bike, message me' }],
    photoKeys: [],
  },
  subjectNotified: false,
  createdAt: '2026-03-02T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
  ...overrides,
});

let noteCounter = 0;
const note = (overrides: Partial<ReportNote> = {}): ReportNote => {
  noteCounter += 1;
  return {
    id: `bbbbbbbb-0000-4000-8000-${String(noteCounter).padStart(12, '0')}` as ReportNoteId,
    reportId: 'aaaaaaaa-0000-4000-8000-000000000001' as ReportId,
    audience: 'REPORTER',
    authorId: BOB,
    body: 'Here is a screenshot.',
    createdAt: '2026-03-03T00:00:00.000Z',
    ...overrides,
  };
};

const asReporter = () => viewer({ viewerId: BOB, relationship: 'SELF' });
const asSubject = () => viewer({ viewerId: ALICE, relationship: 'SELF' });

describe('who may touch a report', () => {
  it('lets any authenticated user file one', () => {
    expect(can(asFriend(), { action: 'report:create', subjectUserId: ALICE }).allowed).toBe(true);
  });

  it('refuses an anonymous report', () => {
    expect(can(asAnonymous(), { action: 'report:create', subjectUserId: ALICE })).toMatchObject({
      allowed: false,
      reason: 'ANONYMOUS',
    });
  });

  it('refuses a report about yourself', () => {
    expect(can(asOwner(), { action: 'report:create', subjectUserId: ALICE })).toMatchObject({
      allowed: false,
      reason: 'NOT_PARTICIPANT',
    });
  });

  it('lets a blocked reporter still file', () => {
    // The safety case: an abuser must not be able to block their way out of
    // being reported. `relationship` is deliberately not consulted.
    expect(
      can(viewer({ viewerId: BOB, relationship: 'BLOCKED' }), {
        action: 'report:create',
        subjectUserId: ALICE,
      }).allowed,
    ).toBe(true);
  });

  it('lets the reporter read their own report', () => {
    expect(can(asReporter(), { action: 'report:read', report: report() }).allowed).toBe(true);
  });

  it('hides a report from its subject until a moderator makes contact', () => {
    // "You have been reported", arriving promptly, identifies the reporter about
    // as well as naming them would.
    expect(can(asSubject(), { action: 'report:read', report: report() })).toMatchObject({
      allowed: false,
      reason: 'NOT_PARTICIPANT',
    });
    expect(
      can(asSubject(), { action: 'report:read', report: report({ subjectNotified: true }) })
        .allowed,
    ).toBe(true);
  });

  it('refuses an uninvolved third party, moderator status aside', () => {
    expect(
      can(viewer({ viewerId: CAROL }), { action: 'report:read', report: report() }),
    ).toMatchObject({ allowed: false, reason: 'NOT_PARTICIPANT' });
  });

  it('stops replies once the case is closed', () => {
    for (const status of ['UPHELD', 'DISMISSED'] as const) {
      expect(
        can(asReporter(), { action: 'report:reply', report: report({ status }) }),
      ).toMatchObject({ allowed: false, reason: 'WRONG_STATE' });
    }
    expect(
      can(asReporter(), { action: 'report:reply', report: report({ status: 'AWAITING_INFO' }) })
        .allowed,
    ).toBe(true);
  });

  it('gates the queue on the allowlist and nothing else', () => {
    for (const action of [
      'moderation:review',
      'moderation:correspond',
      'moderation:dispose',
    ] as const) {
      expect(can(asModerator(), { action }).allowed).toBe(true);
      // A friend of everyone, an owner, and a stranger are all equally refused:
      // moderation is not a social standing.
      expect(can(asFriend(), { action })).toMatchObject({
        allowed: false,
        reason: 'NOT_PARTICIPANT',
      });
      expect(can(asOwner(), { action })).toMatchObject({
        allowed: false,
        reason: 'NOT_PARTICIPANT',
      });
      expect(can(asAnonymous(), { action })).toMatchObject({
        allowed: false,
        reason: 'ANONYMOUS',
      });
    }
  });
});

describe('the two threads never cross', () => {
  const notes = [
    note({ audience: 'REPORTER', authorId: BOB, body: 'He messaged me again today.' }),
    note({ audience: 'REPORTER', authorId: null, body: 'Thanks, can you send dates?' }),
    note({ audience: 'SUBJECT', authorId: null, body: 'Please review our conduct guidance.' }),
    note({ audience: 'SUBJECT', authorId: ALICE, body: 'I did not know it was unwelcome.' }),
  ];

  it('shows the reporter only their own thread', () => {
    const view = projectReportForReporter({ report: report(), notes });
    expect(view.notes).toHaveLength(2);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('conduct guidance');
    expect(serialised).not.toContain('I did not know');
  });

  it('shows the subject only their own thread', () => {
    const view = projectReportForSubject({ report: report({ subjectNotified: true }), notes });
    expect(view.notes).toHaveLength(2);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('messaged me again');
    expect(serialised).not.toContain('send dates');
  });

  it('never tells the subject who reported them', () => {
    const view = projectReportForSubject({ report: report({ subjectNotified: true }), notes });
    const serialised = JSON.stringify(view);
    // The whole point of the feature, asserted on the serialised body.
    expect(serialised).not.toContain(BOB);
    expect(view).not.toHaveProperty('reporterId');
  });

  it('never passes the reporter’s own words to the subject', () => {
    // `detail` is where people identify themselves without meaning to.
    const view = projectReportForSubject({ report: report({ subjectNotified: true }), notes });
    expect(view).not.toHaveProperty('detail');
    expect(JSON.stringify(view)).not.toContain('after I asked him to stop');
  });

  it('withholds filing time from the subject', () => {
    // A timestamp correlates with whoever they last argued with.
    const view = projectReportForSubject({ report: report({ subjectNotified: true }), notes });
    expect(view).not.toHaveProperty('createdAt');
  });

  it('does not re-serve the subject their own captured material', () => {
    const view = projectReportForSubject({ report: report({ subjectNotified: true }), notes });
    expect(view).not.toHaveProperty('evidence');
    expect(JSON.stringify(view)).not.toContain('Free bike');
  });

  it('gives the reporter no evidence snapshot either', () => {
    // They saw it - they reported it. A frozen copy would be a durable record
    // of content the author may since have deleted.
    const view = projectReportForReporter({ report: report(), notes });
    expect(view).not.toHaveProperty('evidence');
  });

  it('never names which moderator replied, to either party', () => {
    const forReporter = projectReportForReporter({ report: report(), notes });
    const forSubject = projectReportForSubject({ report: report({ subjectNotified: true }), notes });

    expect(forReporter.notes.some((n) => n.fromModerator)).toBe(true);
    expect(forSubject.notes.some((n) => n.fromModerator)).toBe(true);
    // `fromModerator` is a boolean and there is no id anywhere near it.
    expect(JSON.stringify([forReporter, forSubject])).not.toContain(CAROL);
  });

  it('gives the moderator both threads, kept apart', () => {
    const view = projectReportForModerator({ report: report(), notes });
    expect(view.reporterNotes).toHaveLength(2);
    expect(view.subjectNotes).toHaveLength(2);
    // Two arrays, not one merged list: a single array is one careless `.map()`
    // in a client away from showing a subject the reporter's words.
    expect(view).not.toHaveProperty('notes');
    expect(view.reporterId).toBe(BOB);
    expect(view.evidence.fields[0]?.value).toBe('Free bike, message me');
  });
});
