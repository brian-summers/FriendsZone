/**
 * An hour field and a minute field, side by side.
 *
 * One 48-entry dropdown of "00:00, 00:30, 01:00 …" was tolerable when the grid
 * covered a working day. Across a full 24 hours it is a list nobody wants to
 * scroll, and it silently forbids 09:05 because five past was never an option.
 *
 * Two fields fix both: 24 hours and 12 minute steps, each short enough to pick
 * without scrolling, and together they reach any quarter hour. The value the
 * caller sees is still a single minute-of-day, so nothing downstream has to
 * know this is two controls.
 */

interface Props {
  /** Minutes from local midnight, 0 to 1439. */
  value: number;
  onChange: (minuteOfDay: number) => void;
  /** Labels the pair for assistive technology, e.g. "Start time". */
  label: string;
  /** Minute granularity. 5 gives fine control; 15 matches the grid's snap. */
  step?: number;
  id?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad = (n: number) => String(n).padStart(2, '0');

export function TimeField({ value, onChange, label, step = 5, id }: Props) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const minutes = Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);

  // A stored value that is not on the step (from a drag, or an older event)
  // must still be selectable, or opening the form would silently move it.
  const minuteOptions = minutes.includes(minute)
    ? minutes
    : [...minutes, minute].sort((a, b) => a - b);

  return (
    <span className="timefield" role="group" aria-label={label}>
      <select
        id={id}
        aria-label={`${label}, hour`}
        value={hour}
        onChange={(e) => onChange(Number(e.target.value) * 60 + minute)}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {pad(h)}
          </option>
        ))}
      </select>
      <span className="timefield-sep" aria-hidden="true">
        :
      </span>
      <select
        aria-label={`${label}, minute`}
        value={minute}
        onChange={(e) => onChange(hour * 60 + Number(e.target.value))}
      >
        {minuteOptions.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </select>
    </span>
  );
}
