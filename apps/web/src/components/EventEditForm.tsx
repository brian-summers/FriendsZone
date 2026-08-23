import { useState } from 'react';
import type { EventFullView, TimeRange } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays } from '../lib/time.js';

interface Props {
  event: EventFullView;
  weekStart: Date;
  actorId: string;
  onDone: () => void;
  onCancel: () => void;
}

const HOURS = Array.from({ length: 16 }, (_, i) => i + 7);

/** Edit or delete a plain (non-hangout) event you own. */
export function EventEditForm({ event, weekStart, actorId, onDone, onCancel }: Props) {
  const start = new Date(event.timeRange.start);
  const end = new Date(event.timeRange.end);

  const initialDay = Math.max(
    0,
    Math.min(
      6,
      Math.round(
        (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() -
          weekStart.getTime()) /
          86_400_000,
      ),
    ),
  );

  const [title, setTitle] = useState(event.title);
  const [location, setLocation] = useState(event.location ?? '');
  const [dayIndex, setDayIndex] = useState(initialDay);
  const [fromHour, setFromHour] = useState(start.getHours());
  const [toHour, setToHour] = useState(Math.max(end.getHours(), start.getHours() + 1));
  const [exclusive, setExclusive] = useState(event.exclusive);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = (): TimeRange => {
    const s = addDays(weekStart, dayIndex);
    s.setHours(fromHour, 0, 0, 0);
    const e = addDays(weekStart, dayIndex);
    e.setHours(toHour, 0, 0, 0);
    return { start: s.toISOString(), end: e.toISOString() };
  };

  const valid = title.trim().length > 0 && toHour > fromHour;

  async function run(which: 'save' | 'delete', fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setBusy(null);
      setError(err instanceof ApiError ? `That didn’t go through (${err.status}).` : 'Could not reach the API.');
    }
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="manage-panel" style={{ marginTop: 'var(--space-md)' }}>
      <label className="field">
        <span>Title</span>
        <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>

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

      <label className="field">
        <span>Where (optional)</span>
        <input type="text" value={location} maxLength={120} onChange={(e) => setLocation(e.target.value)} />
      </label>

      <label className="check-field compact">
        <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
        <span>Block this time - exclusive, no overlaps</span>
      </label>

      {error !== null && <p className="field-error" role="alert">{error}</p>}

      <div className="dialog-actions">
        {confirmDelete ? (
          <>
            <span className="expiry" style={{ marginRight: 'auto' }}>Delete for good?</span>
            <button type="button" className="icon-btn" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={busy !== null}
              onClick={() => run('delete', () => api.deleteEvent(event.id, actorId))}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="icon-btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
            <button type="button" className="icon-btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!valid || busy !== null}
              onClick={() =>
                run('save', () =>
                  api.updateEvent(
                    event.id,
                    {
                      title: title.trim(),
                      timeRange: range(),
                      exclusive,
                      ...(location.trim() ? { location: location.trim() } : {}),
                    },
                    actorId,
                  ),
                )
              }
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
