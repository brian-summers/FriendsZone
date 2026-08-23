import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_NORMAL, contrastRatio } from './contrast.js';
import { deltaE, simulate, VISION_TYPES, worstPair } from './cvd.js';
import {
  CHIP_EDGE_HUE_RATIO,
  CVD_SAFE_PALETTES,
  MIN_HUE_SEPARATION,
  PALETTE_NAMES,
  PALETTES,
  SAFE_HUE_SEPARATION,
  type Palette,
} from './palettes.js';

/**
 * Colour vision deficiency as a build gate.
 *
 * The contrast tests next door make legibility structural. These make
 * *distinguishability* structural, which is the failure a sighted reviewer
 * cannot catch by looking - the whole point being that the person reviewing the
 * palette can see the difference perfectly well.
 */

/** `color-mix(in srgb, a X%, b)`, mirroring what the stylesheet computes. */
function mixSrgb(a: string, b: string, ratio: number): string {
  const channels = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [ca, cb] = [channels(a), channels(b)];
  return `#${ca
    .map((v, i) => Math.round(v * ratio + cb[i]! * (1 - ratio)).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

const modes = (p: Palette) =>
  [
    ['light', p.light, p.huesLight],
    ['dark', p.dark, p.huesDark],
  ] as const;

describe('the simulation itself', () => {
  it('leaves colour unchanged for normal vision', () => {
    expect(simulate('#D55E00', 'normal')).toBe('#D55E00');
  });

  it('collapses red and green for a deuteranope', () => {
    // The sanity check on the matrices. Pure red and pure green are maximally
    // different to normal vision and nearly identical without the M cone; if
    // this ever stops being true, the matrices have been broken.
    expect(deltaE('#FF0000', '#00FF00')).toBeGreaterThan(100);
    expect(deltaE(simulate('#FF0000', 'deuteranopia'), simulate('#00FF00', 'deuteranopia'))).toBeLessThan(
      40,
    );
  });

  it('reproduces the defect that motivated this file', () => {
    // The shipped palette's `moss` and `clay`. ΔE 0.6 under deuteranopia -
    // below the ~2.3 just-noticeable difference, so they were the same colour
    // for roughly 1 in 12 men. Kept as a test so the number stays real.
    const before = deltaE('#4A6B2A', '#9B3B32');
    const after = deltaE(simulate('#4A6B2A', 'deuteranopia'), simulate('#9B3B32', 'deuteranopia'));
    expect(before).toBeGreaterThan(25);
    expect(after).toBeLessThan(2.3);
  });
});

describe.each(PALETTE_NAMES)('%s palette', (name) => {
  const palette = PALETTES[name];

  describe.each(modes(palette))('%s mode', (_modeName, scheme, hues) => {
    it('keeps every pair of category hues apart under every vision type', () => {
      const hexes = hues.map((h) => h.hex);
      for (const vision of VISION_TYPES) {
        const worst = worstPair(hexes, vision);
        expect(
          worst.deltaE,
          `${name}: ${worst.a} vs ${worst.b} is ΔE ${worst.deltaE.toFixed(1)} under ${vision}`,
        ).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION);
      }
    });

    it('gives every hue legible text on a filled chip', () => {
      // `.chip.v-FULL` fills with the hue, so this is real body text on real
      // background, not decoration.
      for (const { hex, on } of hues) {
        const ratio = contrastRatio(on, hex);
        expect(ratio, `${name}: text ${on} on hue ${hex} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          AA_NORMAL,
        );
      }
    });

    it('delimits every chip with an edge that meets the UI-component threshold', () => {
      /**
       * A chip is a UI component before it is text, so WCAG 1.4.11 asks for
       * 3:1 - but the *fill* cannot be what provides it. Okabe–Ito's orange is
       * inherently light, and no light colour reaches 3:1 against a light
       * ground; the arithmetic forbids it. The border does the work instead,
       * mixed toward `ink` so it darkens in light mode and lightens in dark.
       */
      for (const { hex } of hues) {
        const edge = mixSrgb(hex, scheme.ink, CHIP_EDGE_HUE_RATIO);
        const ratio = contrastRatio(edge, scheme.ground);
        expect(
          ratio,
          `${name}: edge ${edge} (from hue ${hex}) on ground is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_LARGE);
      }
    });

    it('provides exactly six hues', () => {
      // `hueFor()` indexes into this by a hash of the owner id. A short list
      // would silently make two people share a colour.
      expect(hues).toHaveLength(6);
    });
  });
});

describe.each(CVD_SAFE_PALETTES)('%s clears the higher bar it promises', (name) => {
  const palette = PALETTES[name];

  it.each(modes(palette))('in %s mode', (_modeName, _scheme, hues) => {
    const hexes = hues.map((h) => h.hex);
    for (const vision of VISION_TYPES) {
      const worst = worstPair(hexes, vision);
      expect(
        worst.deltaE,
        `${name}: worst pair is ΔE ${worst.deltaE.toFixed(1)} under ${vision}`,
      ).toBeGreaterThanOrEqual(SAFE_HUE_SEPARATION);
    }
  });

  it('says plainly what it is for', () => {
    // This blurb is the only way a user discovers the palette exists. If it
    // reads as a style option, the people who need it will scroll past.
    expect(palette.blurb.toLowerCase()).toContain('colour vision');
  });
});

describe('signal uses the published Okabe–Ito hues', () => {
  it('matches the reference set exactly', () => {
    // Deliberately pinned. A search maximising separation scores far higher and
    // produces neon; Okabe–Ito is the set every colourblind-safe palette is
    // checked against, and "we can beat the standard on our own metric" is how
    // a known-good thing gets quietly replaced with an unreviewed one.
    expect(PALETTES.signal.huesLight.map((h) => h.hex)).toEqual([
      '#0072B2',
      '#D55E00',
      '#009E73',
      '#E69F00',
      '#CC79A7',
      '#56B4E9',
    ]);
  });
});
