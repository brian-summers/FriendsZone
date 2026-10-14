import { describe, expect, it } from 'vitest';
import { localMinuteOfDay, overlapsQuietHours, visibleQuietHours } from './availability.js';
import { inQuietHours, type RelationshipKind, type UserId } from '@friendszone/contracts';

/**
 * Quiet hours, where the two things that go wrong are midnight and timezones.
 */

const LISBON = 'Europe/Lisbon';
/** 23:00 to 09:00 Lisbon: the wrapping case, and the one users actually set. */
const NIGHT = { startMinute: 23 * 60, endMinute: 9 * 60, timeZone: LISBON };
/** 13:00 to 14:00: the non-wrapping case. */
const LUNCH = { startMinute: 13 * 60, endMinute: 14 * 60, timeZone: LISBON };

const at = (iso: string) => iso;
const range = (start: string, end: string) => ({ start: at(start), end: at(end) });

describe('inQuietHours', () => {
  it('handles a window inside one day', () => {
    expect(inQuietHours(13 * 60, LUNCH)).toBe(true);
    expect(inQuietHours(13 * 60 + 59, LUNCH)).toBe(true);
    // End is exclusive, matching the half-open convention used for ranges.
    expect(inQuietHours(14 * 60, LUNCH)).toBe(false);
    expect(inQuietHours(12 * 60 + 59, LUNCH)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    // The case a naive `start <= m && m < end` gets exactly backwards.
    expect(inQuietHours(23 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(3 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(0, NIGHT)).toBe(true);
    expect(inQuietHours(8 * 60 + 59, NIGHT)).toBe(true);
    expect(inQuietHours(9 * 60, NIGHT)).toBe(false);
    expect(inQuietHours(12 * 60, NIGHT)).toBe(false);
  });

  it('treats an empty window as blocking nothing', () => {
    // "From 9 to 9" is a mistake. Reading it as all-day would lock someone out
    // of their own calendar with no obvious way back.
    const empty = { startMinute: 540, endMinute: 540, timeZone: LISBON };
    expect(inQuietHours(540, empty)).toBe(false);
    expect(inQuietHours(0, empty)).toBe(false);
  });
});

describe('localMinuteOfDay', () => {
  it('converts an instant into the window owner’s wall clock', () => {
    // 2026-01-15 is winter, so Lisbon is UTC+0 and Auckland is UTC+13.
    expect(localMinuteOfDay('2026-01-15T23:30:00.000Z', LISBON)).toBe(23 * 60 + 30);
    expect(localMinuteOfDay('2026-01-15T23:30:00.000Z', 'Pacific/Auckland')).toBe(12 * 60 + 30);
  });

  it('follows a daylight-saving shift rather than a fixed offset', () => {
    // Same clock time in UTC, six months apart: Lisbon is +0 in January and
    // +1 in July. A hard-coded offset would get one of these wrong.
    expect(localMinuteOfDay('2026-01-15T12:00:00.000Z', LISBON)).toBe(12 * 60);
    expect(localMinuteOfDay('2026-07-15T12:00:00.000Z', LISBON)).toBe(13 * 60);
  });
});

describe('overlapsQuietHours', () => {
  it('is false when there is no window', () => {
    expect(overlapsQuietHours(range('2026-01-15T02:00:00.000Z', '2026-01-15T03:00:00.000Z'), null)).toBe(
      false,
    );
    expect(
      overlapsQuietHours(range('2026-01-15T02:00:00.000Z', '2026-01-15T03:00:00.000Z'), undefined),
    ).toBe(false);
  });

  it('catches a slot wholly inside the window', () => {
    expect(
      overlapsQuietHours(range('2026-01-15T02:00:00.000Z', '2026-01-15T03:00:00.000Z'), NIGHT),
    ).toBe(true);
  });

  it('catches a slot that only clips the edge', () => {
    // 08:30 to 09:30 Lisbon: half an hour inside, half outside. A check that
    // only sampled the start or only the end would miss one of these.
    expect(
      overlapsQuietHours(range('2026-01-15T08:30:00.000Z', '2026-01-15T09:30:00.000Z'), NIGHT),
    ).toBe(true);
    expect(
      overlapsQuietHours(range('2026-01-15T22:30:00.000Z', '2026-01-15T23:30:00.000Z'), NIGHT),
    ).toBe(true);
  });

  it('allows a slot clear of the window', () => {
    expect(
      overlapsQuietHours(range('2026-01-15T12:00:00.000Z', '2026-01-15T13:00:00.000Z'), NIGHT),
    ).toBe(false);
  });

  it('is evaluated on the owner’s clock, not the proposer’s', () => {
    /**
     * The reason the zone travels with the window. 12:00 UTC is 01:00 the next
     * day in Auckland: deep inside a 23:00-to-09:00 night for someone there,
     * and the middle of the afternoon for someone in Lisbon. Same instant,
     * opposite answers.
     */
    const auckland = { ...NIGHT, timeZone: 'Pacific/Auckland' };
    const midday = range('2026-01-15T12:00:00.000Z', '2026-01-15T13:00:00.000Z');
    expect(overlapsQuietHours(midday, NIGHT)).toBe(false);
    expect(overlapsQuietHours(midday, auckland)).toBe(true);
  });

  it('catches a window narrower than the sampling step', () => {
    // The sample is every 15 minutes, so a 10-minute window could in principle
    // be stepped over. The end-of-range check is what stops that.
    const narrow = { startMinute: 13 * 60, endMinute: 13 * 60 + 10, timeZone: LISBON };
    expect(
      overlapsQuietHours(range('2026-01-15T13:05:00.000Z', '2026-01-15T13:08:00.000Z'), narrow),
    ).toBe(true);
  });

  it('catches a short window that falls between two samples of a longer slot', () => {
    // Minutes are pickable in fives (ADR 0030), so a five-minute window is a
    // real setting. Sampled every 15 minutes from 12:50, the samples land at
    // 12:50 and 13:05 and step straight over 13:00-13:05.
    const fiveMinutes = { startMinute: 13 * 60, endMinute: 13 * 60 + 5, timeZone: LISBON };
    expect(
      overlapsQuietHours(range('2026-01-15T12:50:00.000Z', '2026-01-15T14:00:00.000Z'), fiveMinutes),
    ).toBe(true);
    // A one-minute window, off any round boundary, stepped over the same way.
    const oneMinute = { startMinute: 13 * 60 + 7, endMinute: 13 * 60 + 8, timeZone: LISBON };
    expect(
      overlapsQuietHours(range('2026-01-15T12:59:30.000Z', '2026-01-15T14:00:00.000Z'), oneMinute),
    ).toBe(true);
    expect(
      overlapsQuietHours(range('2026-01-15T13:08:00.000Z', '2026-01-15T14:00:00.000Z'), oneMinute),
    ).toBe(false);
  });

  it('is false for a zero-length or inverted range', () => {
    expect(
      overlapsQuietHours(range('2026-01-15T02:00:00.000Z', '2026-01-15T02:00:00.000Z'), NIGHT),
    ).toBe(false);
  });
});

describe('visibleQuietHours', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111' as UserId;
  const OTHER = '22222222-2222-4222-8222-222222222222' as UserId;
  const as = (viewerId: UserId | null, relationship: RelationshipKind) => ({
    viewerId,
    relationship,
  });

  it('shows the window to its owner and to accepted friends', () => {
    expect(visibleQuietHours(as(OWNER, 'SELF'), OWNER, NIGHT)).toEqual(NIGHT);
    expect(visibleQuietHours(as(OTHER, 'FRIEND'), OWNER, NIGHT)).toEqual(NIGHT);
  });

  it('withholds it from a pending request, a stranger, a blocked viewer and an anonymous caller alike', () => {
    // Identical `null` for all four, so the field is no oracle for which one
    // you are - and a pending request is not yet a friendship.
    for (const viewer of [
      as(OTHER, 'PENDING'),
      as(OTHER, 'NONE'),
      as(OTHER, 'BLOCKED'),
      as(null, 'NONE'),
    ]) {
      expect(visibleQuietHours(viewer, OWNER, NIGHT)).toBeNull();
    }
  });

  it('is null when there is no window, whoever asks', () => {
    expect(visibleQuietHours(as(OWNER, 'SELF'), OWNER, null)).toBeNull();
    expect(visibleQuietHours(as(OTHER, 'FRIEND'), OWNER, undefined)).toBeNull();
  });
});
