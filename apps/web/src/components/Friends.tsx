import { useEffect, useState } from 'react';
import type {
  FriendRequestView,
  PersonSearchResult,
  PublicProfile,
  SearchResultStatus,
} from '@friendszone/contracts';
import { MIN_SEARCH_LENGTH } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * Friends: finding people, answering requests, unfriending, and blocking.
 *
 * Two things this screen must never do, both of which look like helpful
 * features until you write down who they help:
 *
 *  - Tell you that you have been blocked. A blocked person simply cannot be
 *    found, and this screen shows exactly what the server sent: nothing. There
 *    is no "no results — you may have been blocked" hint, because that hint is
 *    the disclosure.
 *  - Tell you a request was declined. A declined request leaves no record, so
 *    "waiting" and "turned down" render identically — as nothing at all.
 *
 * The unblock copy says plainly that lifting your block does not lift theirs,
 * because a user who assumes otherwise would draw a wrong conclusion from
 * silence (docs/adr/0028-friend-requests-and-blocking.md).
 */

interface Props {
  actorId: string;
  /** Current friends, so the list reflects an accept without a full reload. */
  people: PublicProfile[];
  /** Ask the shell to refetch `/v1/people` after the graph changes. */
  onGraphChanged: () => void;
}

const STATUS_LABEL: Record<SearchResultStatus, string> = {
  NONE: 'Add friend',
  REQUESTED: 'Requested',
  AWAITING_YOU: 'Respond',
  FRIEND: 'Friends',
};

export function Friends({ actorId, people, onGraphChanged }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [requests, setRequests] = useState<FriendRequestView[]>([]);
  const [blocked, setBlocked] = useState<PublicProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = () => {
    setNonce((n) => n + 1);
    onGraphChanged();
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.friendRequests(actorId, controller.signal),
      api.blockedPeople(actorId, controller.signal),
    ])
      .then(([r, b]) => {
        if (controller.signal.aborted) return;
        setRequests(r.requests);
        setBlocked(b.blocked);
      })
      .catch(() => {
        /* An empty panel is the correct fallback; there is nothing to explain. */
      });
    return () => controller.abort();
  }, [actorId, nonce]);

  // Debounced, because search is the one rate-limited-as-EXPENSIVE endpoint and
  // a keystroke-per-request would spend the caller's own budget on themselves.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .searchPeople(q, actorId, controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return;
          setResults(r.results);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, actorId, nonce]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reload();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? `That didn’t work (${err.status}).` : 'Could not reach the API.',
      );
    }
  }

  const incoming = requests.filter((r) => !r.sentByYou);
  const outgoing = requests.filter((r) => r.sentByYou);

  return (
    <section className="settings-card">
      <h2>Friends</h2>

      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {/* ── Requests waiting on you ─────────────────────────────── */}
      {incoming.length === 0 ? null : (
        <div className="friends-group">
          <h3>Waiting on you</h3>
          <ul className="friends-list">
            {incoming.map((r) => (
              <li key={r.userId}>
                <span>
                  {r.displayName} <span className="mono muted">@{r.handle}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    onClick={() => act(() => api.respondToFriendRequest(r.userId, 'ACCEPT', actorId))}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    onClick={() =>
                      act(() => api.respondToFriendRequest(r.userId, 'DECLINE', actorId))
                    }
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Requests you sent ───────────────────────────────────── */}
      {outgoing.length === 0 ? null : (
        <div className="friends-group">
          <h3>You asked</h3>
          <p className="muted">
            They have not answered yet. You will not be told if they decide not to.
          </p>
          <ul className="friends-list">
            {outgoing.map((r) => (
              <li key={r.userId}>
                <span>
                  {r.displayName} <span className="mono muted">@{r.handle}</span>
                </span>
                <button
                  type="button"
                  className="subtle"
                  onClick={() => act(() => api.removeFriendship(r.userId, actorId))}
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Search ──────────────────────────────────────────────── */}
      <div className="friends-group">
        <h3>Find someone</h3>
        <label className="field">
          <span className="field-label">Handle or name</span>
          <input
            type="search"
            value={query}
            placeholder="e.g. carol"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {results === null ? (
          <p className="muted">
            Type at least {MIN_SEARCH_LENGTH} characters. You can search by handle or by the name
            someone chose to show.
          </p>
        ) : results.length === 0 ? (
          // Deliberately incurious. "No matches" is all anyone gets, whether the
          // handle is unused, misspelled, or belongs to someone who blocked them.
          <p className="muted">{searching ? 'Searching…' : 'No matches.'}</p>
        ) : (
          <ul className="friends-list">
            {results.map((r) => (
              <li key={r.id}>
                <span>
                  {r.displayName} <span className="mono muted">@{r.handle}</span>
                </span>
                {r.status === 'NONE' ? (
                  <button
                    type="button"
                    onClick={() => act(() => api.sendFriendRequest(r.id, actorId))}
                  >
                    Add friend
                  </button>
                ) : (
                  <span className="muted">{STATUS_LABEL[r.status]}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Your friends ────────────────────────────────────────── */}
      <div className="friends-group">
        <h3>Your friends</h3>
        {people.length === 0 ? (
          <p className="muted">Nobody yet. Search above to send your first request.</p>
        ) : (
          <ul className="friends-list">
            {people.map((p) => (
              <li key={p.id}>
                <span>
                  {p.displayName} <span className="mono muted">@{p.handle}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="subtle"
                    onClick={() => act(() => api.removeFriendship(p.id, actorId))}
                  >
                    Unfriend
                  </button>
                  <button
                    type="button"
                    className="subtle danger"
                    onClick={() => act(() => api.blockPerson(p.id, actorId))}
                  >
                    Block
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Blocked ─────────────────────────────────────────────── */}
      <div className="friends-group">
        <h3>Blocked</h3>
        <p className="muted">
          Blocking removes the friendship and hides each of you from the other. Unblocking lifts
          only your block — if they have blocked you too, that stays, and you will not be told
          either way.
        </p>
        {blocked.length === 0 ? (
          <p className="muted">Nobody.</p>
        ) : (
          <ul className="friends-list">
            {blocked.map((p) => (
              <li key={p.id}>
                <span>
                  {p.displayName} <span className="mono muted">@{p.handle}</span>
                </span>
                <button
                  type="button"
                  className="subtle"
                  onClick={() => act(() => api.unblockPerson(p.id, actorId))}
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
