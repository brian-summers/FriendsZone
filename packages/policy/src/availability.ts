import type { QuietHours, TimeRange, UserId } from '@friendszone/contracts';
import { inQuietHours } from '@friendszone/contracts';
import type { ViewerContext } from './viewer.js';

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

/**
 * One formatter per zone. Constructing an `Intl.DateTimeFormat` costs far more
 * than using one, and a single check can take hundreds of samples. A cache of
 * deterministic objects keyed by an input is memoisation, not ambient state:
 * the answer for a given instant and zone never depends on what is in it.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Minutes from local midnight for `instant`, in `timeZone`. */
export function localMinuteOfDay(instant: string, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Whether any part of `range` falls inside the owner's quiet hours.
 *
 * Sampled rather than solved analytically. That is a deliberate trade: the
 * window wraps midnight, ranges can span days, and timezones have DST
 * transitions where a local hour repeats or does not exist at all. A
 * closed-form answer would have to model all three, and would be wrong in the
 * cases nobody tests.
 *
 * **The step is the window's own length, capped at 15 minutes.** A window L
 * minutes long is an interval of L real minutes, and a sequence of samples
 * spaced at most L apart cannot step over an interval that long - so a window
 * lying wholly inside the range is always hit, and one that only overlaps an
 * end is hit by the first or last sample. A fixed 15-minute step was exact
 * only while times came in quarter hours; minutes are now pickable in fives
 * (ADR 0030), and a five-minute window between two samples was missed.
 *
 * The cost stays bounded: the walk stops at the first hit, and a non-empty
 * daily window is reached within a day, so even a range years long takes at
 * most a day of samples.
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

  const windowMinutes = (quiet.endMinute - quiet.startMinute + 1440) % 1440;
  const STEP_MS = Math.min(15, Math.max(1, windowMinutes)) * 60 * 1000;
  for (let t = startMs; t < endMs; t += STEP_MS) {
    if (inQuietHours(localMinuteOfDay(new Date(t).toISOString(), timeZone), quiet)) return true;
  }
  // The instant just before the end, so a range that only clips the very start
  // of a quiet window is still caught when its length is not a multiple of the
  // step.
  return inQuietHours(localMinuteOfDay(new Date(endMs - 1).toISOString(), timeZone), quiet);
}

/**
 * The owner's quiet hours as `viewer` is allowed to know them, or `null`.
 *
 * The owner and accepted friends see the window; a stranger, a blocked viewer
 * and an anonymous caller all get `null`, so the field cannot tell those three
 * apart (ADR 0030). `PENDING` is not `FRIEND`: asking to be someone's friend
 * does not show you when they sleep.
 *
 * **This is also what enforcement checks against.** A proposal is refused for
 * landing in a window only when the proposer is shown that window. Refusing on
 * a window they are not shown would turn every proposal route into a way to
 * map it, one rejected time at a time - which matters for a handoff, where the
 * other party can be someone who claimed a `PUBLIC` listing and is no friend.
 */
export function visibleQuietHours(
  viewer: Pick<ViewerContext, 'viewerId' | 'relationship'>,
  ownerId: UserId,
  quiet: QuietHours | null | undefined,
): QuietHours | null {
  const isOwner = viewer.viewerId !== null && viewer.viewerId === ownerId;
  return isOwner || viewer.relationship === 'FRIEND' ? (quiet ?? null) : null;
}
