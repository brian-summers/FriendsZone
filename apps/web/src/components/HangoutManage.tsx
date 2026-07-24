import { useState } from 'react';
import type { TimeRange } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays } from '../lib/time.js';

interface Props {
  hangoutId: string;
  /** A confirmed hangout can be rescheduled to one time and cancelled; a
   *  pending one can have its proposed times swapped. */
  confirmed: boolean;
  /** Whether the actor is the organiser (proposer). Only they may edit/move. */
  isOrganiser: boolean;
  currentTitle: string;
  /** A sensible default day/time for the reschedule picker. */
  defaultStart: Date;
  weekStart: Date;
  actorId: string;
  onDone: () => void;
}

type Panel = 'none' | 'edit' | 'reschedule' | 'cancel';

const HOURS = Array.from({ length: 16 }, (_, i) => i + 7);

/**
 * Manage a hangout straight from the calendar.
 *
 * The actions offered mirror the server's rules: the organiser can edit details
 * and move the time; either participant can cancel a confirmed hangout. The
 * component never shows an action the actor can't take, and the server refuses
 * anything slipped past anyway.
 */
export function HangoutManage({
  hangoutId,
  confirmed,
  isOrganiser,
  currentTitle,
  defaultStart,
  weekStart,
  actorId,
  onDone,
}: Props) {
  const [panel, setPanel] = useState<Panel>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(currentTitle);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState('');

  const [dayIndex, setDayIndex] = useState(Math.max(0, Math.min(6, Math.round(
    (new Date(defaultStart.getFullYear(), defaultStart.getMonth(), defaultStart.getDate()).getTime() -
      weekStart.getTime()) /
      86_400_000,
  ))));
  const [fromHour, setFromHour] = useState(defaultStart.getHours() || 18);
  const [toHour, setToHour] = useState((defaultStart.getHours() || 18) + 1);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const newRange = (): TimeRange => {
    const start = addDays(weekStart, dayIndex);
    start.setHours(fromHour, 0, 0, 0);
    const end = addDays(weekStart, dayIndex);
    end.setHours(toHour, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  };

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'That’s no longer possible — it may have changed. Refreshing.'
            : `That didn’t go through (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <div className="manage">
      <p className="manage-label">Manage this hangout</p>

      <div className="manage-actions">
        {isOrganiser && (
          <button type="button" className="icon-btn" onClick={() => setPanel(panel === 'edit' ? 'none' : 'edit')}>
            Edit details
          </button>
        )}
        {isOrganiser && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPanel(panel === 'reschedule' ? 'none' : 'reschedule')}
          >
            {confirmed ? 'Reschedule' : 'Change times'}
          </button>
        )}
        {confirmed && (
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => setPanel(panel === 'cancel' ? 'none' : 'cancel')}
          >
            Cancel hangout
          </button>
        )}
      </div>

      {error !== null && (
        <div className="consequence" style={{ borderLeftColor: 'var(--madder)' }}>
          {error}
        </div>
      )}

      {panel === 'edit' && (
        <div className="manage-panel">
          <label className="field">
            <span>Title</span>
            <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="check-field compact">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>Let them know</span>
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || title.trim().length === 0}
            onClick={() => run(() => api.updateHangout(hangoutId, { title: title.trim(), notify }, actorId))}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {panel === 'reschedule' && (
        <div className="manage-panel">
          <div className="slot-draft">
            <select aria-label="Day" value={dayIndex} onChange={(e) => setDayIndex(Number(e.target.value))}>
              {days.map((d, di) => (
                <option key={d.toISOString()} value={di}>
                  {d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                </option>
              ))}
            </select>
            <select aria-label="From" value={fromHour} onChange={(e) => setFromHour(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
            <span className="dash">–</span>
            <select aria-label="To" value={toHour} onChange={(e) => setToHour(Number(e.target.value))}>
              {HOURS.concat([23]).map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
          {confirmed && (
            <label className="check-field compact">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span>Let them know</span>
            </label>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={busy || toHour <= fromHour}
            onClick={() =>
              run(() => api.rescheduleHangout(hangoutId, { proposedSlots: [newRange()], notify }, actorId))
            }
          >
            {busy ? 'Moving…' : confirmed ? 'Move to this time' : 'Propose this instead'}
          </button>
        </div>
      )}

      {panel === 'cancel' && (
        <div className="manage-panel">
          <label className="field">
            <span>Reason (optional)</span>
            <input
              type="text"
              value={reason}
              maxLength={280}
              placeholder="Something came up"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="check-field compact">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>Let them know it’s off</span>
          </label>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() =>
              run(() =>
                api.cancelHangout(
                  hangoutId,
                  { notify, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                  actorId,
                ),
              )
            }
          >
            {busy ? 'Cancelling…' : 'Cancel this hangout'}
          </button>
        </div>
      )}
    </div>
  );
}
