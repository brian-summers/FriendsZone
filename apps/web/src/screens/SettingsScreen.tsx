import { useEffect, useState } from 'react';
import { PALETTES, PALETTE_NAMES } from '@friendszone/design-tokens';
import {
  SHARING_PRESETS,
  SharingPresetName,
  type MeView,
  type PublicProfile,
  type ShareRule,
  type SharingPresetOrCustom,
  type Discoverability,
  type VisibilityLevel,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { Circles } from '../components/Circles.js';
import { Explainer } from '../components/Explainer.js';
import type { ThemeChoice, ThemeSelection } from '../lib/theme.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  /** `MeView`, not `PublicProfile`: only your own view carries `discoverability`. */
  me: MeView | null;
  /** Friends, for circle membership. */
  people: PublicProfile[];
  actorId: string;
  theme: ThemeSelection;
  onTheme: (next: ThemeSelection) => void;
  /** The friend list lives in the shell, so changes here have to reach it. */
  onGraphChanged: () => void;
}

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];
const LEVELS: VisibilityLevel[] = ['HIDDEN', 'BUSY', 'TITLE', 'FULL'];
const levelLabel = (l: VisibilityLevel): string => (l === 'HIDDEN' ? 'Private' : encodingFor(l).label);

const levelOf = (rules: ShareRule[], kind: 'FRIENDS' | 'PUBLIC'): VisibilityLevel =>
  rules.find((r) => r.audience.kind === kind)?.level ?? 'HIDDEN';

/** Preset labels. The consequences come from contracts, defined once. */
const PRESET_LABEL: Record<SharingPresetName, string> = {
  PRIVATE: 'Private',
  BUSY_TO_FRIENDS: 'Busy to friends',
  OPEN_TO_FRIENDS: 'Open to friends',
};

/**
 * Settings.
 *
 * The default-sharing section is now a real editor. Defaults are the most-used
 * privacy control in the product — almost nobody changes per-event sharing — so
 * making them editable, in plain language, matters more than any other switch
 * on this screen.
 */
/**
 * The three findability settings, in the user's words.
 *
 * There is deliberately no "friends of friends": answering it would mean
 * walking the social graph one hop out from the searcher, which the threat
 * model relies on being impossible. A privacy *setting* that quietly built the
 * graph-traversal endpoint would be the worst possible place to add one.
 */
const DISCOVERABILITY_CHOICES: Array<{
  value: Discoverability;
  label: string;
  blurb: string;
}> = [
  {
    value: 'EVERYONE',
    label: 'Anyone can find me',
    blurb: 'You appear in search by handle or by your display name. This is the default.',
  },
  {
    value: 'EXACT_HANDLE',
    label: 'Only by my exact handle',
    blurb:
      'Someone has to type your whole handle. You will not appear in partial matches or by name — so you are found by people you gave it to, not by people scrolling.',
  },
  {
    value: 'NOBODY',
    label: 'Nobody can find me',
    blurb:
      'You never appear in search. Friends you already have are unaffected, and you can still send requests yourself.',
  },
];

export function SettingsScreen({ me, people, actorId, theme, onTheme, onGraphChanged }: Props) {
  const [discoverability, setDiscoverability] = useState<Discoverability>(
    me?.discoverability ?? 'EVERYONE',
  );
  useEffect(() => {
    if (me) setDiscoverability(me.discoverability);
  }, [me]);

  const [friends, setFriends] = useState<VisibilityLevel>('BUSY');
  const [everyone, setEveryone] = useState<VisibilityLevel>('HIDDEN');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [preset, setPreset] = useState<SharingPresetOrCustom>('BUSY_TO_FRIENDS');
  const [chosen, setChosen] = useState(true);
  const [showCustom, setShowCustom] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmHandle, setConfirmHandle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .sharingDefaults(actorId, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setFriends(levelOf(d.rules, 'FRIENDS'));
        setEveryone(levelOf(d.rules, 'PUBLIC'));
        setPreset(d.preset);
        setChosen(d.chosen);
        // A custom configuration opens its own editor; nobody should have to
        // hunt for the rules they already wrote.
        setShowCustom(d.preset === 'CUSTOM');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => controller.abort();
  }, [actorId]);

  /**
   * Presets save on click.
   *
   * No separate confirm step: tapping "Private" is the decision, and a preset
   * that needs a second button is one people leave half-applied believing it
   * took effect.
   */
  async function applyPreset(name: SharingPresetName) {
    setStatus('saving');
    try {
      const saved = await api.setSharingDefaults(
        { rules: SHARING_PRESETS[name].rules },
        actorId,
      );
      setFriends(levelOf(saved.rules, 'FRIENDS'));
      setEveryone(levelOf(saved.rules, 'PUBLIC'));
      setPreset(saved.preset);
      setChosen(saved.chosen);
      setShowCustom(false);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      setStatus('error');
      void (err instanceof ApiError);
    }
  }

  /** Straight to a file. No "we'll email it" — there is no mail delivery yet. */
  async function downloadExport() {
    setExporting(true);
    try {
      const data = await api.exportAccount(actorId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `friendszone-${data.profile.handle}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      void (err instanceof ApiError);
    } finally {
      setExporting(false);
    }
  }

  async function reallyDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAccount(confirmHandle.trim(), actorId);
      setDeleted(true);
    } catch (err: unknown) {
      setDeleteError(
        err instanceof ApiError && err.status === 409
          ? 'That handle doesn’t match. Nothing has been deleted.'
          : 'Could not delete the account.',
      );
    } finally {
      setDeleting(false);
    }
  }

  async function save() {
    setStatus('saving');
    const rules: ShareRule[] = [];
    if (friends !== 'HIDDEN') rules.push({ audience: { kind: 'FRIENDS' }, level: friends });
    if (everyone !== 'HIDDEN') rules.push({ audience: { kind: 'PUBLIC' }, level: everyone });
    try {
      const saved = await api.setSharingDefaults({ rules }, actorId);
      setPreset(saved.preset);
      setChosen(saved.chosen);
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
        <h2>
          Appearance
          <Explainer label="About appearance">
            Follows your system by default. This choice is remembered on this device.
          </Explainer>
        </h2>

        {/* Two independent choices, presented as two. Merging them into one
            list of six would mean picking Signal for its colour-vision hues
            also meant accepting whichever lighting condition it shipped with. */}
        <fieldset className="field theme-group">
          <legend className="field-label">Light or dark</legend>
          <div className="seg">
            {THEMES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={theme.mode === choice ? 'seg-on' : ''}
                aria-pressed={theme.mode === choice}
                onClick={() => onTheme({ ...theme, mode: choice })}
              >
                {choice[0]!.toUpperCase() + choice.slice(1)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="field theme-group">
          <legend className="field-label">Colours</legend>
          <div className="palette-list">
            {PALETTE_NAMES.map((name) => {
              const palette = PALETTES[name];
              const hues = theme.mode === 'dark' ? palette.huesDark : palette.huesLight;
              const on = theme.palette === name;
              return (
                <button
                  key={name}
                  type="button"
                  className={`palette-option${on ? ' palette-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onTheme({ ...theme, palette: name })}
                >
                  <span className="palette-head">
                    <strong>{palette.label}</strong>
                    {on ? <span className="palette-current">In use</span> : null}
                  </span>
                  {/* A swatch row is a preview, not the label — the name and
                      the sentence carry it, so this reads fine in monochrome. */}
                  <span className="palette-swatches" aria-hidden="true">
                    {hues.map((h) => (
                      <span
                        key={h.hex}
                        className="palette-swatch"
                        style={{ background: h.hex }}
                      />
                    ))}
                  </span>
                  <span className="palette-blurb">{palette.blurb}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      </section>

      <section className="settings-card">
        <h2>
          Finding you
          <Explainer label="About being found">
            This controls people search only. It never affects friends you already have, and
            nobody is ever told what you chose — including someone who cannot find you.
          </Explainer>
        </h2>
        <div className="palette-list">
          {DISCOVERABILITY_CHOICES.map(({ value, label, blurb }) => {
            const on = discoverability === value;
            return (
              <button
                key={value}
                type="button"
                className={`palette-option${on ? ' palette-on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  setDiscoverability(value);
                  void api.setDiscoverability(value, actorId).catch(() => undefined);
                }}
              >
                <span className="palette-head">
                  <strong>{label}</strong>
                  {on ? <span className="palette-current">In use</span> : null}
                </span>
                <span className="palette-blurb">{blurb}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Circles actorId={actorId} people={people} />

      <section className="settings-card">
        <h2>
          Your data
          <Explainer label="About your data download">
            A copy of everything you can see of your own account. It contains what you
            already have access to and nothing more — a report about you never says who
            filed it.
          </Explainer>
        </h2>
        <div className="thing-buttons">
          <button type="button" onClick={() => void downloadExport()} disabled={exporting}>
            {exporting ? 'Preparing…' : 'Download your data'}
          </button>
        </div>
      </section>

      <section className="settings-card danger-card">
        <h2>Delete your account</h2>
        <p className="muted">
          Immediate and permanent — there is no undo and no grace period. Your calendar,
          things, and photos are destroyed.
        </p>
        <p className="muted">
          Some things are kept, and it would be dishonest not to say so: blocks involving you
          (so deleting can’t be used to get around one), open moderation cases about you until
          they close, and other people’s copies of plans you shared with them.
        </p>
        {deleted ? (
          <p className="onboard-note">Your account has been deleted.</p>
        ) : (
          <>
            <label className="field">
              <span>Type your handle ({me?.handle ?? '…'}) to confirm</span>
              <input
                value={confirmHandle}
                onChange={(e) => setConfirmHandle(e.target.value)}
                placeholder={me?.handle ?? ''}
              />
            </label>
            {deleteError !== null && <p className="things-error">{deleteError}</p>}
            <div className="thing-buttons">
              <button
                type="button"
                className="danger-btn"
                disabled={confirmHandle.trim() === '' || deleting}
                onClick={() => void reallyDelete()}
              >
                {deleting ? 'Deleting…' : 'Delete my account permanently'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-card">
        <h2>
          Default sharing
          <Explainer label="About default sharing">
            What each audience sees of an event when you don’t choose otherwise. Most
            events use this, so it is the most important privacy control in the product.
          </Explainer>
        </h2>

        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {/* Shown once, as a card. Never a modal and never repeated — a
                privacy prompt that pesters is one people dismiss unread. */}
            {!chosen && (
              <p className="onboard-note">
                You haven’t chosen yet, so you’re on the most private sensible setting:
                friends see that you’re busy, and nothing more. Pick below if you’d like
                something different.
              </p>
            )}

            <div className="preset-list">
              {SharingPresetName.options.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`preset-card${preset === name ? ' preset-on' : ''}`}
                  aria-pressed={preset === name}
                  onClick={() => {
                    void applyPreset(name);
                  }}
                >
                  <strong>{PRESET_LABEL[name]}</strong>
                  <small>{SHARING_PRESETS[name].consequence}</small>
                </button>
              ))}
            </div>

            {preset === 'CUSTOM' && (
              <p className="muted">
                <strong>Custom.</strong>
                <Explainer label="What custom means">
                  Your rules don’t match one of the three above — they’re shown below
                  exactly as you set them.
                </Explainer>
              </p>
            )}

            <button
              type="button"
              className="link-btn"
              onClick={() => setShowCustom((v) => !v)}
            >
              {showCustom ? 'Hide finer control' : 'Finer control…'}
            </button>

            {showCustom && (
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
          </>
        )}
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
