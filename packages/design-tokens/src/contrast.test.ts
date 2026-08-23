import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_NORMAL, contrastRatio } from './contrast.js';
import { FOREGROUNDS, GROUNDS, type ColorScheme } from './color.js';
import { PALETTE_NAMES, PALETTES } from './palettes.js';
import { VISIBILITY_TREATMENTS, type VisibilityLevelName } from './visibility.js';

/**
 * Accessibility as a build gate.
 *
 * The rest of this repository makes security invariants structural rather than
 * procedural - a route cannot ship without an authz spec, a new action cannot
 * ship untested. Contrast gets the same treatment. "Check the contrast" is a
 * review comment people forget; a failing test is not.
 */
/** Every palette in every mode. A new palette is gated the day it is added. */
const SCHEMES: Array<[string, ColorScheme]> = PALETTE_NAMES.flatMap((name) => [
  [`${name} light`, PALETTES[name].light] as [string, ColorScheme],
  [`${name} dark`, PALETTES[name].dark] as [string, ColorScheme],
]);

describe.each(SCHEMES)('%s', (themeName, scheme: ColorScheme) => {
  it.each(GROUNDS)('every foreground meets AA on %s', (ground) => {
    for (const fg of FOREGROUNDS) {
      const ratio = contrastRatio(scheme[fg], scheme[ground]);
      expect(
        ratio,
        `${themeName}: ${fg} on ${ground} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('keeps button text legible on a filled verdigris button', () => {
    // The token exists precisely because the answer differs by theme: white
    // works in light and fails badly in dark. Hard-coding #fff would pass a
    // light-mode eyeball check and ship an unreadable dark-mode button.
    const ratio = contrastRatio(scheme.onVerdigris, scheme.verdigris);
    expect(ratio, `${themeName}: onVerdigris is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it('keeps hairlines visible without letting them shout', () => {
    // Rules must separate without competing. Too low and the calendar grid
    // dissolves; too high and it reads as a table of cells rather than a day.
    const ratio = contrastRatio(scheme.rule, scheme.ground);
    expect(ratio).toBeGreaterThanOrEqual(1.4);
    expect(ratio).toBeLessThanOrEqual(3.5);
  });

  it('meets the UI-component threshold for the primary action', () => {
    expect(contrastRatio(scheme.verdigris, scheme.ground)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe('visibility encoding', () => {
  const levels = Object.keys(VISIBILITY_TREATMENTS) as VisibilityLevelName[];

  it('never relies on color alone', () => {
    // Four independent channels. Strip any one - a monochrome display, color
    // vision deficiency, an icon that fails to load - and the level is still
    // unambiguous. See the rationale at the top of visibility.ts.
    const glyphs = new Set(levels.map((l) => VISIBILITY_TREATMENTS[l].glyph));
    const labels = new Set(levels.map((l) => VISIBILITY_TREATMENTS[l].label));
    expect(glyphs.size).toBe(levels.length);
    expect(labels.size).toBe(levels.length);
  });

  it('encodes the lattice as a strictly increasing ordinal ramp', () => {
    // Visibility is ordered, so its encoding must be ordered too. Categorical
    // hues would imply four unrelated kinds of thing rather than four degrees
    // of the same thing.
    const ranks = levels.map((l) => VISIBILITY_TREATMENTS[l].rank);
    const fills = levels.map((l) => VISIBILITY_TREATMENTS[l].fillAlpha);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(fills).toEqual([...fills].sort((a, b) => a - b));
  });

  it('gives every level a plain-language meaning', () => {
    // The sharing editor shows these verbatim. A user deciding who sees their
    // therapy appointment should not have to infer what "TITLE" means.
    for (const level of levels) {
      const { meaning } = VISIBILITY_TREATMENTS[level];
      expect(meaning.length).toBeGreaterThan(20);
      expect(meaning).toMatch(/[.!]$/);
    }
  });

  it('labels levels in the user’s words, not the schema’s', () => {
    const labels = levels.map((l) => VISIBILITY_TREATMENTS[l].label);
    expect(labels).toEqual(['Private', 'Busy', 'Name only', 'Everything']);
  });
});
