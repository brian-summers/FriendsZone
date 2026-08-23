import { useState } from 'react';
import type { FindSlotsResult, PublicProfile, TimeRange, UserId } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * "When are we all free?"
 *
 * The interface has one obligation the rest of the app does not: it must say
 * out loud when an answer is built on incomplete information. A participant who
 * shares nothing with you appears completely free, so a suggestion can be
 * confidently wrong - and a wrong suggestion a user can *explain* beats a right
 * one built on data they were not entitled to
 * (docs/adr/0008-slot-finder-on-projections.md).
 *
 * That is what the denominator line is for. It is not a disclaimer to be styled
 * quietly; it is the feature being honest about its own limits.
 */

interface Props {
  actorId: string;
  people: PublicProfile[];
  /** Hand a chosen slot back so the caller can open a request composer. */
  onPick: (slot: TimeRange, participantIds: UserId[]) => void;
  onClose: () => void;
}

const DURATIONS: Array<[number, string]> = [
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [180, '3 hours'],
];

const dayLabel = (instant: string): string =>
  new Date(instant).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

const timeLabel = (instant: string): string =>
  new Date(instant).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function SlotFinder({ actorId, people, onPick, onClose }: Props) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [duration, setDuration] = useState(60);
  const [horizonDays, setHorizonDays] = useState(14);
  const [earliestHour, setEarliestHour] = useState(9);
  const [latestHour, setLatestHour] = useState(21);
  const [result, setResult] = useState<FindSlotsResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + horizonDays);

      setResult(
        await api.findSlots(
          {
            participantIds: [...chosen] as UserId[],
            window: { start: start.toISOString(), end: end.toISOString() },
            durationMinutes: duration,
            earliestHour,
            latestHour,
          },
          actorId,
        ),
      );
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? `Couldn’t work that out (${err.status}).`
          : 'Could not reach the API.',
      );
    } finally {
      setSearching(false);
    }
  }

  const nameOf = (id: string) =>
    people.find((p) => p.id === id)?.displayName ?? 'Someone';

  // The denominator. Computed from the server's answer, never guessed here.
  const silent =
    result?.participants.filter((p) => !p.sharesAvailability && p.userId !== actorId) ?? [];
  const total = result?.participants.length ?? 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog slotfinder" role="dialog" aria-label="Find a time">
        <h3>When are we all free?</h3>

        <div className="field">
          <span className="field-label">Who</span>
          <div className="slot-people">
            {people.map((person) => (
              <label
                key={person.id}
                className={`slot-person${chosen.has(person.id) ? ' slot-person-on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={chosen.has(person.id)}
                  onChange={() => toggle(person.id)}
                />
                <span>{person.displayName}</span>
              </label>
            ))}
            {people.length === 0 && (
              <p className="side-note">No friends to schedule with on this account.</p>
            )}
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span>For how long</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Looking ahead</span>
            <select value={horizonDays} onChange={(e) => setHorizonDays(Number(e.target.value))}>
              <option value={7}>1 week</option>
              <option value={14}>2 weeks</option>
              <option value={30}>1 month</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>No earlier than</span>
            <select
              value={earliestHour}
              onChange={(e) => setEarliestHour(Number(e.target.value))}
            >
              {[6, 8, 9, 12, 17].map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>No later than</span>
            <select value={latestHour} onChange={(e) => setLatestHour(Number(e.target.value))}>
              {[17, 19, 21, 22, 24].map((h) => (
                <option key={h} value={h}>
                  {h === 24 ? 'midnight' : `${h}:00`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error !== null && (
          <p className="things-error" role="status">
            {error}
          </p>
        )}

        <div className="thing-buttons">
          <button
            type="button"
            className="accent"
            disabled={chosen.size === 0 || searching}
            onClick={() => void search()}
          >
            {searching ? 'Looking…' : 'Find a time'}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {result !== null && (
          <div className="slot-results">
            {/* The obligation. Stated before the answers, not after them. */}
            <p className="slot-denominator">
              <strong>
                {total - silent.length} of {total}
              </strong>{' '}
              {total - silent.length === 1 ? 'person shares' : 'people share'} availability with
              you.
              {silent.length > 0 && (
                <>
                  {' '}
                  {silent.map((p) => nameOf(p.userId)).join(' and ')}{' '}
                  {silent.length === 1 ? "doesn't" : "don't"} - so{' '}
                  {silent.length === 1 ? 'they’re' : 'they’re'} shown as free, and these
                  suggestions may be wrong.
                </>
              )}
            </p>

            {result.slots.length === 0 && (
              <p className="things-empty">
                No window that long works for everyone. Try a shorter slot or a wider range.
              </p>
            )}

            <ul className="slot-list">
              {result.slots.slice(0, 20).map((slot) => (
                <li key={slot.start}>
                  <button
                    type="button"
                    className="slot-option"
                    onClick={() => onPick(slot, [...chosen] as UserId[])}
                  >
                    <span className="slot-day">{dayLabel(slot.start)}</span>
                    <span className="slot-time mono">
                      {timeLabel(slot.start)} – {timeLabel(slot.end)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
