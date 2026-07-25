import { useEffect, useState } from 'react';
import type { EventView, HangoutRequest, PublicProfile } from '@friendszone/contracts';
import { api } from '../lib/api.js';
import { formatDayOfWeek, formatRange } from '../lib/time.js';
import { encodingFor } from '../lib/visibility.js';
import { HangoutManage } from './HangoutManage.js';
import { SharingEditor } from './SharingEditor.js';
import { EventEditForm } from './EventEditForm.js';

interface Props {
  event: EventView;
  isOwn: boolean;
  actorId: string;
  weekStart: Date;
  peopleById: ReadonlyMap<string, PublicProfile>;
  onClose: () => void;
  /** Refetch the week after a hangout is edited, moved, or cancelled. */
  onResolved: () => void;
}

/**
 * Detail for a single event.
 *
 * It renders exactly the fields present on the `EventView` it was handed — the
 * server already decided what this viewer may see, so there is nothing to
 * filter here.
 *
 * When the event is a confirmed FIXED hangout (it carries an
 * `originHangoutRequestId`, which only its participants ever receive), the
 * drawer loads the hangout and offers in-place management — edit, reschedule,
 * cancel — right on the calendar.
 */
export function EventDrawer({
  event,
  isOwn,
  actorId,
  weekStart,
  peopleById,
  onClose,
  onResolved,
}: Props) {
  const [hangout, setHangout] = useState<HangoutRequest | null>(null);
  const [panel, setPanel] = useState<'none' | 'edit' | 'share'>('none');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const originId = event.visibility === 'FULL' ? event.originHangoutRequestId : undefined;

  useEffect(() => {
    if (originId === undefined || event.status === 'CANCELLED') {
      setHangout(null);
      return;
    }
    const controller = new AbortController();
    api
      .hangout(originId, actorId, controller.signal)
      .then((h) => {
        if (!controller.signal.aborted) setHangout(h);
      })
      .catch(() => setHangout(null));
    return () => controller.abort();
  }, [originId, actorId, event.status]);

  const when = `${formatDayOfWeek(new Date(event.timeRange.start))} · ${formatRange(
    event.timeRange.start,
    event.timeRange.end,
  )}`;

  const shownAs = encodingFor(event.visibility);
  const shared =
    event.visibility === 'FULL' && event.sharedAs !== undefined
      ? encodingFor(event.sharedAs)
      : null;

  // Per-occurrence management is offered for FIXED hangouts only; a FLOATING
  // occurrence is one of many under a standing invitation and is managed there.
  const manageable = hangout !== null && hangout.kind === 'FIXED' && hangout.status === 'ACCEPTED';

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close event details" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={event.title}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2>{event.title}</h2>
            <span className="when mono">{when}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          {event.status === 'CANCELLED' && (
            <div className="consequence" style={{ borderLeftColor: 'var(--madder)' }}>
              This event is cancelled. Only you can see it.
            </div>
          )}

          {event.visibility === 'FULL' && event.openToConflict && (
            <div className="consequence" style={{ borderLeftColor: 'var(--brass)' }}>
              <span className="level-tag">Open to plans</span> You’re marked flexible here — friends
              can request this time anyway.
            </div>
          )}

          <dl className="detail-list">
            {event.visibility === 'FULL' && event.location && (
              <>
                <dt>Where</dt>
                <dd>{event.location}</dd>
              </>
            )}
            {event.visibility === 'FULL' && event.description && (
              <>
                <dt>Notes</dt>
                <dd>{event.description}</dd>
              </>
            )}
            {event.visibility === 'FULL' && event.attendeeIds.length > 0 && (
              <>
                <dt>Who’s coming</dt>
                <dd>
                  {event.attendeeIds
                    .map((id) => peopleById.get(id)?.displayName ?? 'Someone')
                    .join(', ')}
                </dd>
              </>
            )}
          </dl>

          {isOwn ? (
            <div className="consequence">
              <strong>Who can see this.</strong>{' '}
              {shared ? (
                shared.level === 'HIDDEN' ? (
                  'Only you. No one else knows it exists.'
                ) : (
                  <>
                    The most anyone else sees is <strong>{shared.label}</strong> — {shared.meaning}
                  </>
                )
              ) : (
                'Only you.'
              )}
            </div>
          ) : (
            <div className="consequence">
              <strong>What you can see.</strong> This is shared with you as{' '}
              <strong>{shownAs.label}</strong>. {shownAs.meaning}
            </div>
          )}

          {/* Plain events you own can be edited, re-shared, or deleted here. */}
          {isOwn &&
            event.visibility === 'FULL' &&
            event.originHangoutRequestId === undefined &&
            event.status !== 'CANCELLED' && (
              <div className="manage">
                {panel === 'none' && (
                  <>
                    <p className="manage-label">Manage this event</p>
                    <div className="manage-actions">
                      <button type="button" className="icon-btn" onClick={() => setPanel('share')}>
                        Change who sees this
                      </button>
                      <button type="button" className="icon-btn" onClick={() => setPanel('edit')}>
                        Edit or delete
                      </button>
                    </div>
                  </>
                )}

                {panel === 'share' && (
                  <SharingEditor
                    eventId={event.id}
                    title={event.title}
                    initialRules={event.shareRules ?? []}
                    actorId={actorId}
                    onClose={() => setPanel('none')}
                    onSaved={onResolved}
                  />
                )}

                {panel === 'edit' && (
                  <EventEditForm
                    event={event}
                    weekStart={weekStart}
                    actorId={actorId}
                    onDone={onResolved}
                    onCancel={() => setPanel('none')}
                  />
                )}
              </div>
            )}

          {manageable && hangout !== null && event.status !== 'CANCELLED' && (
            <HangoutManage
              hangoutId={hangout.id}
              confirmed
              isOrganiser={hangout.proposerId === actorId}
              currentTitle={hangout.title}
              defaultStart={new Date(event.timeRange.start)}
              weekStart={weekStart}
              actorId={actorId}
              onDone={onResolved}
            />
          )}

          {hangout !== null && hangout.kind === 'FLOATING' && (
            <p
              className="notice"
              style={{ margin: 'var(--space-md) 0 0', padding: 'var(--space-sm)' }}
            >
              Part of a standing invitation — manage the whole series from your Inbox.
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
