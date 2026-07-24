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

/**
 * Convert an interval into grid coordinates.
 *
 * Clamped to the visible hours so an all-day or overnight block renders as a
 * full column rather than overflowing. An event starting before the visible
 * range still shows: truncating it would misreport availability.
 */
export function place(startIso: string, endIso: string, weekStart: Date): Placement {
  const start = new Date(startIso);
  const end = new Date(endIso);

  const dayIndex = Math.floor(
    (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() -
      weekStart.getTime()) /
      86_400_000,
  );
  if (dayIndex < 0 || dayIndex > 6) return { dayIndex: -1, top: 0, height: 0 };

  const startMin = Math.max(minutesInDay(start), DAY_START_HOUR * 60);
  // An interval ending on a later day is clamped to the bottom of this column.
  const endsLater = !isSameDay(start, end) && end.getTime() > start.getTime();
  const endMin = endsLater
    ? DAY_END_HOUR * 60
    : Math.min(minutesInDay(end), DAY_END_HOUR * 60);

  const top = ((startMin - DAY_START_HOUR * 60) / 60) * HOUR_PX;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_PX, 16);

  return { dayIndex, top, height };
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
