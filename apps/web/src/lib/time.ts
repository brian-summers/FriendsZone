/**
 * Calendar geometry and date helpers.
 *
 * All arithmetic is in the viewer's local timezone; instants cross the wire as
 * UTC and are converted exactly once, here. Doing it anywhere else is how an
 * event ends up drawn on the wrong day for anyone not on UTC.
 */

/** First and last hour drawn in the grid. */
export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 23;
export const HOUR_PX = 44;

export const GRID_HEIGHT = (DAY_END_HOUR - DAY_START_HOUR) * HOUR_PX;

export const HOURS: number[] = Array.from(
  { length: DAY_END_HOUR - DAY_START_HOUR },
  (_, i) => DAY_START_HOUR + i,
);

/** Monday 00:00 local of the week containing `date`, plus `weekOffset` weeks. */
export function startOfWeek(date: Date, weekOffset = 0): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - shift + weekOffset * 7);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Minutes since local midnight. */
const minutesInDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

export interface Placement {
  /** Index 0–6 from the Monday of the displayed week, or -1 if outside it. */
  dayIndex: number;
  top: number;
  height: number;
}

export interface Segment extends Placement {
  /** The interval began before this day — this segment is a continuation. */
  continuesBefore: boolean;
  /** The interval runs past this day into the next one. */
  continuesAfter: boolean;
  /**
   * The portion of the interval that falls inside this day, as ISO. Feeds the
   * per-day column layout so a multi-day event packs against the events it
   * actually overlaps *on that day*, not across the whole span.
   */
  clipStart: string;
  clipEnd: string;
}

/**
 * Convert an interval into one grid segment per day it covers within the
 * displayed week.
 *
 * A same-day interval yields a single segment. One that crosses midnight yields
 * a segment per day: the first runs to the bottom of its column, each whole
 * middle day fills its column, and the last starts at the top — so a weekend
 * trip reads as a continuous band across the columns it touches. Days outside
 * `[weekStart, weekStart+7)` are omitted, so the result is already clipped to
 * the visible week.
 *
 * Clamped to the visible hours, like the old single-day placement: an event
 * reaching past the visible range still shows, because truncating it would
 * misreport availability.
 */
export function placeSpan(startIso: string, endIso: string, weekStart: Date): Segment[] {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const segments: Segment[] = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    // Local midnight to local midnight, via date arithmetic so DST-length days
    // stay correct — the boundaries are real instants, not fixed 24h offsets.
    const dayStartMs = addDays(weekStart, dayIndex).getTime();
    const dayEndMs = addDays(weekStart, dayIndex + 1).getTime();

    const segStartMs = Math.max(start.getTime(), dayStartMs);
    const segEndMs = Math.min(end.getTime(), dayEndMs);
    if (segStartMs >= segEndMs) continue; // this day isn't touched

    const startMinRaw = (segStartMs - dayStartMs) / 60_000;
    const endMinRaw = (segEndMs - dayStartMs) / 60_000;
    const startMin = Math.max(startMinRaw, DAY_START_HOUR * 60);
    const endMin = Math.min(endMinRaw, DAY_END_HOUR * 60);

    const top = ((startMin - DAY_START_HOUR * 60) / 60) * HOUR_PX;
    const height = Math.max(((endMin - startMin) / 60) * HOUR_PX, 16);

    segments.push({
      dayIndex,
      top,
      height,
      continuesBefore: start.getTime() < dayStartMs,
      continuesAfter: end.getTime() > dayEndMs,
      clipStart: new Date(segStartMs).toISOString(),
      clipEnd: new Date(segEndMs).toISOString(),
    });
  }

  return segments;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export const formatTime = (iso: string): string => timeFmt.format(new Date(iso));

export const formatRange = (startIso: string, endIso: string): string =>
  `${formatTime(startIso)}–${formatTime(endIso)}`;

export function formatWeekLabel(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const month = new Intl.DateTimeFormat(undefined, { month: 'long' });
  const short = new Intl.DateTimeFormat(undefined, { month: 'short' });

  return sameMonth
    ? `${month.format(weekStart)} ${weekStart.getDate()}–${end.getDate()}, ${end.getFullYear()}`
    : `${short.format(weekStart)} ${weekStart.getDate()} – ${short.format(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
export const formatDayOfWeek = (d: Date): string => dowFmt.format(d);

/** Offset of "now" within the grid, or null when outside the visible hours. */
export function nowOffset(now: Date): number | null {
  const min = minutesInDay(now);
  if (min < DAY_START_HOUR * 60 || min > DAY_END_HOUR * 60) return null;
  return ((min - DAY_START_HOUR * 60) / 60) * HOUR_PX;
}

/** Drag-to-create snaps to this grid. */
export const SNAP_MINUTES = 30;

/** Vertical pixel within a day column → snapped minutes-since-local-midnight. */
export function yToMinutes(y: number): number {
  // A non-finite pixel (e.g. an event init without coordinates) is treated as
  // the top of the grid rather than propagating NaN into a Date.
  const raw = Number.isFinite(y) ? DAY_START_HOUR * 60 + (y / HOUR_PX) * 60 : DAY_START_HOUR * 60;
  const clamped = Math.max(DAY_START_HOUR * 60, Math.min(DAY_END_HOUR * 60, raw));
  return Math.round(clamped / SNAP_MINUTES) * SNAP_MINUTES;
}

/** A day index within the displayed week + minutes-of-day → an ISO instant. */
export function dayTimeToIso(weekStart: Date, dayIndex: number, minutes: number): string {
  const d = addDays(weekStart, dayIndex);
  d.setHours(0, minutes, 0, 0);
  return d.toISOString();
}

/** One endpoint of a drag: a day column and a minute-of-day within it. */
export interface DragPoint {
  day: number;
  min: number;
}

/**
 * Normalise a drag's two endpoints into an ISO range.
 *
 * Orders them (a drag can go up or to the left), and expands a click — or a
 * drag that never left its starting slot — into a single `SNAP_MINUTES` block.
 * The endpoints may sit in different columns, so the resulting range can span
 * days; `dayTimeToIso` turns each (day, minute) into a real instant.
 */
export function rangeFromDrag(
  a: DragPoint,
  b: DragPoint,
  weekStart: Date,
): { start: string; end: string } {
  const forward = a.day < b.day || (a.day === b.day && a.min <= b.min);
  const lo = forward ? a : b;
  const hi = forward ? b : a;
  let hiMin = hi.min;
  if (lo.day === hi.day && hiMin - lo.min < SNAP_MINUTES) hiMin = lo.min + SNAP_MINUTES;
  return {
    start: dayTimeToIso(weekStart, lo.day, lo.min),
    end: dayTimeToIso(weekStart, hi.day, hiMin),
  };
}

/** Which column an event occupies, and how many columns its overlap-cluster needs. */
export interface ColumnSpan {
  col: number;
  cols: number;
}

/**
 * Lay overlapping intervals out in side-by-side columns.
 *
 * Events overlap by default now, so a block can hold several at once; this is
 * the standard interval-graph packing — greedy column assignment within each
 * cluster of transitively-overlapping events — that reads as "multiple things
 * in the same slot" rather than chips stacked illegibly on top of each other.
 * Returns one `ColumnSpan` per input, in input order.
 */
export function layoutColumns(items: ReadonlyArray<{ start: string; end: string }>): ColumnSpan[] {
  const order = items
    .map((it, i) => ({ i, s: Date.parse(it.start), e: Date.parse(it.end) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const result: ColumnSpan[] = items.map(() => ({ col: 0, cols: 1 }));
  let cluster: Array<(typeof order)[number]> = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const colEnds: number[] = [];
    const placed: number[] = [];
    for (const it of cluster) {
      let c = colEnds.findIndex((end) => it.s >= end);
      if (c === -1) {
        c = colEnds.length;
        colEnds.push(0);
      }
      colEnds[c] = it.e;
      placed.push(c);
    }
    const cols = colEnds.length;
    cluster.forEach((it, k) => {
      result[it.i] = { col: placed[k]!, cols };
    });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of order) {
    if (cluster.length > 0 && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();

  return result;
}
