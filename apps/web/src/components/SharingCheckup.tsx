import { useEffect, useState } from 'react';
import type { CalendarView, PublicProfile } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays, formatRange, formatDayOfWeek } from '../lib/time.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  people: PublicProfile[];
  weekStart: Date;
  actorId: string;
  onClose: () => void;
}

/**
 * "Here's what Bob can see of your week."
 *
 * The preview is produced by the server's real projection engine via
 * `/v1/me/calendar/preview`, not reconstructed on the client. That matters: a
 * client-side approximation of the visibility rules would be a second
 * implementation to keep in sync, and the moment it drifted it would be
 * reassuring a user about a state that is not true.
 *
 * The endpoint takes whose *eyes* to borrow, never whose *calendar* - the
 * calendar is always the caller's own.
 */
export function SharingCheckup({ people, weekStart, actorId, onClose }: Props) {
  const [viewerId, setViewerId] = useState<string>(people[0]?.id ?? '');
  const [view, setView] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (viewerId === '') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .previewAs(viewerId, weekStart, addDays(weekStart, 7), actorId, controller.signal)
      .then((result) => {
        setView(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(err instanceof ApiError ? `Couldn't load the preview (${err.status}).` : 'Couldn’t load the preview.');
      });

    return () => controller.abort();
  }, [viewerId, weekStart, actorId]);

  const selected = people.find((p) => p.id === viewerId);
  const name = selected?.displayName ?? 'they';

  const items = view
    ? [
        ...view.details.map((event) => ({
          key: event.id,
          when: `${formatDayOfWeek(new Date(event.timeRange.start))} ${formatRange(
            event.timeRange.start,
            event.timeRange.end,
          )}`,
          what: event.title,
          level: encodingFor(event.visibility),
        })),
      ]
    : [];

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close sharing checkup" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Sharing checkup">
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2>Sharing checkup</h2>
            <span className="when">What other people see of your week</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          <div className="preview-pick">
            <label htmlFor="checkup-person" className="side-label" style={{ margin: 0 }}>
              Preview as
            </label>
            <select
              id="checkup-person"
              value={viewerId}
              onChange={(e) => setViewerId(e.target.value)}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>

          {error !== null && (
            <div className="consequence" style={{ borderLeftColor: 'var(--madder)' }}>
              {error}
            </div>
          )}

          {error === null && (
            <div className="consequence">
              <strong>{name}</strong> sees{' '}
              {view === null
                ? '…'
                : `${view.busy.length} busy ${
                    view.busy.length === 1 ? 'block' : 'blocks'
                  } and ${view.details.length} named ${
                    view.details.length === 1 ? 'event' : 'events'
                  }`}{' '}
              this week. Everything else on your calendar is invisible to them - with no gap or
              placeholder to hint that something was withheld.
            </div>
          )}

          <div className="preview-strip">
            {loading && <span className="preview-empty">Loading…</span>}

            {!loading && items.length === 0 && (
              <span className="preview-empty">
                {view !== null && view.busy.length > 0
                  ? 'Busy blocks only - no names, places, or notes.'
                  : 'Nothing at all. Your week looks empty to them.'}
              </span>
            )}

            {!loading &&
              items.map((item) => (
                <div key={item.key} className="preview-item">
                  <span className="lab">
                    <span className="mono">{item.when}</span> · {item.what}
                  </span>
                  <span className="level-tag">
                    {item.level.glyph} {item.level.label}
                  </span>
                </div>
              ))}
          </div>

          {view !== null && view.busy.length > 0 && (
            <p className="notice" style={{ margin: 'var(--space-md) 0 0', padding: 'var(--space-sm)' }}>
              Busy blocks are merged before they are sent, so {name} cannot tell whether a stretch is
              one commitment or three.
            </p>
          )}

          <p className="notice" style={{ margin: 'var(--space-md) 0 0', padding: 'var(--space-sm)' }}>
            <strong>Not built yet:</strong> editing who sees what. The per-event sharing editor is the
            next screen - this panel is the read-only half of it.
          </p>
        </div>
      </aside>
    </>
  );
}
