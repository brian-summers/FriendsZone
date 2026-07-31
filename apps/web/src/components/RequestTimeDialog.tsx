import { useEffect, useMemo, useState } from 'react';
import {
  overlaps,
  type BusyBlock,
  type CreateHangoutInput,
  type PublicProfile,
  type TimeRange,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays, formatDayOfWeek } from '../lib/time.js';

interface Props {
  invitee: PublicProfile;
  weekStart: Date;
  /** The friend's busy blocks *as you can see them* — for the free/busy hint. */
  friendBusy: BusyBlock[];
  actorId: string;
  /** Preselect the first proposed slot, e.g. from a drag on their calendar. */
  initialRange?: TimeRange | undefined;
  onClose: () => void;
  onSent: () => void;
}

interface SlotDraft {
  dayIndex: number;
  fromHour: number;
  toHour: number;
}

const HOURS = Array.from({ length: 16 }, (_, i) => i + 7); // 07:00–22:00

/**
 * Turn a dragged ISO range into the dialog's hour-granular, single-day slot.
 * The drag can snap to the half hour and can even cross midnight; a request
 * slot can do neither, so we floor the start hour, round the end hour up, and
 * collapse any multi-day drag to the remainder of its start day.
 */
function seedSlot(range: TimeRange, weekStart: Date): SlotDraft {
  const start = new Date(range.start);
  const end = new Date(range.end);
  const dayIndex = Math.max(
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
  const fromHour = Math.min(22, Math.max(7, Math.floor(start.getHours() + start.getMinutes() / 60)));
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const endHour = sameDay ? Math.ceil(end.getHours() + end.getMinutes() / 60) : 23;
  const toHour = Math.min(23, Math.max(fromHour + 1, endHour));
  return { dayIndex, fromHour, toHour };
}

/**
 * Propose times to a friend.
 *
 * Times are confined to the week you're looking at, on purpose: that's the week
 * whose shared availability the client already holds, so the free/busy hint
 * beside each slot is honest. The hint reads from what the friend *shares* with
 * you — never a privileged view — so "looks free" means "no conflict you can
 * see", and the dialog says exactly that.
 */
export function RequestTimeDialog({
  invitee,
  weekStart,
  friendBusy,
  actorId,
  initialRange,
  onClose,
  onSent,
}: Props) {
  const [mode, setMode] = useState<'FIXED' | 'FLOATING'>('FIXED');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [location, setLocation] = useState('');
  const [slots, setSlots] = useState<SlotDraft[]>(
    initialRange ? [seedSlot(initialRange, weekStart)] : [{ dayIndex: 3, fromHour: 19, toHour: 20 }],
  );
  // Floating: a standing invitation over the next N weeks, each of a set length.
  const [floatWeeks, setFloatWeeks] = useState(2);
  const [floatMinutes, setFloatMinutes] = useState(60);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const toRange = (slot: SlotDraft): TimeRange => {
    const start = addDays(weekStart, slot.dayIndex);
    start.setHours(slot.fromHour, 0, 0, 0);
    const end = addDays(weekStart, slot.dayIndex);
    end.setHours(slot.toHour, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  };

  const conflict = (slot: SlotDraft): boolean => {
    if (slot.toHour <= slot.fromHour) return false;
    const range = toRange(slot);
    return friendBusy.some((b) => overlaps(range, b));
  };

  const valid =
    title.trim().length > 0 &&
    (mode === 'FLOATING' || (slots.length > 0 && slots.every((s) => s.toHour > s.fromHour)));

  function updateSlot(index: number, patch: Partial<SlotDraft>) {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  const floatingPeriod = (): TimeRange => {
    const start = new Date(weekStart);
    const end = addDays(weekStart, floatWeeks * 7);
    end.setHours(23, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);

    const common = {
      inviteeId: invitee.id,
      title: title.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(location.trim() ? { location: location.trim() } : {}),
    };
    const input: CreateHangoutInput =
      mode === 'FLOATING'
        ? { ...common, kind: 'FLOATING', proposedSlots: [], period: floatingPeriod(), occurrenceMinutes: floatMinutes }
        : { ...common, kind: 'FIXED', proposedSlots: slots.map(toRange) };

    try {
      await api.createHangout(input, actorId);
      onSent();
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof ApiError
          ? `Couldn't send the request (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Cancel" />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Request time with ${invitee.displayName}`}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2>Request time</h2>
            <span className="when">with {invitee.displayName}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            Cancel
          </button>
        </div>

        <form className="dialog-body" onSubmit={submit}>
          <label className="field">
            <span>What for</span>
            <input
              type="text"
              value={title}
              autoFocus
              maxLength={120}
              placeholder="Climb at Vertigo"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="seg mode-seg">
            <button
              type="button"
              className={mode === 'FIXED' ? 'seg-on' : ''}
              aria-pressed={mode === 'FIXED'}
              onClick={() => setMode('FIXED')}
            >
              Specific times
            </button>
            <button
              type="button"
              className={mode === 'FLOATING' ? 'seg-on' : ''}
              aria-pressed={mode === 'FLOATING'}
              onClick={() => setMode('FLOATING')}
            >
              Anytime, on repeat
            </button>
          </div>

          {mode === 'FLOATING' && (
            <fieldset className="field share-field">
              <legend>A standing invitation</legend>
              <div className="field-row">
                <label className="field">
                  <span>For the next</span>
                  <select value={floatWeeks} onChange={(e) => setFloatWeeks(Number(e.target.value))}>
                    <option value={1}>1 week</option>
                    <option value={2}>2 weeks</option>
                    <option value={4}>4 weeks</option>
                  </select>
                </label>
                <label className="field">
                  <span>Each lasts</span>
                  <select value={floatMinutes} onChange={(e) => setFloatMinutes(Number(e.target.value))}>
                    <option value={30}>30 min</option>
                    <option value={60}>1 hour</option>
                    <option value={90}>90 min</option>
                    <option value={120}>2 hours</option>
                  </select>
                </label>
              </div>
              <p className="hint-note">
                {invitee.displayName.split(' ')[0]} can book this any number of times within the
                window — no fixed slot, just an open door.
              </p>
            </fieldset>
          )}

          {mode === 'FIXED' && (
          <fieldset className="field share-field">
            <legend>Suggest a few times</legend>
            <div className="slot-drafts">
              {slots.map((slot, i) => {
                const busy = conflict(slot);
                const bad = slot.toHour <= slot.fromHour;
                return (
                  <div className="slot-draft" key={i}>
                    <select
                      aria-label="Day"
                      value={slot.dayIndex}
                      onChange={(e) => updateSlot(i, { dayIndex: Number(e.target.value) })}
                    >
                      {days.map((d, di) => (
                        <option key={d.toISOString()} value={di}>
                          {formatDayOfWeek(d)} {d.getDate()}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="From"
                      value={slot.fromHour}
                      onChange={(e) => updateSlot(i, { fromHour: Number(e.target.value) })}
                    >
                      {HOURS.map((h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                    <span className="dash">–</span>
                    <select
                      aria-label="To"
                      value={slot.toHour}
                      onChange={(e) => updateSlot(i, { toHour: Number(e.target.value) })}
                    >
                      {HOURS.concat([23]).map((h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>

                    <span className={`slot-hint ${bad ? 'bad' : busy ? 'busy' : 'free'}`}>
                      {bad ? 'end must be later' : busy ? 'they’re busy' : 'looks free'}
                    </span>

                    {slots.length > 1 && (
                      <button
                        type="button"
                        className="slot-remove"
                        aria-label="Remove this time"
                        onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {slots.length < 5 && (
              <button
                type="button"
                className="add-slot"
                onClick={() =>
                  setSlots((prev) => [...prev, { dayIndex: 5, fromHour: 12, toHour: 13 }])
                }
              >
                + Another time
              </button>
            )}
            <p className="hint-note">
              Free/busy is based only on what {invitee.displayName.split(' ')[0]} shares with you.
            </p>
          </fieldset>
          )}

          <label className="field">
            <span>Note (optional)</span>
            <input
              type="text"
              value={note}
              maxLength={280}
              placeholder="No pressure on timing — whenever works"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Where (optional)</span>
            <input
              type="text"
              value={location}
              maxLength={120}
              placeholder="Vertigo Bouldering"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>

          <div className="consequence">
            {invitee.displayName.split(' ')[0]} can answer whenever — the request waits, and bows
            out on its own after a week if it goes unanswered. No nudges, no read receipts.
          </div>

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
              {submitting ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
