import type { CalendarView, EventView, HangoutHold } from '@friendszone/contracts';
import {
  DAY_END_HOUR,
  GRID_HEIGHT,
  HOURS,
  HOUR_PX,
  addDays,
  formatDayOfWeek,
  formatRange,
  isSameDay,
  nowOffset,
  place,
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
 */
export function WeekGrid({ view, weekStart, ownerId, onChipActivate, onHoldActivate }: Props) {
  const today = new Date();
  const hue = hueFor(ownerId);
  const busyEncoding = encodingFor('BUSY');

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="cal-scroll">
      <div className="cal" style={{ ['--hue' as string]: hue }}>
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

          return (
            <div
              key={day.toISOString()}
              className={`day${dayIndex >= 5 ? ' weekend' : ''}`}
              style={{ height: GRID_HEIGHT }}
            >
              <div className="hourlines" aria-hidden="true">
                {HOURS.map((hour) => (
                  <div key={hour} className="hourline" style={{ height: HOUR_PX }} />
                ))}
              </div>

              {marker !== null && (
                <div className="nowline" style={{ top: marker }} aria-hidden="true" />
              )}

              {/* Busy layer — opaque, hatched, carries no identity. */}
              {view.busy.map((block, i) => {
                const p = place(block.start, block.end, weekStart);
                if (p.dayIndex !== dayIndex) return null;
                return (
                  <div
                    key={`busy-${i}`}
                    className="chip v-BUSY"
                    style={{ top: p.top, height: p.height }}
                    role="img"
                    aria-label={`Unavailable, ${formatRange(block.start, block.end)}`}
                  >
                    <span className="lvl">
                      {busyEncoding.glyph} {busyEncoding.label}
                    </span>
                    {p.height > 34 && (
                      <span className="meta">{formatRange(block.start, block.end)}</span>
                    )}
                  </div>
                );
              })}

              {/* Open blocks — the owner is occupied but flagged the time
                  negotiable, so it reads as "open", not a hard busy wall. */}
              {view.openBlocks.map((block, i) => {
                const p = place(block.start, block.end, weekStart);
                if (p.dayIndex !== dayIndex) return null;
                return (
                  <div
                    key={`open-${i}`}
                    className="chip v-OPEN"
                    style={{ top: p.top, height: p.height }}
                    role="img"
                    aria-label={`Open to plans, ${formatRange(block.start, block.end)}`}
                  >
                    <span className="lvl">◇ Open</span>
                    {p.height > 34 && (
                      <span className="meta">{formatRange(block.start, block.end)}</span>
                    )}
                  </div>
                );
              })}

              {/* Tentative holds — pending hangout slots the viewer is party to.
                  Painted before firm events so a real commitment reads on top
                  when they overlap; on free time the hold shows in full. */}
              {view.holds.map((hold) => {
                const p = place(hold.timeRange.start, hold.timeRange.end, weekStart);
                if (p.dayIndex !== dayIndex) return null;

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
                    {p.height > 44 && (
                      <span className="meta">
                        {formatRange(hold.timeRange.start, hold.timeRange.end)}
                      </span>
                    )}
                  </>
                );
                const holdStyle = { top: p.top, height: p.height };

                return onHoldActivate ? (
                  <button
                    key={`${hold.requestId}-${hold.slotIndex}`}
                    type="button"
                    className="chip hold"
                    style={holdStyle}
                    onClick={() => onHoldActivate(hold)}
                    aria-label={ariaLabel}
                  >
                    {holdInner}
                  </button>
                ) : (
                  <div
                    key={`${hold.requestId}-${hold.slotIndex}`}
                    className="chip hold"
                    style={holdStyle}
                    role="img"
                    aria-label={ariaLabel}
                  >
                    {holdInner}
                  </div>
                );
              })}

              {/* Detail layer — only what this viewer was granted. */}
              {view.details.map((event) => {
                const p = place(event.timeRange.start, event.timeRange.end, weekStart);
                if (p.dayIndex !== dayIndex) return null;

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
                    {p.height > 46 && (
                      <span className="meta">
                        {formatRange(event.timeRange.start, event.timeRange.end)}
                        {event.visibility === 'FULL' && event.location ? ` · ${event.location}` : ''}
                      </span>
                    )}
                    {shared && (
                      <span className="seen-badge" title={`Others see: ${shared.label}`}>
                        {shared.glyph} {shared.label}
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
                }`;
                const style = { top: p.top, height: p.height };

                return onChipActivate ? (
                  <button
                    key={event.id}
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
                    key={event.id}
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
      </div>
    </div>
  );
}
