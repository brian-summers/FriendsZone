import type { QuietHours, TimeRange } from '@friendszone/contracts';
import { inQuietHours } from '@friendszone/contracts';

/**
 * Quiet hours, evaluated against real instants.
 *
 * The awkward part is timezones, and it is not optional. A quiet window is
 * wall-clock: "do not ask me between 23:00 and 09:00" means *the owner's*
 * 23:00, not the proposer's and not UTC. Someone in Auckland proposing to
 * someone in Lisbon must be refused on the Lisbon clock, or the feature is
 * worse than useless to anyone who has friends abroad.
 *
 * This file is still pure. `Intl.DateTimeFormat` converts a given instant to a
 * given zone deterministically; it reads no clock and no environment, so the
 * package's "no I/O, no ambient state" rule holds.
 */

/** Minutes from local midnight for `instant`, in `timeZone`. */
export function localMinuteOfDay(instant: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Whether any part of `range` falls inside the owner's quiet hours.
 *
 * Sampled every 15 minutes rather than solved analytically. That is a
 * deliberate trade: the window wraps midnight, ranges can span days, and
 * timezones have DST transitions where a local hour repeats or does not exist
 * at all. A closed-form answer would have to model all three, and would be
 * wrong in the cases nobody tests. Sampling is obviously correct at the
 * granularity the product actually offers, because the smallest bookable unit
 * is 15 minutes.
 *
 * The sample includes the start and excludes the end, matching the half-open
 * `[start, end)` convention used everywhere else for ranges.
 */
export function overlapsQuietHours(
  range: TimeRange,
  quiet: QuietHours | null | undefined,
): boolean {
  if (quiet === null || quiet === undefined) return false;
  if (quiet.startMinute === quiet.endMinute) return false;
  const timeZone = quiet.timeZone;

  const startMs = new Date(range.start).getTime();
  const endMs = new Date(range.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;

  const STEP_MS = 15 * 60 * 1000;
  for (let t = startMs; t < endMs; t += STEP_MS) {
    if (inQuietHours(localMinuteOfDay(new Date(t).toISOString(), timeZone), quiet)) return true;
  }
  // The instant just before the end, so a range that only clips the very start
  // of a quiet window is still caught when its length is not a multiple of the
  // step.
  return inQuietHours(localMinuteOfDay(new Date(endMs - 1).toISOString(), timeZone), quiet);
}
