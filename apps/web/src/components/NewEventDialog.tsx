import { useEffect, useMemo, useState } from 'react';
import type { CreateEventInput, EventView, TimeRange } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays, dayTimeToIso, formatDayOfWeek } from '../lib/time.js';
import { SHARE_PRESETS, presetById } from '../lib/sharePresets.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  weekStart: Date;
  actorId: string;
  /** Preselect a day and time range, e.g. from a drag on the calendar. */
  initialRange?: TimeRange | undefined;
  onClose: () => void;
  onCreated: (event: EventView) => void;
}

/** 07:00–23:00 in 30-minute steps, as minutes-of-day. */
const START_OPTIONS = Array.from({ length: 32 }, (_, i) => 7 * 60 + i * 30); // 420…1350
const END_OPTIONS = Array.from({ length: 33 }, (_, i) => 7 * 60 + i * 30); // 420…1380

const clampDay = (i: number): number => Math.max(0, Math.min(6, i));

const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const dayIndexOf = (weekStart: Date, d: Date): number =>
  Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - weekStart.getTime()) /
      86_400_000,
  );

/**
 * Create an event.
 *
 * The sharing choice is a preset rather than a rule builder — see
 * `lib/sharePresets.ts` for why. The form defaults to "Friends see I'm busy",
 * the conservative option, so the safe choice is the one requiring no thought.
 * A drag on the calendar opens this with the day and time pre-filled.
 */
export function NewEventDialog({ weekStart, actorId, initialRange, onClose, onCreated }: Props) {
  const initStart = initialRange ? new Date(initialRange.start) : null;
  const initEnd = initialRange ? new Date(initialRange.end) : null;

  const [title, setTitle] = useState('');
  const [startDay, setStartDay] = useState(
    initStart ? clampDay(dayIndexOf(weekStart, initStart)) : 0,
  );
  const [endDay, setEndDay] = useState(
    initEnd ? clampDay(dayIndexOf(weekStart, initEnd)) : initStart ? clampDay(dayIndexOf(weekStart, initStart)) : 0,
  );
  const [fromMin, setFromMin] = useState(initStart ? initStart.getHours() * 60 + initStart.getMinutes() : 18 * 60);
  const [toMin, setToMin] = useState(initEnd ? initEnd.getHours() * 60 + initEnd.getMinutes() : 19 * 60);
  const [location, setLocation] = useState('');
  const [presetId, setPresetId] = useState('busy');
  const [exclusive, setExclusive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preset = presetById(presetId);
  const badge = encodingFor(preset.widest);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Compare as absolute minutes-from-week-start, so an event may end on a later
  // day than it starts (a weekend trip, an overnight) and still validate.
  const startTotal = startDay * 1440 + fromMin;
  const endTotal = endDay * 1440 + toMin;
  const valid = title.trim().length > 0 && endTotal > startTotal;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    setError(null);

    const input: CreateEventInput = {
      title: title.trim(),
      timeRange: {
        start: dayTimeToIso(weekStart, startDay, fromMin),
        end: dayTimeToIso(weekStart, endDay, toMin),
      },
      status: 'CONFIRMED',
      visibilityCeiling: preset.ceiling,
      shareRules: preset.rules,
      attendeeIds: [],
      exclusive,
      ...(location.trim() ? { location: location.trim() } : {}),
    };

    try {
      const created = await api.createEvent(input, actorId);
      onCreated(created);
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof ApiError
          ? `Couldn't create the event (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Cancel" />
      <div className="dialog" role="dialog" aria-modal="true" aria-label="New event">
        <div className="drawer-head">
          <h2 style={{ flex: 1 }}>New event</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            Cancel
          </button>
        </div>

        <form className="dialog-body" onSubmit={submit}>
          <label className="field">
            <span>What</span>
            <input
              type="text"
              value={title}
              autoFocus
              maxLength={120}
              placeholder="Coffee with Priya"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Starts</span>
              <select
                value={startDay}
                onChange={(e) => {
                  const d = Number(e.target.value);
                  setStartDay(d);
                  // Keep the end from falling before the start when the start moves.
                  if (d > endDay) setEndDay(d);
                }}
              >
                {days.map((d, i) => (
                  <option key={d.toISOString()} value={i}>
                    {formatDayOfWeek(d)} {d.getDate()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <select value={fromMin} onChange={(e) => setFromMin(Number(e.target.value))}>
                {START_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {fmtMin(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Ends</span>
              <select value={endDay} onChange={(e) => setEndDay(Number(e.target.value))}>
                {days.map((d, i) => (
                  <option key={d.toISOString()} value={i}>
                    {formatDayOfWeek(d)} {d.getDate()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To</span>
              <select value={toMin} onChange={(e) => setToMin(Number(e.target.value))}>
                {END_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {fmtMin(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {endTotal <= startTotal && (
            <p className="field-error">The end has to be after the start.</p>
          )}
          {endDay > startDay && endTotal > startTotal && (
            <p className="hint-note">
              Spans {endDay - startDay === 1 ? 'into the next day' : `${endDay - startDay} days`}.
            </p>
          )}

          <label className="field">
            <span>Where (optional)</span>
            <input
              type="text"
              value={location}
              maxLength={120}
              placeholder="Trellis Cafe"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>

          <fieldset className="field share-field">
            <legend>Who can see this</legend>
            <div className="preset-list">
              {SHARE_PRESETS.map((p) => (
                <label key={p.id} className={`preset${presetId === p.id ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name="preset"
                    value={p.id}
                    checked={presetId === p.id}
                    onChange={() => setPresetId(p.id)}
                  />
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-consequence">{p.consequence}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="consequence">
            <span className="level-tag">
              {badge.glyph} {badge.label}
            </span>{' '}
            {preset.consequence}
          </div>

          <label className="check-field">
            <input
              type="checkbox"
              checked={exclusive}
              onChange={(e) => setExclusive(e.target.checked)}
            />
            <span>
              <strong>Block this time</strong>
              <small>
                By default events can overlap and friends may request the time. Tick this to make it
                exclusive — a hard block that shows as busy and nothing can overlap.
              </small>
            </span>
          </label>

          {error !== null && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <div className="dialog-actions">
            <button type="button" className="icon-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!valid || submitting}>
              {submitting ? 'Adding…' : 'Add to calendar'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
