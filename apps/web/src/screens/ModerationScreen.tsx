import { useEffect, useState } from 'react';
import type {
  ModerationQueueRow,
  ModeratorReportView,
  NoteAudience,
  ReportStatus,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * The moderation queue.
 *
 * One rule governs the whole layout: **the two threads are never shown as one
 * conversation.** They arrive as two arrays and they are rendered as two
 * columns, because a merged, time-sorted view is how a moderator ends up
 * quoting the reporter into a message meant for the subject.
 *
 * Everything here is the server's projection. The client re-derives nothing.
 */

const REASON_LABEL: Record<string, string> = {
  HARASSMENT: 'Harassment',
  HATE_SPEECH: 'Hate speech',
  SEXUAL_CONTENT: 'Sexual content',
  VIOLENCE_OR_THREATS: 'Violence or threats',
  SCAM_OR_FRAUD: 'Scam or fraud',
  PROHIBITED_ITEM: 'Prohibited item',
  SPAM: 'Spam',
  IMPERSONATION: 'Impersonation',
  SELF_HARM: 'Risk of self-harm',
  OTHER: 'Other',
};

const when = (instant: string): string =>
  new Date(instant).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const isClosed = (status: ReportStatus): boolean =>
  status === 'UPHELD' || status === 'DISMISSED';

export function ModerationScreen({ actorId }: { actorId: string }) {
  const [queue, setQueue] = useState<ModerationQueueRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModeratorReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .moderationQueue(actorId, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setQueue(r.reports);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This account is not a moderator.'
            : 'Could not load the queue.',
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [actorId, nonce]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    api
      .moderationReport(selectedId, actorId, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setDetail(r);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not load that report.');
      });
    return () => controller.abort();
  }, [selectedId, actorId, nonce]);

  async function act(fn: () => Promise<ModeratorReportView>) {
    try {
      setDetail(await fn());
      reload();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'That report is already settled.'
            : err.status === 400
              ? 'A takedown only applies when upholding a report about a listing.'
              : `That didn’t work (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <div className="moderation">
      <div className="mod-head">
        <div>
          <h2>Moderation</h2>
          <p className="things-blurb">
            Reports, the material they were filed about, and two separate threads — one with the
            reporter, one with the person reported. Neither can see the other.
          </p>
        </div>
      </div>

      {error !== null && (
        <p className="things-error" role="status">
          {error}
        </p>
      )}

      {loading && <p className="side-note">Loading…</p>}

      {!loading && queue.length === 0 && error === null && (
        <p className="things-empty">Nothing in the queue.</p>
      )}

      <div className="mod-layout">
        {queue.length > 0 && (
          <ul className="mod-queue">
            {queue.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`mod-row${selectedId === row.id ? ' mod-row-on' : ''}`}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className="mod-row-top">
                    <span className="mod-reason">{REASON_LABEL[row.reason] ?? row.reason}</span>
                    <span className={`mod-status mod-${row.status.toLowerCase()}`}>
                      {row.status.replace('_', ' ').toLowerCase()}
                    </span>
                  </span>
                  <span className="mod-row-sub">
                    {row.subjectKind.toLowerCase()} · {when(row.createdAt)}
                    {row.noteCount > 0 && ` · ${row.noteCount} message${row.noteCount === 1 ? '' : 's'}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {detail !== null && (
          <CaseFile report={detail} actorId={actorId} onAct={act} />
        )}
      </div>
    </div>
  );
}

function CaseFile({
  report,
  actorId,
  onAct,
}: {
  report: ModeratorReportView;
  actorId: string;
  onAct: (fn: () => Promise<ModeratorReportView>) => Promise<void>;
}) {
  const [resolution, setResolution] = useState('');
  const [takeDown, setTakeDown] = useState(false);
  const closed = isClosed(report.status);

  return (
    <section className="mod-case">
      <header className="mod-case-head">
        <h3>{REASON_LABEL[report.reason] ?? report.reason}</h3>
        <span className={`mod-status mod-${report.status.toLowerCase()}`}>
          {report.status.replace('_', ' ').toLowerCase()}
        </span>
      </header>

      <p className="side-note">
        Reported {when(report.createdAt)} · about a {report.subject.kind.toLowerCase()}
        {report.subjectNotified ? ' · the reported person has been contacted' : ' · not yet contacted'}
      </p>

      {report.detail !== undefined && (
        <div className="mod-block">
          <h4>What the reporter said</h4>
          <p className="mod-quote">{report.detail}</p>
        </div>
      )}

      {/* The evidence snapshot — what the material looked like when reported,
          which is what a moderator judges rather than whatever it says now. */}
      <div className="mod-block">
        <h4>
          The material <small>as captured {when(report.evidence.capturedAt)}</small>
        </h4>
        {report.evidence.fields.length === 0 && report.evidence.photoKeys.length === 0 ? (
          <p className="side-note">
            No material captured — this was filed about a person rather than one item.
          </p>
        ) : (
          <>
            <dl className="detail-list">
              {report.evidence.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {report.evidence.photoKeys.length > 0 && (
              <div className="mod-photos">
                {report.evidence.photoKeys.map((key) => (
                  <img
                    key={key}
                    src={api.evidencePhotoUrl(report.id, key)}
                    alt="Reported photo"
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Two columns, never merged. */}
      <div className="mod-threads">
        <Thread
          title="With the reporter"
          hint="Only they see this."
          notes={report.reporterNotes}
          disabled={closed}
          onSend={(body) =>
            onAct(() => api.moderatorNote(report.id, { audience: 'REPORTER', body }, actorId))
          }
        />
        <Thread
          title="With the person reported"
          hint={
            report.subjectNotified
              ? 'Only they see this. Never name the reporter.'
              : 'Sending here is the first they will hear of it. Never name the reporter.'
          }
          notes={report.subjectNotes}
          disabled={closed}
          onSend={(body) =>
            onAct(() => api.moderatorNote(report.id, { audience: 'SUBJECT', body }, actorId))
          }
        />
      </div>

      {closed ? (
        <div className="mod-block">
          <h4>Resolution</h4>
          <p className="mod-quote">{report.resolutionNote ?? 'No note recorded.'}</p>
        </div>
      ) : (
        <div className="mod-block mod-dispose">
          <h4>Disposition</h4>
          <textarea
            rows={2}
            maxLength={4000}
            placeholder="What you decided, and why. For the record."
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          />
          {report.subject.kind === 'LISTING' && (
            <label className="deadline-toggle">
              <input
                type="checkbox"
                checked={takeDown}
                onChange={(e) => setTakeDown(e.target.checked)}
              />
              <span>Unpublish the listing and cancel its pending claims</span>
            </label>
          )}
          <div className="thing-buttons">
            <button
              type="button"
              className="accent"
              onClick={() =>
                onAct(() =>
                  api.disposeReport(
                    report.id,
                    {
                      status: 'UPHELD',
                      takeDown,
                      ...(resolution.trim() === '' ? {} : { resolutionNote: resolution.trim() }),
                    },
                    actorId,
                  ),
                )
              }
            >
              Uphold
            </button>
            <button
              type="button"
              onClick={() =>
                onAct(() =>
                  api.disposeReport(
                    report.id,
                    {
                      status: 'DISMISSED',
                      takeDown: false,
                      ...(resolution.trim() === '' ? {} : { resolutionNote: resolution.trim() }),
                    },
                    actorId,
                  ),
                )
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Thread({
  title,
  hint,
  notes,
  disabled,
  onSend,
}: {
  title: string;
  hint: string;
  notes: ModeratorReportView['reporterNotes'];
  disabled: boolean;
  onSend: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');

  return (
    <div className="mod-thread">
      <h4>{title}</h4>
      <p className="side-note">{hint}</p>

      <ol className="mod-messages">
        {notes.length === 0 && <li className="side-note">Nothing yet.</li>}
        {notes.map((note) => (
          <li key={note.id} className={note.fromModerator ? 'msg-mod' : 'msg-them'}>
            <span className="msg-who">{note.fromModerator ? 'You' : 'Them'}</span>
            <span className="msg-body">{note.body}</span>
            <span className="msg-when">{when(note.createdAt)}</span>
          </li>
        ))}
      </ol>

      {!disabled && (
        <>
          <textarea
            rows={2}
            maxLength={4000}
            value={draft}
            placeholder="Write a message…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            disabled={draft.trim() === ''}
            onClick={() => {
              const body = draft.trim();
              setDraft('');
              void onSend(body);
            }}
          >
            Send
          </button>
        </>
      )}
    </div>
  );
}

export type { NoteAudience };
