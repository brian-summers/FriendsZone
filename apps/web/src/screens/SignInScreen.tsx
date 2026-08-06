import { useState } from 'react';
import type { AuthResult } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';

/**
 * Sign in, or make an account.
 *
 * One deliberate restraint in the copy: a failed sign-in says "that email and
 * password don't match" and never "no account with that email". The server
 * refuses to distinguish them — same body, same status, same timing — and the
 * interface must not undo that by guessing
 * (docs/adr/0024-authentication.md).
 */

export function SignInScreen({ onSignedIn }: { onSignedIn: (who: AuthResult) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registering = mode === 'up';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const who = registering
        ? await api.register({ email, password, handle, displayName })
        : await api.login({ email, password });
      onSignedIn(who);
    } catch (err: unknown) {
      setError(
        err instanceof ApiError && err.status === 400
          ? registering
            ? 'Check the details. That email or handle may already be in use, and passwords need at least 12 characters.'
            : 'That email and password don’t match.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Give it a minute.'
            : 'Could not reach the API.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <h1 className="wordmark signin-wordmark">
          Friends<em>zone</em>
        </h1>
        <p className="signin-blurb">
          Coordinate plans with friends without the pressure of coordinating in real time.
        </p>

        <div className="seg signin-seg">
          <button
            type="button"
            className={!registering ? 'seg-on' : ''}
            aria-pressed={!registering}
            onClick={() => {
              setMode('in');
              setError(null);
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={registering ? 'seg-on' : ''}
            aria-pressed={registering}
            onClick={() => {
              setMode('up');
              setError(null);
            }}
          >
            Create account
          </button>
        </div>

        <form
          className="signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          {registering && (
            <>
              <label className="field">
                <span>Your name</span>
                <input
                  autoComplete="name"
                  maxLength={120}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Handle</span>
                <input
                  autoComplete="username"
                  maxLength={30}
                  placeholder="nina"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                />
                <small className="side-note">
                  How friends find you. Letters, digits, and . _ - only.
                </small>
              </label>
            </>
          )}

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {registering && (
              <small className="side-note">
                At least 12 characters. Length beats punctuation — a few unrelated words is a
                good password.
              </small>
            )}
          </label>

          {error !== null && (
            <p className="things-error" role="status">
              {error}
            </p>
          )}

          <button type="submit" className="accent signin-submit" disabled={busy}>
            {busy ? 'One moment…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {!registering && (
          <p className="side-note signin-foot">
            Forgotten passwords can’t be reset yet — that needs email, which isn’t built.
          </p>
        )}
      </div>
    </div>
  );
}
