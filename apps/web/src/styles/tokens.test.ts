import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, type ColorScheme } from '@friendszone/design-tokens';

/**
 * Drift guard between `tokens.css` and the TypeScript token source.
 *
 * The CSS is hand-written so the palette exists before any JavaScript runs.
 * That duplication is only acceptable because this test makes it impossible to
 * get away with: change a hex in one place and CI fails. A stale colour would
 * be cosmetic, but a stale *visibility* colour would misrepresent who can see
 * an event, so the guard is worth its keep.
 */
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** Extract a `--name: value;` pair from a specific selector block. */
function block(selector: string): Record<string, string> {
  const index = css.indexOf(selector);
  if (index === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);

  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*(.+?);\s*$/i.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      out[match[1]] = match[2].trim();
    }
  }
  return out;
}

/** `verdigrisHover` in TS is `--verdigris-hover` in CSS. */
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

describe('tokens.css mirrors @friendszone/design-tokens', () => {
  it.each([
    [':root {', LIGHT, 'light'],
    ["@media (prefers-color-scheme: dark)", DARK, 'dark (media query)'],
    ["[data-theme='dark']", DARK, 'dark (explicit override)'],
    ["[data-theme='light']", LIGHT, 'light (explicit override)'],
  ])('%s matches the %s scheme', (selector, scheme, _name) => {
    const declared = block(selector as string);
    for (const key of COLOR_KEYS) {
      const cssName = kebab(key);
      expect(declared[cssName]?.toUpperCase(), `--${cssName}`).toBe(
        (scheme as ColorScheme)[key].toUpperCase(),
      );
    }
  });

  it('overrides the media query in both directions', () => {
    // The viewer's theme toggle stamps data-theme on the root, and it has to
    // win over the OS preference — including forcing light on a dark OS.
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain("[data-theme='light']");
    expect(css.indexOf("[data-theme='dark']")).toBeGreaterThan(
      css.indexOf('@media (prefers-color-scheme: dark)'),
    );
  });
});
