import { useEffect, useState } from 'react';
import type { PublicProfile, ShareRule, VisibilityLevel } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import type { ThemeChoice } from '../lib/theme.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  me: PublicProfile | null;
  actorId: string;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];
const LEVELS: VisibilityLevel[] = ['HIDDEN', 'BUSY', 'TITLE', 'FULL'];
const levelLabel = (l: VisibilityLevel): string => (l === 'HIDDEN' ? 'Private' : encodingFor(l).label);

const levelOf = (rules: ShareRule[], kind: 'FRIENDS' | 'PUBLIC'): VisibilityLevel =>
  rules.find((r) => r.audience.kind === kind)?.level ?? 'HIDDEN';

/**
 * Settings.
 *
 * The default-sharing section is now a real editor. Defaults are the most-used
 * privacy control in the product — almost nobody changes per-event sharing — so
 * making them editable, in plain language, matters more than any other switch
 * on this screen.
 */
export function SettingsScreen({ me, actorId, theme, onTheme }: Props) {
  const [friends, setFriends] = useState<VisibilityLevel>('BUSY');
  const [everyone, setEveryone] = useState<VisibilityLevel>('HIDDEN');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    const controller = new AbortController();
    api
      .sharingDefaults(actorId, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setFriends(levelOf(d.rules, 'FRIENDS'));
        setEveryone(levelOf(d.rules, 'PUBLIC'));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => controller.abort();
  }, [actorId]);

  async function save() {
    setStatus('saving');
    const rules: ShareRule[] = [];
    if (friends !== 'HIDDEN') rules.push({ audience: { kind: 'FRIENDS' }, level: friends });
    if (everyone !== 'HIDDEN') rules.push({ audience: { kind: 'PUBLIC' }, level: everyone });
    try {
      await api.setSharingDefaults({ rules }, actorId);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      setStatus('error');
      void (err instanceof ApiError);
    }
  }

  return (
    <div className="settings">
      <section className="settings-card">
        <h2>Account</h2>
        {me ? (
          <dl className="detail-list">
            <dt>Name</dt>
            <dd>{me.displayName}</dd>
            <dt>Handle</dt>
            <dd className="mono">@{me.handle}</dd>
          </dl>
        ) : (
          <p className="muted">Not signed in.</p>
        )}
      </section>

      <section className="settings-card">
        <h2>Appearance</h2>
        <p className="muted">
          Follows your system by default. This choice is remembered on this device.
        </p>
        <div className="seg">
          {THEMES.map((choice) => (
            <button
              key={choice}
              type="button"
              className={theme === choice ? 'seg-on' : ''}
              aria-pressed={theme === choice}
              onClick={() => onTheme(choice)}
            >
              {choice[0]!.toUpperCase() + choice.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2>Default sharing</h2>
        <p className="muted">
          What each audience sees of an event when you don’t choose otherwise. Most events use this,
          so it is the most important privacy control in the product.
        </p>

        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <DefaultRow name="Friends" sub="Everyone you’ve added" value={friends} onChange={setFriends} />
            <DefaultRow
              name="Everyone else"
              sub="People you’re not friends with"
              value={everyone}
              onChange={setEveryone}
              warn
            />
            <div className="dialog-actions" style={{ marginTop: 'var(--space-sm)' }}>
              {status === 'saved' && <span className="expiry" style={{ marginRight: 'auto' }}>Saved.</span>}
              {status === 'error' && (
                <span className="field-error" style={{ marginRight: 'auto' }}>Couldn’t save.</span>
              )}
              <button
                type="button"
                className="btn-primary"
                disabled={status === 'saving'}
                onClick={save}
              >
                {status === 'saving' ? 'Saving…' : 'Save defaults'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-card">
        <h2>What’s here, honestly</h2>
        <ul className="honesty">
          <li>
            <span className="pill go">working</span> Week view, live per-viewer projections, creating
            and editing events, per-event and default sharing, hangouts end to end.
          </li>
          <li>
            <span className="pill warn">stub</span> Things (marketplace) — modelled and
            policy-covered, gated on moderation shipping first.
          </li>
          <li>
            <span className="pill">todo</span> Auth, persistence, circle management. The API runs on
            in-memory demo data and refuses to start in production.
          </li>
        </ul>
      </section>
    </div>
  );
}

function DefaultRow({
  name,
  sub,
  value,
  onChange,
  warn = false,
}: {
  name: string;
  sub: string;
  value: VisibilityLevel;
  onChange: (l: VisibilityLevel) => void;
  warn?: boolean;
}) {
  const meaning = value === 'HIDDEN' ? 'They will not know it exists.' : encodingFor(value).meaning;
  return (
    <div className="share-row">
      <div className="share-row-head">
        <span className="aud-name">
          {name}
          <small>{sub}</small>
        </span>
      </div>
      <div className="level-slider" role="radiogroup" aria-label={`Default for ${name}`}>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={value === l}
            className={value === l ? 'on' : ''}
            onClick={() => onChange(l)}
          >
            {levelLabel(l)}
          </button>
        ))}
      </div>
      <p className="share-consequence">
        {meaning}
        {warn && value !== 'HIDDEN' && <strong className="warn"> · anyone, not just friends</strong>}
      </p>
    </div>
  );
}
