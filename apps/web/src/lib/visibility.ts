import { VISIBILITY_TREATMENTS, type VisibilityLevelName } from '@friendszone/design-tokens';

/**
 * The four redundant channels, resolved for rendering.
 *
 * Fill and border live in CSS (`.chip.v-*`); glyph and label come from the
 * shared token package so the words a user reads are the same words the design
 * system defines. Never render fewer than all four - see the rationale in
 * `packages/design-tokens/src/visibility.ts`.
 */
const GLYPHS: Record<string, string> = {
  lock: '\u{1F512}',
  'hatch-block': '╱╱',
  tag: '▣',
  card: '■',
};

export interface ChipEncoding {
  level: VisibilityLevelName;
  glyph: string;
  label: string;
  meaning: string;
}

export function encodingFor(level: VisibilityLevelName): ChipEncoding {
  const treatment = VISIBILITY_TREATMENTS[level];
  return {
    level,
    glyph: GLYPHS[treatment.glyph] ?? '■',
    label: treatment.label,
    meaning: treatment.meaning,
  };
}

/**
 * Pick a category hue for an event.
 *
 * Category colours are not modelled in the domain yet, so this derives a stable
 * hue from the owner's id: every person's calendar reads as its own colour, and
 * your own week is internally consistent. When user-chosen categories land this
 * becomes a lookup, and nothing else changes - hue is deliberately independent
 * of the visibility channels, so it can never imply something false about who
 * can see an event.
 */
/**
 * Hue *slots*, not colour names.
 *
 * They were named for colours once - `--hue-moss`, `--hue-clay` - which stopped
 * being true the moment a second palette existed, and would have been an
 * outright lie in Signal where slot 4 is orange. Numbered slots say what these
 * actually are: six positions a palette fills however it likes.
 */
export const HUE_SLOTS = 6;

/** The fill for a calendar, and the text colour that is legible on it. */
export interface HueVars {
  '--hue': string;
  '--on-hue': string;
}

export function hueFor(ownerId: string): HueVars {
  let hash = 0;
  for (let i = 0; i < ownerId.length; i += 1) {
    hash = (hash * 31 + ownerId.charCodeAt(i)) >>> 0;
  }
  // 1-based, matching the CSS custom property names.
  const slot = (hash % HUE_SLOTS) + 1;
  return { '--hue': `var(--hue-${slot})`, '--on-hue': `var(--on-hue-${slot})` };
}
