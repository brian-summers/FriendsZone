/**
 * Colour vision deficiency simulation, and perceptual distance.
 *
 * Friendszone encodes one thing with colour and one thing only: which
 * *category* an event belongs to. Visibility — the part that can hurt someone —
 * is deliberately carried by four redundant channels, of which colour is the
 * least important (see `visibility.ts`).
 *
 * That leaves category hue. It is not safety-critical, but a calendar where six
 * categories collapse into three muddy browns is a calendar that has stopped
 * doing its job for roughly 1 in 12 men and 1 in 200 women. So the palettes are
 * *measured* rather than asserted: `cvd.test.ts` simulates each common
 * deficiency and checks that every pair of category hues stays apart.
 *
 * "Colourblind-friendly" is a claim. This file is what makes it a test.
 */

type Rgb = [number, number, number];
type Matrix = [Rgb, Rgb, Rgb];

const toRgb = (hex: string): Rgb => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const toHex = (rgb: Rgb): string =>
  `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** sRGB → linear. The simulation matrices operate on linear light. */
const linearise = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const delinearise = (c: number): number => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
};

/**
 * Machado, Oliveira & Fernandes (2009), severity 1.0.
 *
 * Chosen over Brettel/Viénot because these are a single 3×3 per deficiency,
 * which keeps this file readable — and a reviewer being able to check the
 * arithmetic matters more here than the last few percent of fidelity.
 */
const MATRICES: Record<CvdType, Matrix> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/** Every vision type the palettes are tested against, normal vision included. */
export const VISION_TYPES = [
  'normal',
  'protanopia',
  'deuteranopia',
  'tritanopia',
] as const;
export type VisionType = (typeof VISION_TYPES)[number];

/** How `hex` appears to someone with the given deficiency. */
export function simulate(hex: string, vision: VisionType): string {
  if (vision === 'normal') return hex.toUpperCase();
  const m = MATRICES[vision];
  const [r, g, b] = toRgb(hex).map(linearise) as Rgb;
  const out = m.map((row) => row[0] * r + row[1] * g + row[2] * b) as Rgb;
  return toHex(out.map(delinearise) as Rgb);
}

// ── Perceptual distance ────────────────────────────────────────────

/** sRGB → CIE L*a*b*, D65. */
function toLab(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map(linearise) as Rgb;

  // Linear sRGB → XYZ (D65), then normalise by the white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIE76 ΔE — Euclidean distance in Lab.
 *
 * CIEDE2000 is more accurate, and considerably more code. CIE76 is sufficient
 * for the question actually being asked here, which is not "do these match?"
 * but "could anyone mistake these for each other at a glance?" — a coarse
 * judgement where the extra precision buys nothing a reviewer can verify.
 *
 * For reference: ~2.3 is the just-noticeable difference.
 */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The smallest ΔE between any two colours in the set, under one vision type.
 *
 * This is the number that matters: a palette is only as distinguishable as its
 * closest pair, so an average would hide exactly the failure worth catching.
 */
export function worstPair(
  colors: readonly string[],
  vision: VisionType,
): { a: string; b: string; deltaE: number } {
  let worst = { a: '', b: '', deltaE: Number.POSITIVE_INFINITY };
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      const d = deltaE(simulate(colors[i]!, vision), simulate(colors[j]!, vision));
      if (d < worst.deltaE) worst = { a: colors[i]!, b: colors[j]!, deltaE: d };
    }
  }
  return worst;
}
