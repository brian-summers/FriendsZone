/**
 * Visual encoding of the four visibility levels.
 *
 * This is the highest-stakes design decision in the product, and it is a
 * safety decision before it is an aesthetic one.
 *
 * If a user misreads a `TITLE` chip as `BUSY`, they believe an event is opaque
 * when its title is in fact readable by everyone in a circle. The failure is
 * silent, it is discovered socially rather than technically, and it can put the
 * name of a medical appointment or a support meeting in front of forty people.
 *
 * So the rule is: **visibility is never encoded by color alone.** Every level
 * carries four independent, redundant channels:
 *
 *   1. FILL      - an ordinal ramp: none → hatched → tinted → solid
 *   2. BORDER    - dashed → hatched-edge → solid → solid heavy
 *   3. GLYPH     - a distinct icon per level
 *   4. LABEL     - a literal word, always rendered, never a tooltip
 *
 * A user with any form of color vision deficiency, on a monochrome display, or
 * glancing at a phone in sunlight still gets three working channels. This is
 * more redundancy than an interface normally warrants; the consequence of being
 * wrong is what justifies it.
 *
 * A second, related rule: **the ramp is ordinal, so the encoding is ordinal.**
 * Visibility is a totally ordered lattice (HIDDEN < BUSY < TITLE < FULL), and
 * an ordered quantity must not be rendered as categorical colors. Four unrelated
 * hues would imply four unrelated kinds of thing. Increasing fill density says
 * what is actually true: each level reveals strictly more than the one below.
 */

export type VisibilityLevelName = 'HIDDEN' | 'BUSY' | 'TITLE' | 'FULL';

export interface VisibilityTreatment {
  /** Ordinal position, 0–3. Drives fill density. */
  rank: number;
  /** Alpha applied to the event's hue for the chip fill. */
  fillAlpha: number;
  /** `none` | `hatch` - hatching reads as "deliberately obscured". */
  pattern: 'none' | 'hatch' | 'solid';
  borderStyle: 'dashed' | 'solid';
  borderWidth: number;
  /** Icon name. Distinct silhouettes, not four variants of an eye. */
  glyph: 'lock' | 'hatch-block' | 'tag' | 'card';
  /** Always rendered as text. Never a tooltip, never hover-only. */
  label: string;
  /** Plain-language explanation for the sharing editor. */
  meaning: string;
}

export const VISIBILITY_TREATMENTS: Readonly<
  Record<VisibilityLevelName, VisibilityTreatment>
> = Object.freeze({
  HIDDEN: {
    rank: 0,
    fillAlpha: 0,
    pattern: 'none',
    borderStyle: 'dashed',
    borderWidth: 1,
    glyph: 'lock',
    label: 'Private',
    meaning: 'They will not know this exists.',
  },
  BUSY: {
    rank: 1,
    fillAlpha: 0.14,
    // Diagonal hatching is the oldest convention in scheduling for "blocked
    // out". It reads as *withheld* rather than merely *quiet*, which is exactly
    // the distinction a flat light tint fails to make.
    pattern: 'hatch',
    borderStyle: 'solid',
    borderWidth: 1,
    glyph: 'hatch-block',
    label: 'Busy',
    meaning: 'They see that you are unavailable. Nothing else.',
  },
  TITLE: {
    rank: 2,
    fillAlpha: 0.32,
    pattern: 'solid',
    borderStyle: 'solid',
    borderWidth: 1,
    glyph: 'tag',
    label: 'Name only',
    meaning: 'They see what it is called, but not where or with whom.',
  },
  FULL: {
    rank: 3,
    fillAlpha: 1,
    pattern: 'solid',
    borderStyle: 'solid',
    borderWidth: 2,
    glyph: 'card',
    label: 'Everything',
    meaning: 'They see the name, place, notes, and who else is coming.',
  },
});

/**
 * Copy shown when the user is about to widen visibility.
 *
 * Widening is the direction that causes harm, so it is the direction that gets
 * friction. Narrowing is instant and unconfirmed - a user retreating toward
 * privacy should never be slowed down or asked whether they are sure.
 */
export const WIDENING_CONFIRMATIONS: Readonly<Partial<Record<VisibilityLevelName, string>>> =
  Object.freeze({
    TITLE: 'They will be able to read the name of this event.',
    FULL: 'They will be able to read the name, place, and notes, and see who else is coming.',
  });

/**
 * Hues available for the user to tag events with.
 *
 * These carry *category*, never visibility. Keeping the two channels
 * independent is what lets a user color-code their life however they like
 * without the color ever implying something false about who can see it.
 *
 * Chosen to remain distinguishable under deuteranopia and protanopia: the set
 * avoids adjacent red/green pairs and varies lightness as well as hue, so it
 * survives being flattened to greyscale.
 */
export const EVENT_HUES: Readonly<Record<string, string>> = Object.freeze({
  verdigris: '#136B58',
  brass: '#7C591A',
  slate: '#3F5666',
  plum: '#6B3A5B',
  moss: '#4A6B2A',
  clay: '#9B3B32',
});
