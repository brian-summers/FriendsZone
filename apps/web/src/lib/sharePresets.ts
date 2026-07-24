import type { ShareRule, VisibilityLevel } from '@friendszone/contracts';

/**
 * Sharing presets, in user language.
 *
 * The domain model lets you compose arbitrary per-audience rules, but a
 * creation form that exposed the full lattice would be a privacy footgun — the
 * most important control in the product should be a short list of understood
 * choices, not a rule builder. The per-event editor (not yet built) is where
 * finer control will live; here we offer the safe, legible options.
 *
 * Every preset states its consequence in the second person, and the list is
 * ordered from most private to most open so that scanning down it reads as
 * "revealing progressively more".
 */
export interface SharePreset {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
  readonly ceiling: VisibilityLevel;
  readonly rules: ShareRule[];
  /** The level this preset summarises as, for the who-can-see-this badge. */
  readonly widest: VisibilityLevel;
}

export const SHARE_PRESETS: readonly SharePreset[] = [
  {
    id: 'private',
    label: 'Only me',
    consequence: 'No one else will know this exists.',
    // The ceiling does the hiding, so even your default sharing cannot leak it.
    ceiling: 'HIDDEN',
    rules: [],
    widest: 'HIDDEN',
  },
  {
    id: 'busy',
    label: 'Friends see I’m busy',
    consequence: 'Friends see an unavailable block — no name, place, or notes.',
    ceiling: 'FULL',
    rules: [{ audience: { kind: 'FRIENDS' }, level: 'BUSY' }],
    widest: 'BUSY',
  },
  {
    id: 'title',
    label: 'Friends see the name',
    consequence: 'Friends see what it’s called, but not where or with whom.',
    ceiling: 'FULL',
    rules: [{ audience: { kind: 'FRIENDS' }, level: 'TITLE' }],
    widest: 'TITLE',
  },
  {
    id: 'full',
    label: 'Friends see everything',
    consequence: 'Friends see the name, place, notes, and other guests.',
    ceiling: 'FULL',
    rules: [{ audience: { kind: 'FRIENDS' }, level: 'FULL' }],
    widest: 'FULL',
  },
  {
    id: 'public',
    label: 'Anyone can see the name',
    consequence: 'Anyone, even people you’re not friends with, sees the name.',
    ceiling: 'FULL',
    rules: [{ audience: { kind: 'PUBLIC' }, level: 'TITLE' }],
    widest: 'TITLE',
  },
];

export const presetById = (id: string): SharePreset =>
  SHARE_PRESETS.find((p) => p.id === id) ?? SHARE_PRESETS[1]!;
