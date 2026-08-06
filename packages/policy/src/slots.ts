import {
  SLOT_GRID_MINUTES,
  type BusyBlock,
  type TimeRange,
} from '@friendszone/contracts';
import { mergeBusyBlocks } from './projection.js';

/**
 * The slot finder's arithmetic.
 *
 * Pure, and — critically — it takes **already-projected** busy blocks. It has no
 * way to reach a raw calendar even if a caller wanted it to, which is what makes
 * the security property in docs/adr/0008-slot-finder-on-projections.md
 * structural rather than a convention:
 *
 * > No information flows that was not already flowing.
 *
 * The differential attack on aggregate queries does not apply here because there
 * is no privileged data in the computation. A requester who runs a hundred
 * queries learns exactly what a hundred ordinary calendar views would have told
 * them.
 */

const MINUTE = 60_000;

/** Round an instant up to the next grid mark. */
const ceilToGrid = (ms: number, gridMs: number): number => Math.ceil(ms / gridMs) * gridMs;

/** Round an instant down to the previous grid mark. */
const floorToGrid = (ms: number, gridMs: number): number => Math.floor(ms / gridMs) * gridMs;

/**
 * Invert a set of busy blocks within a window, yielding the gaps.
 *
 * Assumes `busy` is already merged and sorted, which `mergeBusyBlocks`
 * guarantees.
 */
function gapsWithin(window: TimeRange, busy: readonly BusyBlock[]): Array<[number, number]> {
  const windowStart = Date.parse(window.start);
  const windowEnd = Date.parse(window.end);

  const gaps: Array<[number, number]> = [];
  let cursor = windowStart;

  for (const block of busy) {
    const blockStart = Math.max(Date.parse(block.start), windowStart);
    const blockEnd = Math.min(Date.parse(block.end), windowEnd);
    if (blockEnd <= cursor) continue;
    if (blockStart > cursor) gaps.push([cursor, blockStart]);
    cursor = Math.max(cursor, blockEnd);
  }

  if (cursor < windowEnd) gaps.push([cursor, windowEnd]);
  return gaps;
}

/**
 * Clip a gap to the caller's allowed hours, in *their* local reckoning.
 *
 * Hour bounds are applied per calendar day using the supplied
 * `dayBoundsFor` — the kernel does not know what timezone anyone is in, and
 * guessing would put "evening" in the wrong place for half the participants.
 */
function withinHours(
  gap: [number, number],
  dayBoundsFor: (ms: number) => { dayStart: number; earliest: number; latest: number },
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let [start, end] = gap;

  let guard = 0;
  while (start < end && guard < 400) {
    guard += 1;
    const { dayStart, earliest, latest } = dayBoundsFor(start);
    const nextDay = dayStart + 24 * 60 * MINUTE;

    const windowStart = Math.max(start, earliest);
    const windowEnd = Math.min(end, latest);
    if (windowEnd > windowStart) out.push([windowStart, windowEnd]);

    start = Math.max(nextDay, start + MINUTE);
  }

  return out;
}

/**
 * Find every window in which *everyone* is free for `durationMinutes`.
 *
 * `busyByParticipant` is one already-projected busy set per participant. Only
 * hard `busy` intervals belong here: `openBlocks` are time their owner marked
 * overlappable and tentative holds are not commitments, so neither blocks a
 * suggestion (ADR 0008 measure 4, ADR 0011, ADR 0015).
 */
export function findFreeSlots(args: {
  window: TimeRange;
  busyByParticipant: readonly (readonly BusyBlock[])[];
  durationMinutes: number;
  /** Per-day local hour bounds. Supplied by the caller; the kernel has no clock. */
  dayBoundsFor: (ms: number) => { dayStart: number; earliest: number; latest: number };
  gridMinutes?: number;
}): TimeRange[] {
  const { window, busyByParticipant, durationMinutes, dayBoundsFor } = args;
  const gridMs = (args.gridMinutes ?? SLOT_GRID_MINUTES) * MINUTE;
  const needed = durationMinutes * MINUTE;

  // Everyone's commitments in one pile. Whose block is whose stops mattering the
  // moment they are merged, which is also why the result cannot be attributed
  // back to an individual.
  const combined = mergeBusyBlocks(busyByParticipant.flat());

  const slots: TimeRange[] = [];

  for (const gap of gapsWithin(window, combined)) {
    for (const [rawStart, rawEnd] of withinHours(gap, dayBoundsFor)) {
      // Inward rounding. Never suggests time that is actually busy, and hides
      // the exact boundary of whatever created the gap.
      const start = ceilToGrid(rawStart, gridMs);
      const end = floorToGrid(rawEnd, gridMs);
      if (end - start < needed) continue;

      slots.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      });
    }
  }

  return slots;
}
