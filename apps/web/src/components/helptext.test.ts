import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Backstop: what is allowed to be hidden behind a control.
 *
 * The product's most important guarantee is that a user can tell, at a glance,
 * who can see a thing. `packages/design-tokens/src/visibility.ts` states the
 * rule for the level itself - *"always rendered as text. Never a tooltip, never
 * hover-only"* - and the same reasoning covers every sentence that tells
 * somebody what will happen to them.
 *
 * These assertions read the source rather than the DOM on purpose. The failure
 * being guarded against is not a bug in a component; it is a future edit that
 * tidies a dense screen by tucking a consequence out of sight. That edit looks
 * like an improvement in review, which is exactly why it needs a test.
 */

const SRC = 'apps/web/src';

const tsxFiles = (): string[] => {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) out.push(p);
    }
  })(SRC);
  return out;
};

const sources = (): Array<{ file: string; text: string }> =>
  tsxFiles()
    .filter((f) => !f.endsWith('.test.tsx'))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

describe('helptext rules', () => {
  it('never carries consequence text inside an <Explainer>', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      // Non-greedy across the whole element, so a consequence anywhere inside
      // an explainer is caught however deeply it is nested.
      for (const match of text.matchAll(/<Explainer[\s\S]*?<\/Explainer>/g)) {
        if (/className="(share-)?consequence"/.test(match[0])) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no `title=` tooltips on DOM elements', () => {
    /**
     * A `title` attribute is the worst available tooltip: delayed, unstyleable,
     * invisible to touch, and announced inconsistently by screen readers. One
     * lived on `.seen-badge` and never fired at all, because that element also
     * has `pointer-events: none`.
     *
     * `title` as a *prop* on a React component (`<Placeholder title=…>`) is a
     * different thing entirely and stays allowed - hence the lowercase-tag test.
     */
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      // `<div title=` / `<span title=` … - a lowercase tag name is a DOM element.
      if (/<[a-z][a-zA-Z0-9]*\s[^>]*\btitle=/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('renders the visibility glyph outside the truncating span', () => {
    // The badge's word may ellipsize on a narrow chip. When it does, the glyph
    // is the channel that survives - so it must not share the clipped element.
    const grid = readFileSync(join(SRC, 'components/WeekGrid.tsx'), 'utf8');
    expect(grid).toContain('<span className="g">{shared.glyph}</span>');
    expect(grid).toContain('<span className="w">{shared.label}</span>');
  });
});
