import { describe, expect, it } from 'vitest';
import {
  layoutColumns,
  placeSpan,
  rangeFromDrag,
  yToMinutes,
  SNAP_MINUTES,
  DAY_START_HOUR,
  DAY_END_HOUR,
  HOUR_PX,
  quietHoursToBands,
} from './time.js';

const at = (h: number) => `2026-03-02T${String(h).padStart(2, '0')}:00:00.000Z`;

/** Day 0 of a test week, at local midnight (placeSpan reckons in local time). */
function weekStart(): Date {
  const d = new Date(2026, 2, 2);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A local ISO instant `dayOffset` days into the test week, at `hour`. */
const local = (dayOffset: number, hour: number, minute = 0): string => {
  const d = new Date(2026, 2, 2);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

describe('layoutColumns', () => {
  it('gives a lone event the full width', () => {
    expect(layoutColumns([{ start: at(9), end: at(10) }])).toEqual([{ col: 0, cols: 1 }]);
  });

  it('splits two overlapping events into two columns', () => {
    const cols = layoutColumns([
      { start: at(9), end: at(11) },
      { start: at(10), end: at(12) },
    ]);
    expect(cols).toEqual([
      { col: 0, cols: 2 },
      { col: 1, cols: 2 },
    ]);
  });

  it('keeps non-overlapping events in a single column each', () => {
    const cols = layoutColumns([
      { start: at(9), end: at(10) },
      { start: at(11), end: at(12) },
    ]);
    expect(cols).toEqual([
      { col: 0, cols: 1 },
      { col: 0, cols: 1 },
    ]);
  });

  it('reuses a freed column after an event ends (three staggered)', () => {
    // 9–10, 9–11, 10–12: max concurrency is 2, and the 10–12 reuses col 0.
    const cols = layoutColumns([
      { start: at(9), end: at(10) },
      { start: at(9), end: at(11) },
      { start: at(10), end: at(12) },
    ]);
    expect(cols.every((c) => c.cols === 2)).toBe(true);
    expect(cols[2]!.col).toBe(0); // slots back into the column the 9–10 vacated
  });

  it('preserves input order in the result', () => {
    const items = [
      { start: at(14), end: at(15) },
      { start: at(9), end: at(10) },
    ];
    const cols = layoutColumns(items);
    expect(cols).toHaveLength(2);
    // Result index matches input index, not sorted order.
    expect(cols[0]).toEqual({ col: 0, cols: 1 });
    expect(cols[1]).toEqual({ col: 0, cols: 1 });
  });
});

describe('placeSpan', () => {
  it('places a same-day interval as a single, self-contained segment', () => {
    const segs = placeSpan(local(1, 9), local(1, 11), weekStart());
    expect(segs).toHaveLength(1);
    expect(segs[0]!.dayIndex).toBe(1);
    expect(segs[0]!.continuesBefore).toBe(false);
    expect(segs[0]!.continuesAfter).toBe(false);
  });

  it('splits an interval that crosses midnight into one segment per day', () => {
    // Mon 20:00 → Wed 09:00 covers days 0, 1, 2.
    const segs = placeSpan(local(0, 20), local(2, 9), weekStart());
    expect(segs.map((s) => s.dayIndex)).toEqual([0, 1, 2]);
    // First day runs off the bottom; middle day is a continuation both ways;
    // last day runs in from the top.
    expect(segs[0]!).toMatchObject({ continuesBefore: false, continuesAfter: true });
    expect(segs[1]!).toMatchObject({ continuesBefore: true, continuesAfter: true });
    expect(segs[2]!).toMatchObject({ continuesBefore: true, continuesAfter: false });
  });

  it('clips to the visible week, marking the cut as a continuation', () => {
    // Starts the day *before* the week; only days 0 and 1 are in view.
    const segs = placeSpan(local(-1, 20), local(1, 9), weekStart());
    expect(segs.map((s) => s.dayIndex)).toEqual([0, 1]);
    expect(segs[0]!.continuesBefore).toBe(true);
  });

  it('does not draw a phantom segment for an interval ending at midnight', () => {
    const segs = placeSpan(local(0, 20), local(1, 0), weekStart());
    expect(segs.map((s) => s.dayIndex)).toEqual([0]);
    expect(segs[0]!.continuesAfter).toBe(false);
  });
});

describe('rangeFromDrag', () => {
  it('expands a click into a single default block', () => {
    const r = rangeFromDrag({ day: 2, min: 600 }, { day: 2, min: 600 }, weekStart());
    expect(Date.parse(r.end) - Date.parse(r.start)).toBe(SNAP_MINUTES * 60_000);
  });

  it('orders endpoints dragged bottom-to-top', () => {
    const r = rangeFromDrag({ day: 2, min: 660 }, { day: 2, min: 540 }, weekStart());
    expect(Date.parse(r.start)).toBeLessThan(Date.parse(r.end));
  });

  it('produces a multi-day range across columns', () => {
    const r = rangeFromDrag({ day: 1, min: 20 * 60 }, { day: 3, min: 9 * 60 }, weekStart());
    const hours = (Date.parse(r.end) - Date.parse(r.start)) / 3_600_000;
    expect(hours).toBeGreaterThan(24); // genuinely spans more than a day
  });

  it('orders a reversed cross-day drag', () => {
    const r = rangeFromDrag({ day: 3, min: 9 * 60 }, { day: 1, min: 20 * 60 }, weekStart());
    expect(new Date(r.start).getHours()).toBe(20); // earlier endpoint wins the start
    expect(Date.parse(r.start)).toBeLessThan(Date.parse(r.end));
  });
});

describe('yToMinutes', () => {
  it('snaps to the grid', () => {
    // Top of the grid = DAY_START_HOUR.
    expect(yToMinutes(0)).toBe(DAY_START_HOUR * 60);
    // A hair past one hour snaps to the nearest 30.
    expect(yToMinutes(HOUR_PX) % SNAP_MINUTES).toBe(0);
  });

  it('clamps to the visible range', () => {
    expect(yToMinutes(-500)).toBe(DAY_START_HOUR * 60);
    expect(yToMinutes(100_000)).toBe(DAY_END_HOUR * 60);
  });
});

describe('quietHoursToBands', () => {
  it('is empty when there is no window, or the window is empty', () => {
    expect(quietHoursToBands(null)).toEqual([]);
    expect(quietHoursToBands(undefined)).toEqual([]);
    expect(quietHoursToBands({ startMinute: 540, endMinute: 540 })).toEqual([]);
  });

  it('draws one band for a window inside a single day', () => {
    const bands = quietHoursToBands({ startMinute: 13 * 60, endMinute: 14 * 60 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ top: 13 * HOUR_PX, height: HOUR_PX });
  });

  it('draws TWO bands for a window that wraps midnight', () => {
    // The case the feature exists for. Treating 23:00-to-09:00 as one span
    // would compute a negative height and draw nothing, or draw it inverted.
    const bands = quietHoursToBands({ startMinute: 23 * 60, endMinute: 9 * 60 });
    expect(bands).toHaveLength(2);
    // Midnight to 09:00 at the top of the day...
    expect(bands[0]).toEqual({ top: 0, height: 9 * HOUR_PX });
    // ...and 23:00 to the end of the day at the bottom.
    expect(bands[1]).toEqual({ top: 23 * HOUR_PX, height: HOUR_PX });
  });

  it('covers the whole column when the two bands meet', () => {
    const bands = quietHoursToBands({ startMinute: 23 * 60, endMinute: 9 * 60 });
    const covered = bands.reduce((n, b) => n + b.height, 0);
    expect(covered).toBe(10 * HOUR_PX);
  });
});
