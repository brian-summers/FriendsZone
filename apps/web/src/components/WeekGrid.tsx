import { useState } from 'react';
import type { CalendarView, EventView, HangoutHold, TimeRange } from '@friendszone/contracts';
import {
  GRID_HEIGHT,
  HOURS,
  HOUR_PX,
  addDays,
  formatDayOfWeek,
  formatRange,
  formatTime,
  isSameDay,
  layoutColumns,
  nowOffset,
  placeSpan,
  rangeFromDrag,
  yToMinutes,
  type Segment,
} from '../lib/time.js';
import { encodingFor, hueFor } from '../lib/visibility.js';

interface Props {
  view: CalendarView;
  weekStart: Date;
  ownerId: string;
  /**
   * Clicking a detail chip opens it. When omitted, chips are inert (used for
   * read-only contexts). Busy blocks are never clickable — they carry no
   * identity to open.
   */
  onChipActivate?: ((event: EventView) => void) | undefined;
  /** Clicking a tentative hold opens it, to accept/decline/withdraw in place. */
  onHoldActivate?: ((hold: HangoutHold) => void) | undefined;
  /**
   * Dragging (or clicking) in free space selects a time and calls this with the
   * range. What that means is the caller's business: on your own calendar it
   * opens the New Event dialog; on a friend's it opens the request composer.
   * A drag may span day columns, so the range is not confined to one day.
   */
  onRangeSelect?: ((range: TimeRange) => void) | undefined;
  /** Legend caption for the select gesture, e.g. "add an event" vs "request time". */
  rangeSelectHint?: string | undefined;
}

/** An in-progress drag, as (day, minute) endpoints that may cross columns. */
interface Drag {
  fromDay: number;
  fromMin: number;
  toDay: number;
  toMin: number;
}

/**
 * The week grid — the surface people spend nearly all their time on.
 *
 * Renders exactly what the server returned and nothing more. Two properties
 * follow from that and must survive any future edit:
 *
 *  - **Hidden events leave no trace.** There is no placeholder, no gap marker,
 *    no count of what was withheld. A withheld event has to be indistinguishable
 *    from free time, or the absence itself becomes the disclosure.
 *  - **`busy` and `details` overlap on purpose.** The server includes visible
 *    events in `busy` as well, so slot-finding is correct for a client that
 *    reads only `busy`. Here the hatched busy layer sits underneath and the
 *    detail chip covers it, which reads correctly: this time is taken, and
 *    here is what it is.
 *
 * Every interval is placed with `placeSpan`, which returns one segment per day
 * it touches — so an event that crosses midnight draws as a continuous band
 * across the columns it covers rather than being clamped into its start day.
 */
export function WeekGrid({
  view,
  weekStart,
  ownerId,
  onChipActivate,
  onHoldActivate,
  onRangeSelect,
  rangeSelectHint,
}: Props) {
  const today = new Date();
  const hue = hueFor(ownerId);
  const busyEncoding = encodingFor('BUSY');

  const [drag, setDrag] = useState<Drag | null>(null);

  // Which day column, and how far down it, a pointer sits over. Uses real
  // hit-testing so a drag can cross columns even while the pointer is captured
  // to the origin column. Returns null where the environment can't hit-test
  // (jsdom), letting the move handler fall back to vertical-only tracking.
  const resolvePoint = (
    e: React.PointerEvent<HTMLDivElement>,
  ): { dayIndex: number; min: number } | null => {
    const under = document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null;
    const dayEl = under?.closest?.('.day') as HTMLElement | null;
    if (!dayEl || dayEl.dataset.day === undefined) return null;
    const rect = dayEl.getBoundingClientRect();
    return { dayIndex: Number(dayEl.dataset.day), min: yToMinutes(e.clientY - rect.top) };
  };

  const onDayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (onRangeSelect === undefined) return;
    // A click that lands on an event (or anything interactive) is not a drag.
    if ((e.target as HTMLElement).closest('.chip')) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const day = Number(el.dataset.day);
    const min = yToMinutes(e.clientY - rect.top);
    // Capture so move/up track even if the pointer leaves the column. Guarded
    // because jsdom (and very old browsers) may not implement it.
    el.setPointerCapture?.(e.pointerId);
    setDrag({ fromDay: day, fromMin: min, toDay: day, toMin: min });
  };

  const onDayPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const point = resolvePoint(e);
    if (point !== null) {
      setDrag((d) => (d === null ? d : { ...d, toDay: point.dayIndex, toMin: point.min }));
      return;
    }
    // No hit-testing available: track vertically within the origin column.
    const rect = e.currentTarget.getBoundingClientRect();
    const min = yToMinutes(e.clientY - rect.top);
    setDrag((d) => (d === null ? d : { ...d, toMin: min }));
  };

  const finishDrag = () => {
    if (drag === null) return;
    const range = rangeFromDrag(
      { day: drag.fromDay, min: drag.fromMin },
      { day: drag.toDay, min: drag.toMin },
      weekStart,
    );
    setDrag(null);
    onRangeSelect?.(range);
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Split every interval into per-day segments once, up front. A multi-day
  // interval appears in each column it touches; a same-day one appears once.
  const busySegs = view.busy.flatMap((block, i) =>
    placeSpan(block.start, block.end, weekStart).map((seg) => ({ block, seg, i })),
  );
  const openSegs = view.openBlocks.flatMap((block, i) =>
    placeSpan(block.start, block.end, weekStart).map((seg) => ({ block, seg, i })),
  );
  const holdSegs = view.holds.flatMap((hold) =>
    placeSpan(hold.timeRange.start, hold.timeRange.end, weekStart).map((seg) => ({ hold, seg })),
  );
  const detailSegs = view.details.flatMap((event) =>
    placeSpan(event.timeRange.start, event.timeRange.end, weekStart).map((seg) => ({ event, seg })),
  );

  // The live drag rectangle, itself placed per day so a cross-day selection is
  // drawn across the columns it spans.
  const dragRange =
    drag === null
      ? null
      : rangeFromDrag(
          { day: drag.fromDay, min: drag.fromMin },
          { day: drag.toDay, min: drag.toMin },
          weekStart,
        );
  const dragSegs = dragRange === null ? [] : placeSpan(dragRange.start, dragRange.end, weekStart);

  return (
    <div className="cal-scroll">
      <div className="cal" style={hue as React.CSSProperties}>
        <div className="cal-head corner" />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={`cal-head${isSameDay(day, today) ? ' today' : ''}`}
          >
            <div className="cal-dow">{formatDayOfWeek(day)}</div>
            <div className="cal-dom">{day.getDate()}</div>
          </div>
        ))}

        <div className="gutter" style={{ height: GRID_HEIGHT }}>
          {HOURS.map((hour) => (
            <div key={hour} className="gutter-hour" style={{ height: HOUR_PX }}>
              {String(hour).padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {days.map((day, dayIndex) => {
          const isToday = isSameDay(day, today);
          const marker = isToday ? nowOffset(today) : null;

          // This day's detail segments, laid out in side-by-side columns by
          // their extent *within this day*, so overlaps pack correctly and a
          // multi-day event columns against what it shares the day with.
          const dayDetailSegs = detailSegs.filter((d) => d.seg.dayIndex === dayIndex);
          const spans = layoutColumns(
            dayDetailSegs.map((d) => ({ start: d.seg.clipStart, end: d.seg.clipEnd })),
          );

          const dragSeg = dragSegs.find((s) => s.dayIndex === dayIndex);

          return (
            <div
              key={day.toISOString()}
              className={`day${dayIndex >= 5 ? ' weekend' : ''}${
                onRangeSelect ? ' selectable' : ''
              }`}
              style={{ height: GRID_HEIGHT }}
              data-day={dayIndex}
              onPointerDown={onDayPointerDown}
              onPointerMove={onDayPointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={() => setDrag(null)}
            >
              <div className="hourlines" aria-hidden="true">
                {HOURS.map((hour) => (
                  <div key={hour} className="hourline" style={{ height: HOUR_PX }} />
                ))}
              </div>

              {marker !== null && (
                <div className="nowline" style={{ top: marker }} aria-hidden="true" />
              )}

              {dragSeg && dragRange && <DragSelection seg={dragSeg} range={dragRange} />}

              {/* Busy layer — opaque, hatched, carries no identity. */}
              {busySegs
                .filter((b) => b.seg.dayIndex === dayIndex)
                .map(({ block, seg, i }) => (
                  <div
                    key={`busy-${i}-${dayIndex}`}
                    className={`chip v-BUSY${spanClass(seg)}`}
                    style={{ top: seg.top, height: seg.height }}
                    role="img"
                    aria-label={`Unavailable, ${formatRange(block.start, block.end)}`}
                  >
                    <span className="lvl">
                      {busyEncoding.glyph} {busyEncoding.label}
                    </span>
                    {seg.height > 34 && (
                      <span className="meta">{formatRange(block.start, block.end)}</span>
                    )}
                  </div>
                ))}

              {/* Open blocks — the owner is occupied but flagged the time
                  negotiable, so it reads as "open", not a hard busy wall. */}
              {openSegs
                .filter((o) => o.seg.dayIndex === dayIndex)
                .map(({ block, seg, i }) => (
                  <div
                    key={`open-${i}-${dayIndex}`}
                    className={`chip v-OPEN${spanClass(seg)}`}
                    style={{ top: seg.top, height: seg.height }}
                    role="img"
                    aria-label={`Open to plans, ${formatRange(block.start, block.end)}`}
                  >
                    <span className="lvl">◇ Open</span>
                    {seg.height > 34 && (
                      <span className="meta">{formatRange(block.start, block.end)}</span>
                    )}
                  </div>
                ))}

              {/* Tentative holds — pending hangout slots the viewer is party to.
                  Painted before firm events so a real commitment reads on top
                  when they overlap; on free time the hold shows in full. */}
              {holdSegs
                .filter((h) => h.seg.dayIndex === dayIndex)
                .map(({ hold, seg }) => {
                  const roleLabel =
                    hold.role === 'INVITEE' ? 'a friend asked you' : 'you proposed this';
                  const ariaLabel = `${hold.title}, ${formatRange(
                    hold.timeRange.start,
                    hold.timeRange.end,
                  )}, tentative — ${roleLabel}. Open to respond.`;

                  const holdInner = (
                    <>
                      <span className="lvl">⧗ Pending</span>
                      <span className="ttl">{hold.title}</span>
                      {seg.height > 44 && (
                        <span className="meta">
                          {formatRange(hold.timeRange.start, hold.timeRange.end)}
                        </span>
                      )}
                    </>
                  );
                  const holdStyle = { top: seg.top, height: seg.height };
                  const key = `${hold.requestId}-${hold.slotIndex}-${dayIndex}`;

                  return onHoldActivate ? (
                    <button
                      key={key}
                      type="button"
                      className={`chip hold${spanClass(seg)}`}
                      style={holdStyle}
                      onClick={() => onHoldActivate(hold)}
                      aria-label={ariaLabel}
                    >
                      {holdInner}
                    </button>
                  ) : (
                    <div
                      key={key}
                      className={`chip hold${spanClass(seg)}`}
                      style={holdStyle}
                      role="img"
                      aria-label={ariaLabel}
                    >
                      {holdInner}
                    </div>
                  );
                })}

              {/* Detail layer — only what this viewer was granted. */}
              {dayDetailSegs.map(({ event, seg }, k) => {
                const enc = encodingFor(event.visibility);
                const cancelled = event.status === 'CANCELLED';
                const label = `${event.title}, ${formatRange(
                  event.timeRange.start,
                  event.timeRange.end,
                )}, shared as ${enc.label}`;

                // Owner-only: the widest level anyone else can see. Rendered as
                // a corner marker so "who can see this" is legible at a glance
                // without opening anything — the number that can actually hurt.
                const shared =
                  event.visibility === 'FULL' && event.sharedAs !== undefined
                    ? encodingFor(event.sharedAs)
                    : null;

                const ownerLabel = shared
                  ? `${event.title}, ${formatRange(
                      event.timeRange.start,
                      event.timeRange.end,
                    )}. Others see: ${shared.label}.`
                  : label;

                const inner = (
                  <>
                    <span className="lvl">
                      {enc.glyph} {enc.label}
                    </span>
                    <span className="ttl">{event.title}</span>
                    {seg.height > 46 && (
                      <span className="meta">
                        {formatRange(event.timeRange.start, event.timeRange.end)}
                        {event.visibility === 'FULL' && event.location ? ` · ${event.location}` : ''}
                      </span>
                    )}
                    {shared && (
                      <span className="seen-badge">
                        <span className="g">{shared.glyph}</span>
                        <span className="w">{shared.label}</span>
                      </span>
                    )}
                  </>
                );

                // Firm vs tentative is a distinct axis from visibility. A
                // CONFIRMED event is solid; a TENTATIVE one gets the dashed,
                // unsettled treatment so "this is not locked in" reads at a
                // glance — the same language pending holds use below.
                const tentative = event.status === 'TENTATIVE';
                const className = `chip v-${enc.level}${cancelled ? ' cancelled' : ''}${
                  tentative ? ' tentative' : ''
                }${spanClass(seg)}`;

                // Side-by-side column position within this day's overlap cluster.
                const span = spans[k] ?? { col: 0, cols: 1 };
                const gap = 2;
                const width = `calc((100% - 4px) / ${span.cols} - ${gap}px)`;
                const left = `calc(2px + (100% - 4px) * ${span.col} / ${span.cols})`;
                const style = { top: seg.top, height: seg.height, left, width, right: 'auto' as const };
                const key = `${event.id}-${dayIndex}`;

                return onChipActivate ? (
                  <button
                    key={key}
                    type="button"
                    className={className}
                    style={style}
                    onClick={() => onChipActivate(event)}
                    aria-label={`${ownerLabel} Open details.`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div
                    key={key}
                    className={className}
                    style={style}
                    role="img"
                    aria-label={ownerLabel}
                  >
                    {inner}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="cal-legend" aria-hidden="true">
        <span className="legend-item">
          <span className="legend-swatch firm" /> Firm
        </span>
        <span className="legend-item">
          <span className="legend-swatch tent" /> Tentative
        </span>
        <span className="legend-item">
          <span className="legend-swatch busyk" /> Busy
        </span>
        {view.holds.length > 0 && (
          <span className="legend-note">
            {view.holds.length} pending {view.holds.length === 1 ? 'slot' : 'slots'} — tap to respond
          </span>
        )}
        {onRangeSelect && (
          <span className="legend-note">
            Drag a free slot to {rangeSelectHint ?? 'add an event'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Squared, continuation-marked edges where a segment runs off into another day. */
function spanClass(seg: Segment): string {
  return `${seg.continuesBefore ? ' spans-before' : ''}${seg.continuesAfter ? ' spans-after' : ''}`;
}

/** The translucent rectangle shown while dragging out a new time. */
function DragSelection({ seg, range }: { seg: Segment; range: { start: string; end: string } }) {
  const label = `${formatTime(range.start)}–${formatTime(range.end)}`;
  return (
    <div className={`drag-sel${spanClass(seg)}`} style={{ top: seg.top, height: seg.height }} aria-hidden="true">
      {/* Label only on the first segment, so a multi-day selection isn't repeated. */}
      {!seg.continuesBefore && <span className="drag-sel-label">{label}</span>}
    </div>
  );
}
