import { useEffect, useState } from 'react';
import type {
  FriendRequestView,
  PersonSearchResult,
  PublicProfile,
  SearchResultStatus,
} from '@friendszone/contracts';
import { MIN_SEARCH_LENGTH } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { Explainer } from '../components/Explainer.js';

/**
 * People - finding, adding, and answering.
 *
 * This used to live inside Settings, which was the wrong place twice over.
 * Adding a friend is the first thing a new account needs to do, and answering
 * a request is time-sensitive in the mild way this product allows: burying
 * both behind a settings menu meant a request could sit unseen for a week.
 *
 * Two things this screen must never do, both of which look helpful:
 *
 *  - Suggest that an empty result might mean you were blocked. It shows what
 *    the server sent, which is nothing, with no hint that a second explanation
 *    exists. Someone who has set themselves unfindable is indistinguishable
 *    from a handle nobody has.
 *  - Report that a request was declined. Declining deletes the row, so
 *    "waiting" and "turned down" render identically - as nothing at all.
 */

interface Props {
  actorId: string;
  people: PublicProfile[];
  onGraphChanged: () => void;
  /** Open a conversation with this person. */
  onMessage: (userId: string) => void;
}

const STATUS_LABEL: Record<SearchResultStatus, string> = {
  NONE: 'Add friend',
  REQUESTED: 'Requested',
  AWAITING_YOU: 'Answer below',
  FRIEND: 'Already friends',
};

export function PeopleScreen({ actorId, people, onGraphChanged, onMessage }: Props) {
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

  // Debounced: search is the one `EXPENSIVE`-classed endpoint, and a request
  // per keystroke would spend the caller's own rate budget on themselves.
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
    <div className="people-screen">
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {/* Requests first, and above the fold. Someone waiting on you is the
          most time-sensitive thing this screen has to say. */}
      {incoming.length > 0 && (
        <section className="settings-card people-requests">
          <h2>
            {incoming.length === 1 ? 'Someone wants to connect' : `${incoming.length} people want to connect`}
          </h2>
          <ul className="friends-list">
            {incoming.map((r) => (
              <li key={r.userId}>
                <span>
                  {r.displayName} <span className="mono muted">@{r.handle}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="btn-primary"
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
        </section>
      )}

      <section className="settings-card">
        <h2>
          Find people
          <Explainer label="About finding people">
            You can search by handle, or by the name someone chose to show. People choose how
            findable they are, so not everyone appears in every search.
          </Explainer>
        </h2>

        <label className="field">
          <span className="field-label">Handle or name</span>
          <input
            type="search"
            value={query}
            placeholder="e.g. carol"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {results === null ? (
          <p className="muted">Type at least {MIN_SEARCH_LENGTH} characters.</p>
        ) : results.length === 0 ? (
          // Deliberately incurious. "No matches" is all anyone gets, whether
          // the handle is unused, misspelled, set to unfindable, or belongs to
          // someone who blocked them.
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
                    className="btn-primary"
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
      </section>

      {outgoing.length > 0 && (
        <section className="settings-card">
          <h2>You asked</h2>
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
        </section>
      )}

      <section className="settings-card">
        <h2>Your friends</h2>
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
                  <button type="button" onClick={() => onMessage(p.id)}>
                    Message
                  </button>
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
      </section>

      <section className="settings-card">
        <h2>Blocked</h2>
        <p className="muted">
          Blocking removes the friendship, hides each of you from the other, and ends any
          conversation you had. Unblocking lifts only your block - if they have blocked you too,
          that stays, and you will not be told either way.
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
      </section>
    </div>
  );
}
