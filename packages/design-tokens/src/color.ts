/**
 * Friendszone color tokens.
 *
 * The palette is verdigris and brass — oxidised copper against aged metal.
 * That is not an arbitrary mood board. Friendszone is a scheduling product whose
 * whole thesis is the absence of urgency, so the palette deliberately avoids
 * the alerting vocabulary every other social product is built from: no
 * saturated red, no notification-badge crimson, no high-chroma blue.
 *
 * Verdigris is a slow color. It is what copper does over years. It reads as
 * calm and considered at a glance, and it is far enough from the blue-purple
 * band that Friendszone does not look like a calendar competitor or a chat app.
 *
 * Every value below is contrast-verified against every ground it is permitted
 * on, in both themes, by `contrast.test.ts`. Changing a hex here without
 * running the tests will fail CI, which is the point: accessibility is an
 * invariant, not a review comment.
 */

export interface ColorScheme {
  /** Page background. */
  ground: string;
  /** Raised card / panel. */
  surface: string;
  /** Recessed well — inputs, the calendar grid behind events. */
  sunken: string;
  /** Hairlines and dividers. */
  rule: string;

  /** Primary text. */
  ink: string;
  /** Secondary text — supporting copy, metadata. */
  ink2: string;
  /** Muted text — timestamps, captions. Still AA on every ground. */
  ink3: string;

  /** Primary action and brand. */
  verdigris: string;
  verdigrisHover: string;
  /**
   * Text placed *on top of* a filled verdigris button.
   *
   * Light and dark need opposite answers here: white on verdigris is 6.42:1 in
   * light but only 2.16:1 in dark, because the dark-theme verdigris is lifted
   * to stay legible on a dark ground. Hard-coding `#fff` on buttons is
   * therefore a bug that only shows up in one theme — a token removes the
   * chance to make it.
   */
  onVerdigris: string;

  /** Secondary accent. Marketplace tags, RSVP-yes, warm highlights. */
  brass: string;

  /** Semantic. Deliberately desaturated — see the note below. */
  madder: string;
  amber: string;
}

/**
 * A note on the semantic colors.
 *
 * `madder` is a muted rose-brick, not a fire-engine red, and `amber` is closer
 * to old gold than to a hazard sign. In a product built to lower the stakes of
 * social scheduling, a destructive action should read as *serious*, not as an
 * emergency. The one place we do want genuine alarm — a safety report on an
 * exchange — earns it through weight and iconography rather than by turning the
 * whole palette up.
 */
export const LIGHT: ColorScheme = {
  ground: '#F1F4F0',
  surface: '#FFFFFF',
  sunken: '#E7EBE5',
  rule: '#C6D0C4',
  ink: '#131C18',
  ink2: '#495650',
  ink3: '#5E6C65',
  verdigris: '#136B58',
  verdigrisHover: '#0E5546',
  onVerdigris: '#FFFFFF',
  brass: '#7C591A',
  madder: '#9B3B32',
  amber: '#7A5A12',
};

export const DARK: ColorScheme = {
  ground: '#0D1412',
  surface: '#151E1B',
  sunken: '#1D2825',
  rule: '#31403B',
  ink: '#E7EDE9',
  ink2: '#A9B6B0',
  ink3: '#8B9993',
  verdigris: '#5CC2A6',
  verdigrisHover: '#7BD4BB',
  onVerdigris: '#0D1412',
  brass: '#D2A459',
  madder: '#E3877D',
  amber: '#D9B166',
};

/** Which grounds each foreground token is allowed to sit on. Drives the tests. */
export const GROUNDS = ['ground', 'surface', 'sunken'] as const;
export const FOREGROUNDS = [
  'ink',
  'ink2',
  'ink3',
  'verdigris',
  'brass',
  'madder',
  'amber',
] as const;
