import { useEffect, useMemo, useState } from 'react';
import type { CreateEventInput, EventView } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays, formatDayOfWeek } from '../lib/time.js';
import { SHARE_PRESETS, presetById } from '../lib/sharePresets.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  weekStart: Date;
  actorId: string;
  /** Preselect a day/hour when opened from an empty grid slot. */
  initial?: { dayIndex: number; hour: number } | undefined;
  onClose: () => void;
  onCreated: (event: EventView) => void;
}

const HOURS = Array.from({ length: 16 }, (_, i) => i + 7); // 07:00–22:00

/** Build a local ISO instant for a day within the displayed week. */
function instant(weekStart: Date, dayIndex: number, hour: number): string {
  const d = addDays(weekStart, dayIndex);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/**
 * Create an event.
 *
 * The sharing choice is a preset rather than a rule builder — see
 * `lib/sharePresets.ts` for why. The form defaults to "Friends see I'm busy",
 * the conservative option, so the safe choice is the one requiring no thought.
 */
export function NewEventDialog({ weekStart, actorId, initial, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [dayIndex, setDayIndex] = useState(initial?.dayIndex ?? 0);
  const [startHour, setStartHour] = useState(initial?.hour ?? 18);
  const [endHour, setEndHour] = useState((initial?.hour ?? 18) + 1);
  const [location, setLocation] = useState('');
  const [presetId, setPresetId] = useState('busy');
  const [openToConflict, setOpenToConflict] = useState(false);
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

  const valid = title.trim().length > 0 && endHour > startHour;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    setError(null);

    const input: CreateEventInput = {
      title: title.trim(),
      timeRange: {
        start: instant(weekStart, dayIndex, startHour),
        end: instant(weekStart, dayIndex, endHour),
      },
      status: 'CONFIRMED',
      visibilityCeiling: preset.ceiling,
      shareRules: preset.rules,
      attendeeIds: [],
      openToConflict,
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
              <span>Day</span>
              <select value={dayIndex} onChange={(e) => setDayIndex(Number(e.target.value))}>
                {days.map((d, i) => (
                  <option key={d.toISOString()} value={i}>
                    {formatDayOfWeek(d)} {d.getDate()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To</span>
              <select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
                {HOURS.concat([23]).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
          </div>

          {endHour <= startHour && (
            <p className="field-error">The end time has to be after the start.</p>
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
              checked={openToConflict}
              onChange={(e) => setOpenToConflict(e.target.checked)}
            />
            <span>
              <strong>Open to conflict</strong>
              <small>
                Friends can still request this time. It shows as “open”, not busy — good for
                flexible plans you’d happily move.
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
