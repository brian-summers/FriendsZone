import { useEffect, useState } from 'react';
import type { HangoutHold, PublicProfile } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { formatDayOfWeek, formatRange } from '../lib/time.js';
import { HangoutManage } from './HangoutManage.js';

interface Props {
  hold: HangoutHold;
  actorId: string;
  weekStart: Date;
  peopleById: ReadonlyMap<string, PublicProfile>;
  onClose: () => void;
  /** Called after a successful accept/decline/withdraw so the week refetches. */
  onResolved: () => void;
}

/**
 * Act on a tentative hold without leaving the calendar.
 *
 * The actions offered come straight from the hold's `role`, which the server
 * computed: an invitee accepts this specific slot or declines the whole
 * request; a proposer withdraws it. There is no second lookup and no way to
 * offer an action the viewer isn't entitled to — the server would refuse it
 * anyway, but the UI never presents it.
 */
export function HoldDrawer({ hold, actorId, weekStart, peopleById, onClose, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isInvitee = hold.role === 'INVITEE';
  const otherId = isInvitee ? hold.proposerId : hold.inviteeId;
  const otherName = peopleById.get(otherId)?.displayName ?? 'a friend';
  const when = `${formatDayOfWeek(new Date(hold.timeRange.start))} · ${formatRange(
    hold.timeRange.start,
    hold.timeRange.end,
  )}`;

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onResolved();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'This was already answered. Closing.'
            : `That didn’t go through (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={hold.title}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2>{hold.title}</h2>
            <span className="when mono">{when}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          <div className="consequence">
            <span className="level-tag">⧗ Tentative</span>{' '}
            {isInvitee ? (
              <>
                <strong>{otherName}</strong> asked about this time. It’s a soft hold until you
                answer — nothing is booked yet.
              </>
            ) : (
              <>
                You proposed this time to <strong>{otherName}</strong>. It’s holding a tentative
                spot on both calendars until they answer.
              </>
            )}
          </div>

          {error !== null && (
            <div className="consequence" style={{ borderLeftColor: 'var(--madder)' }}>
              {error}
            </div>
          )}

          {isInvitee ? (
            <div className="request-actions" style={{ marginTop: 'var(--space-md)' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api.respondHangout(
                      hold.requestId,
                      { decision: 'ACCEPT', slotIndex: hold.slotIndex },
                      actorId,
                    ),
                  )
                }
              >
                {busy ? 'Booking…' : 'This time works'}
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                onClick={() =>
                  run(() => api.respondHangout(hold.requestId, { decision: 'DECLINE' }, actorId))
                }
              >
                Decline the request
              </button>
            </div>
          ) : (
            <>
              <div className="request-actions" style={{ marginTop: 'var(--space-md)' }}>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy}
                  onClick={() => run(() => api.withdrawHangout(hold.requestId, actorId))}
                >
                  Withdraw the request
                </button>
              </div>
              {/* The proposer can also edit or re-time it while it is still pending. */}
              <HangoutManage
                hangoutId={hold.requestId}
                confirmed={false}
                isOrganiser
                currentTitle={hold.title}
                defaultStart={new Date(hold.timeRange.start)}
                weekStart={weekStart}
                actorId={actorId}
                onDone={onResolved}
              />
            </>
          )}

          <p className="expiry">
            {isInvitee
              ? 'Accepting books it on both calendars. Declining needs no reason.'
              : 'Withdrawing removes the tentative hold from both calendars.'}
          </p>
        </div>
      </aside>
    </>
  );
}
