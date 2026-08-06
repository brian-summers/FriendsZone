import { useState } from 'react';
import type { ReportReason, ReportSubject } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * File a report.
 *
 * The copy matters as much as the fields. Someone opening this is often upset,
 * and the two things they most need to know are that the person will not be
 * told who reported them, and that nothing happens to anyone automatically.
 * Both are true (docs/adr/0018-reporting-and-moderation.md), so both are said
 * plainly rather than buried in a privacy policy.
 */

const REASONS: Array<[ReportReason, string]> = [
  ['HARASSMENT', 'Harassment or bullying'],
  ['HATE_SPEECH', 'Hate speech'],
  ['VIOLENCE_OR_THREATS', 'Violence or threats'],
  ['SEXUAL_CONTENT', 'Sexual content'],
  ['SCAM_OR_FRAUD', 'Scam or fraud'],
  ['PROHIBITED_ITEM', 'Something that shouldn’t be offered'],
  ['IMPERSONATION', 'Impersonation'],
  ['SELF_HARM', 'Someone may be at risk'],
  ['SPAM', 'Spam'],
  ['OTHER', 'Something else'],
];

interface Props {
  subject: ReportSubject;
  /** What is being reported, for the heading. Never sent to the server. */
  label: string;
  actorId: string;
  onClose: () => void;
}

export function ReportDialog({ subject, label, actorId, onClose }: Props) {
  const [reason, setReason] = useState<ReportReason>('HARASSMENT');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setState('sending');
    setError(null);
    try {
      await api.fileReport(
        { subject, reason, ...(detail.trim() === '' ? {} : { detail: detail.trim() }) },
        actorId,
      );
      setState('sent');
    } catch (err: unknown) {
      setState('editing');
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'You already have an open report about this person. We’re still looking at it.'
            : err.status === 404
              ? 'That’s no longer available to report.'
              : `That didn’t send (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog report-dialog" role="dialog" aria-label="Report">
        {state === 'sent' ? (
          <>
            <h3>Thank you — that’s with us</h3>
            <p className="report-reassure">
              Someone will read it. <strong>{label}</strong> will not be told who reported them,
              and nothing has been removed automatically.
            </p>
            <p className="side-note">
              If we need anything else we’ll ask you here, under Reports in Settings.
            </p>
            <div className="thing-buttons">
              <button type="button" className="accent" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Report {label}</h3>
            <p className="report-reassure">
              They won’t be told who reported them. Nothing is removed automatically — a person
              reads every report.
            </p>

            <label className="field">
              <span>What’s wrong?</span>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as ReportReason)}
              >
                {REASONS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Anything you’d like to add?</span>
              <textarea
                rows={4}
                maxLength={4000}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder="Optional. What happened, and when."
              />
              <small className="side-note">
                Only moderators see this — never the person you’re reporting.
              </small>
            </label>

            {error !== null && (
              <p className="things-error" role="status">
                {error}
              </p>
            )}

            <div className="thing-buttons">
              <button
                type="button"
                className="accent"
                disabled={state === 'sending'}
                onClick={() => void submit()}
              >
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
