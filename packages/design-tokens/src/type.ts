/**
 * Typography and spatial tokens.
 *
 * Three roles, chosen for what the product actually is: a schedule is a
 * *document of times*, so numerals are load-bearing and get their own face.
 */

/**
 * Font stacks.
 *
 * Deliberately system-resident rather than webfonts. Two reasons, and the
 * second is the real one:
 *
 *  - Calendar UI is dense with numerals that must align. A webfont that arrives
 *    late reflows a grid of times, which is far uglier than in prose.
 *  - The product is used in short, frequent glances - "am I free Thursday?" -
 *    where a 200ms font swap is a disproportionate share of the interaction.
 */
export const FONTS = {
  /**
   * Display: a high-contrast old-style serif, used only for the wordmark and
   * major headings. Friendszone's ancestor is the paper appointment book, and a
   * book face acknowledges that without costuming the whole interface.
   */
  display:
    "'Hoefler Text', 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",

  /** Interface and body. Neutral, high legibility at small sizes. */
  body:
    "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",

  /**
   * Times, durations, dates, and any tabular data. Monospace is not a stylistic
   * flourish here - it is the only way a column of times aligns without
   * fighting proportional digits.
   */
  mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Segoe UI Mono', Menlo, Consolas, monospace",
} as const;

/**
 * Type scale, in rem. A modest ratio (~1.2) because dense scheduling UI needs
 * many usable steps between "caption" and "heading", not four dramatic ones.
 */
export const TYPE_SCALE = {
  caption: 0.75,
  small: 0.8125,
  body: 0.9375,
  bodyLarge: 1.0625,
  h4: 1.1875,
  h3: 1.4375,
  h2: 1.75,
  h1: 2.25,
  display: 3,
} as const;

/** 4px base. Every gap in the UI is a multiple; nothing is eyeballed. */
export const SPACE = {
  '3xs': '0.125rem',
  '2xs': '0.25rem',
  xs: '0.5rem',
  sm: '0.75rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
  '3xl': '4.5rem',
} as const;

/**
 * Corner radii.
 *
 * Event chips are nearly square (3px) on purpose. A calendar event represents
 * a precise interval, and heavily rounded corners visually soften the
 * boundaries of something whose edges are the meaningful part. Containers get
 * more radius; the things that encode time get very little.
 */
export const RADIUS = {
  chip: '3px',
  control: '6px',
  card: '10px',
  pill: '999px',
} as const;

/**
 * Motion.
 *
 * Kept short and few. This is an anxiety-reducing product, and animation that
 * draws attention to itself works against that. Notably absent: any attention
 * -seeking motion for incoming requests. A request arriving must never animate
 * in a way that demands to be dealt with now - that is the read-receipt problem
 * wearing a different hat. See docs/adr/0007-async-by-design.md.
 */
export const MOTION = {
  instant: '90ms',
  quick: '160ms',
  considered: '240ms',
  ease: 'cubic-bezier(0.2, 0, 0.13, 1)',
} as const;
