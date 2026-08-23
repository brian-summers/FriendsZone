import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PALETTES,
  PALETTE_NAMES,
  type ColorScheme,
  type Palette,
} from '@friendszone/design-tokens';

/**
 * Drift guard between `tokens.css` and the TypeScript token source.
 *
 * The CSS is generated once and checked in, so the palette exists before any
 * JavaScript runs. That duplication is only acceptable because this test makes
 * it impossible to get away with: change a hex in one place and CI fails.
 *
 * A stale chrome colour would be cosmetic. A stale *hue* would be worse than it
 * looks - the palettes are measured for colour-vision separation in
 * `cvd.test.ts`, and a CSS file that quietly disagreed with the values that
 * were measured would mean the whole guarantee was being checked against
 * numbers nobody was actually shipping.
 */
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** Custom properties declared directly inside `selector`'s block. */
function block(selector: string): Record<string, string> {
  const index = css.indexOf(selector);
  if (index === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', index);

  // Media queries nest, so track depth rather than finding the first `}`.
  let depth = 0;
  let close = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }

  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split('\n')) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*(.+?);\s*$/i.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = match[2].trim();
  }
  return out;
}

const kebab = (camel: string): string => camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const COLOR_KEYS: Array<keyof ColorScheme> = [
  'ground',
  'surface',
  'sunken',
  'rule',
  'ink',
  'ink2',
  'ink3',
  'verdigris',
  'verdigrisHover',
  'onVerdigris',
  'brass',
  'madder',
  'amber',
];

function expectScheme(selector: string, scheme: ColorScheme): void {
  const declared = block(selector);
  for (const key of COLOR_KEYS) {
    expect(declared[kebab(key)]?.toUpperCase(), `${selector} --${kebab(key)}`).toBe(
      scheme[key].toUpperCase(),
    );
  }
}

function expectHues(selector: string, palette: Palette, mode: 'huesLight' | 'huesDark'): void {
  const declared = block(selector);
  palette[mode].forEach((hue, i) => {
    expect(declared[`hue-${i + 1}`]?.toUpperCase(), `${selector} --hue-${i + 1}`).toBe(
      hue.hex.toUpperCase(),
    );
    expect(declared[`on-hue-${i + 1}`]?.toUpperCase(), `${selector} --on-hue-${i + 1}`).toBe(
      hue.on.toUpperCase(),
    );
  });
}

describe('tokens.css mirrors @friendszone/design-tokens', () => {
  const fallback = PALETTES.verdigris;

  it.each([
    [':root {', false],
    ["@media (prefers-color-scheme: dark) {\n  :root {", true],
    ["'dark'] {", true],
  ] as const)('the %s fallback block matches verdigris', (selector, dark) => {
    expectScheme(selector, dark ? fallback.dark : fallback.light);
  });

  describe.each(PALETTE_NAMES)('%s', (name) => {
    const palette = PALETTES[name];

    it.each([
      [`:root[data-palette='${name}'] {`, false],
      [`@media (prefers-color-scheme: dark) {\n  :root[data-palette='${name}'] {`, true],
      [`:root[data-palette='${name}'][data-theme='light'] {`, false],
      [`:root[data-palette='${name}'][data-theme='dark'] {`, true],
    ] as const)('%s carries the right scheme and hues', (selector, dark) => {
      expectScheme(selector, dark ? palette.dark : palette.light);
      expectHues(selector, palette, dark ? 'huesDark' : 'huesLight');
    });
  });
});

describe('the cascade resolves the way the app assumes', () => {
  it('lets an explicit mode override the OS in both directions', () => {
    // The toggle has to be able to force light on a dark OS, not just dark on
    // a light one - so both blocks exist and both come after the media query.
    expect(css.indexOf(":root[data-theme='dark']")).toBeGreaterThan(
      css.indexOf('@media (prefers-color-scheme: dark)'),
    );
    expect(css.indexOf(":root[data-theme='light']")).toBeGreaterThan(
      css.indexOf('@media (prefers-color-scheme: dark)'),
    );
  });

  it('gives every palette all four palette-and-mode combinations', () => {
    /**
     * The subtle one. `:root[data-theme='dark']` and `:root[data-palette='x']`
     * have *equal* specificity, so if a palette omitted its explicit
     * `[data-palette][data-theme]` block, the winner would be decided by source
     * order - and a user on the Signal palette with dark mode forced would
     * silently get Verdigris's dark chrome against Signal's hues.
     */
    for (const name of PALETTE_NAMES) {
      for (const selector of [
        `:root[data-palette='${name}'] {`,
        `:root[data-palette='${name}'][data-theme='light'] {`,
        `:root[data-palette='${name}'][data-theme='dark'] {`,
      ]) {
        expect(css, selector).toContain(selector);
      }
    }
  });
});
