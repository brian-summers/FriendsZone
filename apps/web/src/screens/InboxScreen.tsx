import { useEffect, useMemo, useState } from 'react';
import {
  overlaps,
  type BusyBlock,
  type HangoutRequest,
  type HangoutRequestStatus,
  type Notification,
  type PublicProfile,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { formatDayOfWeek, formatRange } from '../lib/time.js';

interface Props {
  actorId: string;
  peopleById: ReadonlyMap<string, PublicProfile>;
  onActivity: () => void;
}

type Tab = 'received' | 'sent';

const nameOf = (id: string, people: ReadonlyMap<string, PublicProfile>): string =>
  people.get(id)?.displayName ?? 'Someone';

const STATUS_COPY: Record<HangoutRequestStatus, string> = {
  PENDING: 'Waiting',
  ACCEPTED: 'On the calendar',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'No longer needs an answer',
  CANCELLED: 'Cancelled',
};

function expiryLine(iso: string): string {
  const d = new Date(iso);
  // A date, never a countdown — see ADR 0007. "In 2 days" is a deadline.
  return `No longer needs an answer after ${d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

/**
 * The inbox — requests you received, and the ones you sent.
 *
 * Deliberately absent: any "seen" or "new since" state. Requests do not announce
 * that you've looked at them, and nothing here nudges. Expiry is shown as a
 * date. This is the async promise of the product made literal — see ADR 0007.
 */
export function InboxScreen({ actorId, peopleById, onActivity }: Props) {
  const [tab, setTab] = useState<Tab>('received');
  const [received, setReceived] = useState<HangoutRequest[]>([]);
  const [sent, setSent] = useState<HangoutRequest[]>([]);
  const [ownBusy, setOwnBusy] = useState<BusyBlock[]>([]);
  const [updates, setUpdates] = useState<Notification[]>([]);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => setNonce((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);

    // A 3-week window is enough to annotate the demo's proposed slots against
    // your own commitments; real slots rarely land further out.
    const start = new Date();
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 21);

    Promise.all([
      api.received(actorId, controller.signal),
      api.sent(actorId, controller.signal),
      api.calendar(actorId, start, end, actorId, controller.signal).catch(() => null),
      api.notifications(actorId, controller.signal).catch(() => ({ notifications: [] })),
    ])
      .then(([recv, out, cal, notes]) => {
        if (controller.signal.aborted) return;
        setReceived(recv.requests);
        setSent(out.requests);
        setOwnBusy(cal?.busy ?? []);
        setUpdates(notes.notifications);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? `Couldn't load your inbox (${err.status}).`
            : 'Could not reach the API.',
        );
      });

    return () => controller.abort();
  }, [actorId, nonce]);

  const pendingReceived = received.filter((r) => r.status === 'PENDING').length;

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
      onActivity();
    } catch {
      setError('That didn’t go through. It may have already been answered — refreshing.');
      refresh();
    }
  }

  const list = tab === 'received' ? received : sent;

  return (
    <div className="inbox">
      <div className="inbox-head">
        <div className="seg">
          <button
            type="button"
            className={tab === 'received' ? 'seg-on' : ''}
            aria-pressed={tab === 'received'}
            onClick={() => setTab('received')}
          >
            Received{pendingReceived > 0 ? ` · ${pendingReceived}` : ''}
          </button>
          <button
            type="button"
            className={tab === 'sent' ? 'seg-on' : ''}
            aria-pressed={tab === 'sent'}
            onClick={() => setTab('sent')}
          >
            Sent
          </button>
        </div>
      </div>

      {error !== null && <p className="notice">{error}</p>}

      {updates.length > 0 && (
        <section className="updates">
          <p className="side-label">Recent updates</p>
          <ul className="update-list">
            {updates.slice(0, 8).map((n) => (
              <li key={n.id} className="update-item">
                <span className="update-dot" data-kind={n.kind} aria-hidden="true" />
                <span className="update-text">
                  <strong>{nameOf(n.actorId, peopleById)}</strong> {n.summary}
                </span>
                <span className="update-when mono">
                  {new Date(n.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {list.length === 0 && (
        <div className="placeholder">
          <h2>{tab === 'received' ? 'Nothing waiting' : 'Nothing sent'}</h2>
          <p>
            {tab === 'received'
              ? 'When a friend proposes a time, it lands here. No rush to answer — that’s the point.'
              : 'Open a friend’s calendar and use “Request time” to propose some options.'}
          </p>
        </div>
      )}

      <div className="request-list">
        {list.map((req) =>
          tab === 'received' ? (
            <ReceivedCard
              key={req.id}
              request={req}
              proposerName={nameOf(req.proposerId, peopleById)}
              ownBusy={ownBusy}
              onAccept={(slotIndex) =>
                act(() => api.respondHangout(req.id, { decision: 'ACCEPT', slotIndex }, actorId))
              }
              onDecline={() =>
                act(() => api.respondHangout(req.id, { decision: 'DECLINE' }, actorId))
              }
              onBook={(startIso) =>
                act(() => api.bookOccurrence(req.id, { start: startIso }, actorId))
              }
            />
          ) : (
            <SentCard
              key={req.id}
              request={req}
              inviteeName={nameOf(req.inviteeIds[0] ?? '', peopleById)}
              onWithdraw={() => act(() => api.withdrawHangout(req.id, actorId))}
            />
          ),
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: HangoutRequestStatus }) {
  const tone =
    status === 'ACCEPTED' ? 'go' : status === 'PENDING' ? 'wait' : 'muted';
  return <span className={`status-pill ${tone}`}>{STATUS_COPY[status]}</span>;
}

function ReceivedCard({
  request,
  proposerName,
  ownBusy,
  onAccept,
  onDecline,
  onBook,
}: {
  request: HangoutRequest;
  proposerName: string;
  ownBusy: BusyBlock[];
  onAccept: (slotIndex: number) => void;
  onDecline: () => void;
  onBook: (startIso: string) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [bookAt, setBookAt] = useState('');
  const pending = request.status === 'PENDING';

  // A FLOATING invitation: book an occurrence anywhere inside its period.
  if (request.kind === 'FLOATING' && request.period) {
    const toLocalInput = (iso: string) => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return (
      <article className="request">
        <div className="request-top">
          <h3>
            <strong>{proposerName}</strong> is open to {request.title}
          </h3>
          <StatusPill status={request.status} />
        </div>
        {request.note && <p className="request-note">“{request.note}”</p>}
        <p className="request-loc">
          Anytime between {formatDayOfWeek(new Date(request.period.start))} and{' '}
          {formatDayOfWeek(new Date(request.period.end))} · {request.occurrenceMinutes ?? 60} min ·
          book it as often as you like
        </p>

        {pending ? (
          <div className="book-row">
            <input
              type="datetime-local"
              value={bookAt}
              min={toLocalInput(request.period.start)}
              max={toLocalInput(request.period.end)}
              onChange={(e) => setBookAt(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={bookAt === ''}
              onClick={() => bookAt !== '' && onBook(new Date(bookAt).toISOString())}
            >
              Book a time
            </button>
          </div>
        ) : (
          <p className="expiry">{STATUS_COPY[request.status]}</p>
        )}
      </article>
    );
  }

  return (
    <article className="request">
      <div className="request-top">
        <h3>
          <strong>{proposerName}</strong> asked about {request.title}
        </h3>
        <StatusPill status={request.status} />
      </div>
      {request.note && <p className="request-note">“{request.note}”</p>}
      {request.location && <p className="request-loc mono">{request.location}</p>}

      <ul className="slots" role={pending ? 'radiogroup' : undefined} aria-label="Proposed times">
        {request.proposedSlots.map((slot, i) => {
          const clash = ownBusy.some((b) => overlaps(slot, b));
          const chosen = picked === i;
          return (
            <li key={i}>
              <button
                type="button"
                className={`slot ${chosen ? 'picked' : ''}`}
                role={pending ? 'radio' : undefined}
                aria-checked={pending ? chosen : undefined}
                disabled={!pending}
                onClick={() => setPicked(i)}
              >
                <span className="slot-when mono">
                  {formatDayOfWeek(new Date(slot.start))} · {formatRange(slot.start, slot.end)}
                </span>
                <span className={`slot-state ${clash ? 'busy' : 'free'}`}>
                  {clash ? 'you’re busy' : 'you’re free'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {pending ? (
        <>
          <div className="request-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={picked === null}
              onClick={() => picked !== null && onAccept(picked)}
            >
              Works for me
            </button>
            <button type="button" className="icon-btn" onClick={onDecline}>
              None of these
            </button>
          </div>
          <p className="expiry">{expiryLine(request.expiresAt)}</p>
        </>
      ) : (
        <p className="expiry">
          {request.status === 'ACCEPTED'
            ? 'Booked — it’s on your calendar.'
            : STATUS_COPY[request.status]}
        </p>
      )}
    </article>
  );
}

function SentCard({
  request,
  inviteeName,
  onWithdraw,
}: {
  request: HangoutRequest;
  inviteeName: string;
  onWithdraw: () => void;
}) {
  const pending = request.status === 'PENDING';
  return (
    <article className="request">
      <div className="request-top">
        <h3>
          You asked <strong>{inviteeName}</strong> about {request.title}
        </h3>
        <StatusPill status={request.status} />
      </div>

      <ul className="slots" aria-label="Proposed times">
        {request.proposedSlots.map((slot, i) => (
          <li key={i}>
            <div className="slot static">
              <span className="slot-when mono">
                {formatDayOfWeek(new Date(slot.start))} · {formatRange(slot.start, slot.end)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {pending ? (
        <div className="request-actions">
          <button type="button" className="icon-btn" onClick={onWithdraw}>
            Withdraw
          </button>
          <span className="expiry">{expiryLine(request.expiresAt)}</span>
        </div>
      ) : (
        <p className="expiry">
          {request.status === 'ACCEPTED'
            ? `${inviteeName} picked a time — it’s on your calendar.`
            : STATUS_COPY[request.status]}
        </p>
      )}
    </article>
  );
}
