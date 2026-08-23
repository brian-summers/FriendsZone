import { useEffect, useRef, useState } from 'react';
import type {
  ConversationView,
  PublicProfile,
  SendMessageInput,
  ThreadView,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * Messages - a mailbox, deliberately.
 *
 * A list on the left, a thread on the right, and a box to write in. What this
 * screen does *not* have is the vocabulary of a chat app: no presence dot, no
 * typing indicator, no "seen" tick. The server never reports whether the other
 * person has read anything, so there is nothing here that could render it even
 * by mistake.
 *
 * The unread badge is your own. It counts what *you* have not opened, and
 * opening a thread moves only your bookmark.
 */

interface Props {
  actorId: string;
  people: PublicProfile[];
  /** Pre-open a conversation with this person, from a "Message" button. */
  startWith?: string | null;
  onActivity: () => void;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function MessagesScreen({ actorId, people, startWith, onActivity }: Props) {
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [draft, setDraft] = useState('');
  const [composeTo, setComposeTo] = useState<string | null>(startWith ?? null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = () => {
    setNonce((n) => n + 1);
    onActivity();
  };
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .conversations(actorId, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setConversations(r.conversations);
      })
      .catch(() => {
        /* An empty mailbox is the correct fallback. */
      });
    return () => controller.abort();
  }, [actorId, nonce]);

  useEffect(() => {
    if (openId === null) {
      setThread(null);
      return;
    }
    const controller = new AbortController();
    api
      .thread(openId, actorId, controller.signal)
      .then(async (t) => {
        if (controller.signal.aborted) return;
        setThread(t);
        // Opening is reading. This moves *your* bookmark; the sender is never
        // told, here or anywhere.
        await api.markConversationRead(openId, actorId).catch(() => undefined);
        reload();
      })
      .catch(() => setThread(null));
    return () => controller.abort();
  }, [openId, actorId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread]);

  const open = conversations.find((c) => c.id === openId) ?? null;
  const recipientId = open?.withUserId ?? composeTo;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (body === '' || recipientId === null || recipientId === undefined) return;
    setError(null);
    try {
      const { conversationId } = await api.sendMessage(
        // The id came from a server response or the friend list, so it is a
        // real UserId; the brand is a compile-time nominal type only.
        { toUserId: recipientId as SendMessageInput['toUserId'], body },
        actorId,
      );
      setDraft('');
      setComposeTo(null);
      setOpenId(conversationId);
      reload();
      // Re-fetch the thread we just wrote into.
      setThread(await api.thread(conversationId, actorId));
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? 'You can only message people you are friends with.'
            : `That didn’t work (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  /** Friends you have no thread with yet, for starting one. */
  const startable = people.filter((p) => !conversations.some((c) => c.withUserId === p.id));

  return (
    <div className="messages">
      <aside className="mailbox">
        <div className="mailbox-head">
          <h2>Messages</h2>
          {startable.length > 0 && (
            <select
              aria-label="Start a conversation"
              value=""
              onChange={(e) => {
                setOpenId(null);
                setComposeTo(e.target.value === '' ? null : e.target.value);
              }}
            >
              <option value="">New…</option>
              {startable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          )}
        </div>

        {conversations.length === 0 && composeTo === null ? (
          <p className="muted mailbox-empty">
            No messages yet. Pick a friend from <strong>New…</strong> to start one.
          </p>
        ) : (
          <ul className="mailbox-list">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`mailbox-row${c.id === openId ? ' mailbox-on' : ''}`}
                  aria-current={c.id === openId ? 'true' : undefined}
                  onClick={() => {
                    setComposeTo(null);
                    setOpenId(c.id);
                  }}
                >
                  <span className="mailbox-row-top">
                    <strong>{c.withDisplayName}</strong>
                    <time dateTime={c.lastMessageAt}>{when(c.lastMessageAt)}</time>
                  </span>
                  <span className="mailbox-preview">
                    {c.lastMessageFromYou ? 'You: ' : ''}
                    {c.preview}
                  </span>
                  {/* Quiet, never a red pulsing badge - the same restraint the
                      inbox count uses (ADR 0007). */}
                  {c.unread > 0 && <span className="nav-count">{c.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="thread">
        {recipientId === null || recipientId === undefined ? (
          <p className="muted thread-empty">Choose a conversation.</p>
        ) : (
          <>
            <header className="thread-head">
              <h3>
                {open?.withDisplayName ??
                  people.find((p) => p.id === composeTo)?.displayName ??
                  'New message'}
              </h3>
              {open && <span className="mono muted">@{open.withHandle}</span>}
            </header>

            <div className="thread-body">
              {thread === null || thread.messages.length === 0 ? (
                <p className="muted">No messages yet.</p>
              ) : (
                thread.messages.map((m) => (
                  <div key={m.id} className={`bubble${m.mine ? ' bubble-mine' : ''}`}>
                    <p>{m.body}</p>
                    <time dateTime={m.sentAt}>{when(m.sentAt)}</time>
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>

            {error !== null && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <form className="thread-compose" onSubmit={submit}>
              <label className="sr-only" htmlFor="draft">
                Message
              </label>
              <textarea
                id="draft"
                rows={2}
                value={draft}
                maxLength={4000}
                placeholder="Write a message"
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="btn-primary" disabled={draft.trim() === ''}>
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
