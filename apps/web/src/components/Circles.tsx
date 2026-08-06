import { useEffect, useState } from 'react';
import type { CircleView, PublicProfile, UserId } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * Managing circles.
 *
 * A circle is the owner's private grouping of their friends, and this is the
 * only screen that shows one. Nothing here is ever rendered for a member: there
 * is no "circles you're in" call because there is no such endpoint, and adding
 * one would publish the taxonomy of someone's social life that circles exist to
 * keep private (docs/adr/0023-circle-management.md).
 *
 * The copy says so, because a user deciding what to call a group needs to know
 * whether the name is theirs alone. It is.
 */

interface Props {
  actorId: string;
  people: PublicProfile[];
}

export function Circles({ actorId, people }: Props) {
  const [circles, setCircles] = useState<CircleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    api
      .circles(actorId, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setCircles(r.circles);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => controller.abort();
  }, [actorId, nonce]);

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

  const nameOf = (id: string) => people.find((p) => p.id === id)?.displayName ?? 'A friend';

  return (
    <section className="settings-card">
      <h2>Circles</h2>
      <p className="muted">
        Private groupings of your friends, so you can share something with just the climbing
        lot. <strong>Only you ever see a circle or its name</strong> — nobody is told they’re in
        one.
      </p>

      {error !== null && (
        <p className="things-error" role="status">
          {error}
        </p>
      )}

      {loading && <p className="muted">Loading…</p>}

      {!loading && circles.length === 0 && (
        <p className="muted">No circles yet.</p>
      )}

      <div className="circle-list">
        {circles.map((circle) => (
          <div key={circle.id} className="circle-card">
            <div className="circle-head">
              <strong>{circle.name}</strong>
              <button
                type="button"
                className="link-btn"
                onClick={() => void act(() => api.deleteCircle(circle.id, actorId))}
              >
                Delete
              </button>
            </div>

            <div className="circle-members">
              {people.map((person) => {
                const member = circle.members.find((m) => m.userId === person.id);
                return (
                  <label
                    key={person.id}
                    className={`circle-chip${member !== undefined ? ' circle-chip-on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={member !== undefined}
                      onChange={() => {
                        const next = member === undefined
                          ? [...circle.members.map((m) => m.userId), person.id as UserId]
                          : circle.members
                              .filter((m) => m.userId !== person.id)
                              .map((m) => m.userId);
                        void act(() =>
                          api.updateCircle(circle.id, { memberIds: next }, actorId),
                        );
                      }}
                    />
                    <span>{person.displayName}</span>
                  </label>
                );
              })}
            </div>

            {/* Someone still on the roster who is no longer a friend. Shown
                rather than hidden: the roster is the owner's list, and quietly
                editing it would be lying to them. */}
            {circle.members.some((m) => !m.stillAFriend) && (
              <p className="side-note">
                {circle.members
                  .filter((m) => !m.stillAFriend)
                  .map((m) => nameOf(m.userId))
                  .join(', ')}{' '}
                — no longer a friend, so this circle shares nothing with them.
              </p>
            )}
          </div>
        ))}
      </div>

      {creating ? (
        <div className="circle-new">
          <input
            value={newName}
            maxLength={120}
            placeholder="Climbing crew"
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="thing-buttons">
            <button
              type="button"
              className="accent"
              disabled={newName.trim() === ''}
              onClick={() =>
                void act(async () => {
                  await api.createCircle({ name: newName.trim(), memberIds: [] }, actorId);
                  setNewName('');
                  setCreating(false);
                })
              }
            >
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="thing-buttons">
          <button type="button" onClick={() => setCreating(true)}>
            + New circle
          </button>
        </div>
      )}
    </section>
  );
}
