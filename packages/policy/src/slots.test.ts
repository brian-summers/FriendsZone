import { describe, expect, it } from 'vitest';
import type { BusyBlock, TimeRange } from '@friendszone/contracts';
import { findFreeSlots } from './slots.js';

/**
 * A reference day in UTC, with hour bounds that span it entirely unless a test
 * says otherwise — so most cases exercise the intersection rather than the
 * working-hours clipping.
 */
const DAY: TimeRange = {
  start: '2026-03-02T00:00:00.000Z',
  end: '2026-03-03T00:00:00.000Z',
};

const at = (hour: number, minute = 0): string =>
  `2026-03-02T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

const block = (fromHour: number, toHour: number, fromMin = 0, toMin = 0): BusyBlock => ({
  start: at(fromHour, fromMin),
  end: at(toHour, toMin),
});

/** Whole-day bounds in UTC, so hour clipping is a no-op unless overridden. */
const allDay = (ms: number) => {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { dayStart, earliest: dayStart, latest: dayStart + 24 * 3_600_000 };
};

/** UTC hour bounds, for the tests that care. */
const hours = (from: number, to: number) => (ms: number) => {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    dayStart,
    earliest: dayStart + from * 3_600_000,
    latest: dayStart + to * 3_600_000,
  };
};

const find = (
  busyByParticipant: BusyBlock[][],
  durationMinutes = 60,
  dayBoundsFor = allDay,
): TimeRange[] => findFreeSlots({ window: DAY, busyByParticipant, durationMinutes, dayBoundsFor });

describe('findFreeSlots', () => {
  it('returns the whole window when nobody is busy', () => {
    expect(find([[], []])).toEqual([{ start: at(0), end: '2026-03-03T00:00:00.000Z' }]);
  });

  it('intersects across participants, not within one', () => {
    // Alice busy 09–11, Bob busy 10–12. Together they block 09–12.
    const slots = find([[block(9, 11)], [block(10, 12)]], 60);
    expect(slots).toEqual([
      { start: at(0), end: at(9) },
      { start: at(12), end: '2026-03-03T00:00:00.000Z' },
    ]);
  });

  it('drops gaps shorter than the duration asked for', () => {
    // A 30-minute hole between two blocks cannot hold an hour.
    const slots = find([[block(9, 11), block(11, 12, 30, 0)]], 60);
    expect(slots.some((s) => s.start === at(11) && s.end === at(11, 30))).toBe(false);
  });

  it('keeps a gap exactly as long as the duration', () => {
    const slots = find([[block(0, 9), block(10, 24)]], 60);
    expect(slots).toEqual([{ start: at(9), end: at(10) }]);
  });

  it('quantizes inward, so a suggestion never covers busy time', () => {
    // Busy until 09:07. Rounding the start *down* to 09:00 would suggest seven
    // minutes that are actually taken.
    const slots = find([[block(0, 9, 0, 7), block(23, 24)]], 60);
    expect(slots[0]?.start).toBe(at(9, 15));
  });

  it('quantizes the end inward too, hiding the next event’s boundary', () => {
    // Free until 17:52. Ending at 17:52 would publish that exact boundary.
    const slots = find([[block(0, 9), block(17, 24, 52, 0)]], 60);
    expect(slots[0]).toEqual({ start: at(9), end: at(17, 45) });
  });

  it('clips to the allowed hours', () => {
    const slots = find([[]], 60, hours(9, 17));
    expect(slots).toEqual([{ start: at(9), end: at(17) }]);
  });

  it('never suggests the middle of the night', () => {
    const slots = find([[block(9, 17)]], 60, hours(8, 22));
    // 08–09 is only an hour; 17–22 is five. Neither crosses into the small hours.
    expect(slots).toEqual([
      { start: at(8), end: at(9) },
      { start: at(17), end: at(22) },
    ]);
  });

  it('spans multiple days, applying hour bounds to each', () => {
    const slots = findFreeSlots({
      window: { start: '2026-03-02T00:00:00.000Z', end: '2026-03-05T00:00:00.000Z' },
      busyByParticipant: [[]],
      durationMinutes: 60,
      dayBoundsFor: hours(9, 17),
    });
    expect(slots).toHaveLength(3);
    expect(slots[0]?.start).toBe('2026-03-02T09:00:00.000Z');
    expect(slots[2]?.start).toBe('2026-03-04T09:00:00.000Z');
  });

  it('treats a participant who shares nothing as free', () => {
    // The honest cost of computing over projections: an empty projection is
    // indistinguishable from an empty calendar, which is why the interface has
    // to say so (ADR 0008).
    const alone = find([[block(9, 11)]], 60);
    const withGhost = find([[block(9, 11)], []], 60);
    expect(withGhost).toEqual(alone);
  });

  it('collapses overlapping blocks from different people', () => {
    const slots = find([[block(9, 12)], [block(10, 11)], [block(9, 10)]], 60);
    expect(slots).toEqual([
      { start: at(0), end: at(9) },
      { start: at(12), end: '2026-03-03T00:00:00.000Z' },
    ]);
  });

  it('returns nothing when someone is busy the whole window', () => {
    expect(find([[block(0, 24)], []], 60)).toEqual([]);
  });

  it('ignores busy time outside the window', () => {
    const slots = findFreeSlots({
      window: { start: at(9), end: at(17) },
      busyByParticipant: [[{ start: at(6), end: at(8) }]],
      durationMinutes: 60,
      dayBoundsFor: allDay,
    });
    expect(slots).toEqual([{ start: at(9), end: at(17) }]);
  });

  it('handles a block that straddles the window edge', () => {
    const slots = findFreeSlots({
      window: { start: at(9), end: at(17) },
      busyByParticipant: [[{ start: at(8), end: at(10) }]],
      durationMinutes: 60,
      dayBoundsFor: allDay,
    });
    expect(slots).toEqual([{ start: at(10), end: at(17) }]);
  });
});
