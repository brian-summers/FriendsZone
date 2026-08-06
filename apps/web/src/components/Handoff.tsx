import { useState } from 'react';
import type { ExchangeView, UserId } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { ReportDialog } from './ReportDialog.js';

/**
 * Arranging the handoff.
 *
 * This is the only screen in Friendszone that ends with two people in a room,
 * so it is the only one that says so out loud: what the other person will see,
 * what everyone else will see, and how to get out of it. None of that copy is
 * decoration — it is the difference between someone understanding what they are
 * agreeing to and finding out afterwards.
 *
 * See docs/adr/0019-the-handoff.md.
 */

interface Props {
  claimId: string;
  /** The other party, for the heading and the report control. */
  counterpartyId: UserId;
  counterpartyName: string;
  exchange: ExchangeView | undefined;
  actorId: string;
  onChanged: () => void;
}

const when = (range: { start: string; end: string }): string => {
  const start = new Date(range.start);
  const end = new Date(range.end);
  return `${start.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })}, ${start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}–${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

/** Local value for a datetime-local input, `days` ahead at 3pm. */
const defaultWhen = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(15, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function Handoff({
  claimId,
  counterpartyId,
  counterpartyName,
  exchange,
  actorId,
  onChanged,
}: Props) {
  const [composing, setComposing] = useState(false);
  const [startsAt, setStartsAt] = useState(defaultWhen(3));
  const [minutes, setMinutes] = useState(30);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setComposing(false);
      onChanged();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'That’s moved on — reload and take another look.'
            : `That didn’t work (${err.status}).`
          : 'Could not reach the API.',
      );
    } finally {
      setBusy(false);
    }
  }

  const propose = () => {
    const start = new Date(startsAt);
    const end = new Date(start.getTime() + minutes * 60_000);
    return act(() =>
      api.proposeExchange(
        claimId,
        {
          timeRange: { start: start.toISOString(), end: end.toISOString() },
          location: location.trim(),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        actorId,
      ),
    );
  };

  const live = exchange !== undefined && exchange.status !== 'CANCELLED';
  const theyProposed = exchange !== undefined && exchange.proposedBy !== actorId;

  return (
    <div className="handoff">
      <h5 className="handoff-title">Handing it over</h5>

      {error !== null && (
        <p className="things-error" role="status">
          {error}
        </p>
      )}

      {/* ── Nothing arranged ─────────────────────────────────────── */}
      {!live && !composing && (
        <>
          <p className="handoff-none">
            Nothing arranged yet. Either of you can suggest a time and place.
          </p>
          <button type="button" className="accent" onClick={() => setComposing(true)}>
            Suggest a time
          </button>
        </>
      )}

      {/* ── Proposing ────────────────────────────────────────────── */}
      {composing && (
        <div className="handoff-compose">
          <p className="handoff-safety">
            Somewhere public is usually best — a café, a shop, a busy street. You’re about to
            share a time and place with <strong>{counterpartyName}</strong>.
          </p>

          <div className="field-row">
            <label className="field">
              <span>When</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </label>
            <label className="field">
              <span>How long</span>
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
              </select>
            </label>
          </div>

          <label className="field">
            <span>Where</span>
            <input
              value={location}
              maxLength={120}
              placeholder="Trellis Cafe, 8 Bridge St"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Anything else? (optional)</span>
            <textarea
              rows={2}
              maxLength={4000}
              value={note}
              placeholder="I’ll have a green backpack."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          {/* The one thing people most need to know, and cannot infer. */}
          <p className="side-note">
            Once you both agree this goes on both your calendars. Everyone else only ever sees
            that you’re busy — never where, never with whom.
          </p>

          <div className="thing-buttons">
            <button
              type="button"
              className="accent"
              disabled={busy || location.trim() === ''}
              onClick={() => void propose()}
            >
              {exchange === undefined ? 'Suggest it' : 'Suggest this instead'}
            </button>
            <button type="button" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Something on the table ───────────────────────────────── */}
      {live && !composing && exchange !== undefined && (
        <div className={`handoff-card handoff-${exchange.status.toLowerCase()}`}>
          <p className="handoff-when">{when(exchange.timeRange)}</p>
          <p className="handoff-where">{exchange.location}</p>
          {exchange.note !== undefined && <p className="handoff-note">{exchange.note}</p>}

          {exchange.status === 'PROPOSED' && (
            <>
              <p className="handoff-state">
                {theyProposed
                  ? `${counterpartyName} suggested this.`
                  : 'Waiting for them to agree.'}
              </p>
              <div className="thing-buttons">
                {theyProposed && (
                  <button
                    type="button"
                    className="accent"
                    disabled={busy}
                    onClick={() => void act(() => api.respondExchange(exchange.id, 'ACCEPT', actorId))}
                  >
                    That works
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => setComposing(true)}>
                  Suggest another time
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => api.cancelExchange(exchange.id, actorId))}
                >
                  Call it off
                </button>
              </div>
            </>
          )}

          {exchange.status === 'SCHEDULED' && (
            <>
              <p className="handoff-state">
                Agreed, and on both your calendars. Nobody else can see where or with whom.
              </p>
              <div className="thing-buttons">
                <button
                  type="button"
                  className="accent"
                  disabled={busy}
                  onClick={() => void act(() => api.completeExchange(exchange.id, actorId))}
                >
                  Done — we’ve swapped
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => api.cancelExchange(exchange.id, actorId))}
                >
                  Call it off
                </button>
              </div>
            </>
          )}

          {exchange.status === 'COMPLETED' && (
            <p className="handoff-state">All done. Enjoy it.</p>
          )}
        </div>
      )}

      {/* Always available while arranging — someone who becomes uneasy should
          not have to go and find the feature (ADR 0019). */}
      <div className="handoff-report">
        <button type="button" className="link-btn" onClick={() => setReporting(true)}>
          Something feels off — report {counterpartyName}
        </button>
      </div>

      {reporting && (
        <ReportDialog
          subject={{ kind: 'USER', userId: counterpartyId }}
          label={counterpartyName}
          actorId={actorId}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
}
