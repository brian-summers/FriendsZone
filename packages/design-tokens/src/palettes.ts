import type { ColorScheme } from './color.js';
import { DARK, LIGHT } from './color.js';

/**
 * Palettes: a theme is a **palette** and a **mode**, not one axis.
 *
 * Splitting them is the whole design. "Dark" is a lighting condition and
 * "Signal" is a set of hues; conflating them into a single list would mean
 * someone who needs the colourblind-safe hues has to give up dark mode to get
 * them, which is not a trade anyone should be asked to make.
 *
 * ## Category hues are measured, not asserted
 *
 * Colour carries exactly one thing in Friendszone: which *calendar* an event
 * belongs to, and which claim mode a listing uses. Visibility - the part that
 * can hurt someone - is carried by four redundant channels and never by hue
 * (`visibility.ts`).
 *
 * Even so, the shipped palette had a real defect, and it was invisible until it
 * was measured: under deuteranopia the old `moss` and `clay` hues sat **ΔE 0.6**
 * apart, which is below the just-noticeable difference of ~2.3. They were the
 * same colour. Nobody could have caught that by looking, because the people
 * reviewing it could see the difference perfectly well.
 *
 * So every palette below is checked by `cvd.test.ts`, which simulates
 * protanopia, deuteranopia and tritanopia and measures the closest pair:
 *
 *  - **Every palette** must keep all six hues ≥ `MIN_HUE_SEPARATION` apart under
 *    every vision type. That is the floor: no two calendars can be confusable
 *    for anyone.
 *  - **`signal`** must additionally clear `SAFE_HUE_SEPARATION`, and pairs the
 *    hues with deliberately neutral chrome so category colour is the only
 *    colour on screen.
 *
 * ## Why `signal` uses Okabe–Ito rather than something optimised
 *
 * A search maximising separation reaches ΔE 35 - and produces neon cyan and
 * lime, which is not this product. Above roughly 20 the extra distance buys
 * nothing a person can perceive, so `signal`'s light hues are the published
 * Okabe–Ito qualitative palette exactly. It is the reference every other
 * colourblind-safe palette is checked against; reinventing it to score better
 * on a metric would trade a known-good standard for a number.
 */

/** A category hue, with the text colour that is legible on top of it. */
export interface CategoryHue {
  readonly hex: string;
  /**
   * Text on a `v-FULL` chip, whose fill *is* the hue.
   *
   * Per-hue rather than one token per theme, because the colourblind-safe hues
   * span a wide lightness range on purpose - that spread is what survives
   * red-green deficiency - and five of Okabe–Ito's six need dark text while the
   * sixth needs white. A single `onHue` would have forced every hue dark, which
   * is precisely what collapsed the separation in the first attempt.
   */
  readonly on: string;
}

export type PaletteName = 'verdigris' | 'harbor' | 'signal';

export interface Palette {
  readonly name: PaletteName;
  /** Shown in Settings. */
  readonly label: string;
  /** One line, in the user's words, on what this palette is for. */
  readonly blurb: string;
  readonly light: ColorScheme;
  readonly dark: ColorScheme;
  readonly huesLight: readonly CategoryHue[];
  readonly huesDark: readonly CategoryHue[];
}

const W = '#FFFFFF';
const K = '#0D1412';

const hue = (hex: string, on: string): CategoryHue => ({ hex, on });

// ── verdigris - the default ───────────────────────────────────────
// Chrome is unchanged from the original palette: oxidised copper against aged
// metal, and no reason to move it. Only the category hues are retuned, because
// the originals were the ones that failed measurement.

const VERDIGRIS_HUES_LIGHT: readonly CategoryHue[] = [
  hue('#136B58', W), // teal - the brand hue, kept as slot 1
  hue('#C9A227', K), // gold
  hue('#4A3A78', W), // indigo
  hue('#7FCFC4', K), // pale aqua
  hue('#9D5725', W), // rust
  hue('#B084CE', K), // lilac
];

const VERDIGRIS_HUES_DARK: readonly CategoryHue[] = [
  hue('#5CC2A6', K),
  hue('#6D3F8C', W),
  hue('#CDCD81', K),
  hue('#763B37', W),
  hue('#4D5F6F', W),
  hue('#C795C7', K),
];

// ── harbor - cool, for people who find the green warm ─────────────

const HARBOR_LIGHT: ColorScheme = {
  ground: '#EFF2F6',
  surface: '#FFFFFF',
  sunken: '#E3E8EF',
  rule: '#C3CCD8',
  ink: '#131A22',
  ink2: '#47535F',
  ink3: '#5C6875',
  verdigris: '#1F5C8B',
  verdigrisHover: '#17496F',
  onVerdigris: '#FFFFFF',
  brass: '#7A5A1A',
  madder: '#9B3B32',
  amber: '#7A5A12',
};

const HARBOR_DARK: ColorScheme = {
  ground: '#0B1016',
  surface: '#131A22',
  sunken: '#1B242E',
  rule: '#2E3A47',
  ink: '#E6EDF4',
  ink2: '#A7B4C0',
  ink3: '#8A98A5',
  verdigris: '#6FB3E8',
  verdigrisHover: '#8CC6F2',
  onVerdigris: '#0B1016',
  brass: '#D2A459',
  madder: '#E3877D',
  amber: '#D9B166',
};

const HARBOR_HUES_LIGHT: readonly CategoryHue[] = [
  hue('#1F4E79', W),
  hue('#C97F2E', K),
  hue('#5FA89A', K),
  hue('#7C1D3A', W),
  hue('#8E6FC9', K),
  hue('#D6C08A', K),
];

const HARBOR_HUES_DARK: readonly CategoryHue[] = [
  hue('#7FB2E0', K),
  hue('#A8774C', K),
  hue('#462D78', W),
  hue('#D9CDBB', K),
  hue('#6F4A72', W),
  hue('#993D56', W),
];

// ── signal - colourblind-first ────────────────────────────────────
// Neutral chrome on purpose. In the other palettes the brand colour competes
// with the category hues for attention; here the only saturated colour on
// screen is the one carrying information.

const SIGNAL_LIGHT: ColorScheme = {
  ground: '#F4F4F2',
  surface: '#FFFFFF',
  sunken: '#E9E9E6',
  rule: '#C8C8C4',
  ink: '#16181A',
  ink2: '#4A4D50',
  ink3: '#5E6265',
  verdigris: '#0F5E8C',
  verdigrisHover: '#0B4A6E',
  onVerdigris: '#FFFFFF',
  brass: '#7A5A12',
  madder: '#99342B',
  amber: '#755712',
};

const SIGNAL_DARK: ColorScheme = {
  ground: '#101112',
  surface: '#191B1D',
  sunken: '#232628',
  rule: '#3A3E41',
  ink: '#ECEEF0',
  ink2: '#AFB4B8',
  ink3: '#91979B',
  verdigris: '#56B4E9',
  verdigrisHover: '#7CC7F0',
  onVerdigris: '#101112',
  brass: '#D2A459',
  madder: '#E3877D',
  amber: '#D9B166',
};

/** Okabe & Ito's qualitative palette, unmodified. */
const SIGNAL_HUES_LIGHT: readonly CategoryHue[] = [
  hue('#0072B2', W), // blue
  hue('#D55E00', K), // vermillion
  hue('#009E73', K), // bluish green
  hue('#E69F00', K), // orange
  hue('#CC79A7', K), // reddish purple
  hue('#56B4E9', K), // sky blue
];

const SIGNAL_HUES_DARK: readonly CategoryHue[] = [
  hue('#56B4E9', K),
  hue('#AA7F4E', K),
  hue('#282873', W),
  hue('#D7D0BF', K),
  hue('#993D56', W),
  hue('#694971', W),
];

export const PALETTES: Readonly<Record<PaletteName, Palette>> = Object.freeze({
  verdigris: {
    name: 'verdigris',
    label: 'Verdigris',
    blurb: 'The default. Oxidised copper and aged metal.',
    light: LIGHT,
    dark: DARK,
    huesLight: VERDIGRIS_HUES_LIGHT,
    huesDark: VERDIGRIS_HUES_DARK,
  },
  harbor: {
    name: 'harbor',
    label: 'Harbor',
    blurb: 'Cooler. Slate and deep blue instead of green.',
    light: HARBOR_LIGHT,
    dark: HARBOR_DARK,
    huesLight: HARBOR_HUES_LIGHT,
    huesDark: HARBOR_HUES_DARK,
  },
  signal: {
    name: 'signal',
    label: 'Signal',
    blurb:
      'Built for colour vision deficiency. Calendar colours stay tellable apart with protanopia, deuteranopia, or tritanopia, and nothing else on screen competes with them.',
    light: SIGNAL_LIGHT,
    dark: SIGNAL_DARK,
    huesLight: SIGNAL_HUES_LIGHT,
    huesDark: SIGNAL_HUES_DARK,
  },
});

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

export const DEFAULT_PALETTE: PaletteName = 'verdigris';

/**
 * The floor, in ΔE, for any two category hues under any vision type.
 *
 * Chosen from measurement rather than taste: the old palette's worst pair sat
 * at 0.6, Okabe–Ito's sits at 16.2, and a muted palette can comfortably reach
 * the high twenties. 12 is well clear of "confusable" while leaving room to
 * choose colours that suit the product.
 */
export const MIN_HUE_SEPARATION = 12;

/** The higher bar `signal` clears. Okabe–Ito's own worst pair is 16.2. */
export const SAFE_HUE_SEPARATION = 15;

/**
 * How much hue is left in a `v-FULL` chip's border: `color-mix(hue 65%, ink)`.
 *
 * A chip's *fill* cannot carry identifiability on its own. Okabe–Ito's orange
 * is inherently light, and no light colour reaches 3:1 against a light ground -
 * the arithmetic simply does not allow it. So the border does that work, mixed
 * toward `ink`, which darkens it in light mode and lightens it in dark mode.
 * One ratio for every hue in every palette, verified by `cvd.test.ts`.
 */
export const CHIP_EDGE_HUE_RATIO = 0.65;

/** Palettes that promise colourblind safety, and are tested against it. */
export const CVD_SAFE_PALETTES: readonly PaletteName[] = ['signal'];
