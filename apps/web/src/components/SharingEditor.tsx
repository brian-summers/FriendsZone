import { useMemo, useState } from 'react';
import type { ShareRule, VisibilityLevel } from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { encodingFor } from '../lib/visibility.js';

interface Props {
  eventId: string;
  title: string;
  /** The event's own rules (empty means it currently follows your defaults). */
  initialRules: ShareRule[];
  actorId: string;
  onClose: () => void;
  onSaved: () => void;
}

/** Ordinal, low → high. The control is a slider because the lattice is ordered. */
const LEVELS: VisibilityLevel[] = ['HIDDEN', 'BUSY', 'TITLE', 'FULL'];
const rank = (l: VisibilityLevel) => LEVELS.indexOf(l);

/** Per-audience wording - "Private" reads better than "Hidden" for a person. */
const levelLabel = (l: VisibilityLevel): string =>
  l === 'HIDDEN' ? 'Private' : encodingFor(l).label;

const levelFor = (rules: ShareRule[], kind: 'FRIENDS' | 'PUBLIC'): VisibilityLevel => {
  const found = rules.find((r) => r.audience.kind === kind);
  return found ? found.level : 'HIDDEN';
};

/**
 * Change who sees an event.
 *
 * This is the screen the product is really about, so it is careful:
 *
 *  - Audiences are **rows**, levels an **ordinal slider** - the lattice is
 *    ordered, so the control says so.
 *  - Each choice states its **consequence** in plain words, not the schema's
 *    vocabulary.
 *  - **Circle rules are preserved.** The client has no circle list, so it edits
 *    only the Friends and Everyone rows and leaves any circle grants untouched
 *    rather than silently dropping them.
 *  - It never computes visibility itself - it writes rules and lets the server's
 *    projection be the source of truth. Reopening the event shows the result.
 */
export function SharingEditor({
  eventId,
  title,
  initialRules,
  actorId,
  onClose,
  onSaved,
}: Props) {
  const [friends, setFriends] = useState<VisibilityLevel>(() => levelFor(initialRules, 'FRIENDS'));
  const [everyone, setEveryone] = useState<VisibilityLevel>(() => levelFor(initialRules, 'PUBLIC'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inherits = initialRules.length === 0;

  // Rules we don't edit (circles, self) survive the save untouched.
  const preserved = useMemo(
    () => initialRules.filter((r) => r.audience.kind !== 'FRIENDS' && r.audience.kind !== 'PUBLIC'),
    [initialRules],
  );

  const nextRules = (): ShareRule[] => {
    const rules = [...preserved];
    if (friends !== 'HIDDEN') rules.push({ audience: { kind: 'FRIENDS' }, level: friends });
    if (everyone !== 'HIDDEN') rules.push({ audience: { kind: 'PUBLIC' }, level: everyone });
    return rules;
  };

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const rules = nextRules();
    // No rule at all means "private": clamp with a HIDDEN ceiling so it does not
    // fall through to your defaults. Otherwise the rules do the limiting.
    const visibilityCeiling: VisibilityLevel = rules.length === 0 ? 'HIDDEN' : 'FULL';
    try {
      await api.updateEvent(eventId, { shareRules: rules, visibilityCeiling }, actorId);
      onSaved();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError ? `Couldn’t save (${err.status}).` : 'Could not reach the API.',
      );
    }
  }

  const widening =
    rank(friends) > rank(levelFor(initialRules, 'FRIENDS')) ||
    rank(everyone) > rank(levelFor(initialRules, 'PUBLIC'));

  return (
    <div className="share-editor">
      <p className="manage-label">Who can see “{title}”?</p>
      {inherits && (
        <div className="consequence">
          This event currently follows your default sharing. Setting anything here makes its
          sharing explicit.
        </div>
      )}

      <AudienceRow name="Friends" sub="Everyone you’ve added" value={friends} onChange={setFriends} />
      <AudienceRow
        name="Everyone else"
        sub="People you’re not friends with"
        value={everyone}
        onChange={setEveryone}
        warnAbovePrivate
      />

      {preserved.length > 0 && (
        <p className="hint-note">Circle-specific sharing on this event is kept as-is.</p>
      )}

      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="dialog-actions" style={{ marginTop: 'var(--space-md)' }}>
        <button type="button" className="icon-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : widening ? 'Share more' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function AudienceRow({
  name,
  sub,
  value,
  onChange,
  warnAbovePrivate = false,
}: {
  name: string;
  sub: string;
  value: VisibilityLevel;
  onChange: (l: VisibilityLevel) => void;
  warnAbovePrivate?: boolean;
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
      <div className="level-slider" role="radiogroup" aria-label={`What ${name} can see`}>
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
        {warnAbovePrivate && value !== 'HIDDEN' && (
          <strong className="warn"> · anyone, not just friends</strong>
        )}
      </p>
    </div>
  );
}
