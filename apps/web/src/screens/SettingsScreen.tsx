import type { PublicProfile } from '@friendszone/contracts';
import type { ThemeChoice } from '../lib/theme.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  me: PublicProfile | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];

/**
 * Settings.
 *
 * Honest about what is real. Theme genuinely persists. The sharing-defaults
 * section shows the current conservative policy and explains it, but marks
 * itself read-only rather than faking an editor — a settings screen that looks
 * editable but silently discards changes is worse than one that admits the gap.
 */
export function SettingsScreen({ me, theme, onTheme }: Props) {
  const busy = encodingFor('BUSY');

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
          What friends see of an event when you don’t choose otherwise. This is the most important
          privacy control in the product, because most events use it.
        </p>
        <div className="aud-row">
          <span className="aud-name">
            Friends
            <small>Everyone you’ve added</small>
          </span>
          <span className="level-tag">
            {busy.glyph} {busy.label}
          </span>
        </div>
        <div className="aud-row">
          <span className="aud-name">
            Everyone else
            <small>People you’re not friends with</small>
          </span>
          <span className="level-tag">🔒 Private</span>
        </div>
        <p className="stub-note">
          Read-only for now. Editing your defaults, and per-event sharing, is the next screen —
          see docs/product/roadmap.md.
        </p>
      </section>

      <section className="settings-card">
        <h2>What’s here, honestly</h2>
        <ul className="honesty">
          <li>
            <span className="pill go">working</span> Week view, live per-viewer projections, creating
            events, the sharing checkup.
          </li>
          <li>
            <span className="pill warn">stub</span> Inbox and Things — modelled and policy-covered,
            no endpoints yet.
          </li>
          <li>
            <span className="pill">todo</span> Auth, persistence, per-event sharing editor. The API
            runs on in-memory demo data and refuses to start in production.
          </li>
        </ul>
      </section>
    </div>
  );
}
