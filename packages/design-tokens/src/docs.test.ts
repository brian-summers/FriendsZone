import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Diagrams in the documentation are Mermaid, never ASCII art.
 *
 * Hand-drawn box diagrams rot in a specific, silent way. Emoji and CJK glyphs
 * render double-width in a monospace font, so a single 🔒 inside a box pushes
 * that row two columns out and the right border stops lining up. Every diagram
 * in this repository had drifted that way before this test existed, and none of
 * the edits that broke them looked wrong in a diff.
 *
 * Mermaid has no alignment to lose. It also renders on GitHub, in the VS Code
 * preview, and in the Artifacts viewer without a build step.
 *
 * Lives in design-tokens because that package already owns the "the way this is
 * presented is a correctness property, not a taste preference" tests — the
 * contrast gate is right beside this one.
 */

const REPO = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Box-drawing and arrow glyphs. The building blocks of an ASCII diagram. */
const ART = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▼▲◄►]/;

const markdownFiles = (): string[] => {
  const out: string[] = [];
  for (const top of ['README.md', 'CLAUDE.md']) {
    try {
      statSync(join(REPO, top));
      out.push(join(REPO, top));
    } catch {
      // Not every checkout has both; absence is not a failure.
    }
  }
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.md')) out.push(p);
    }
  })(join(REPO, 'docs'));
  return out;
};

/** Every fenced block in a file, with the line it starts on. */
function fencedBlocks(text: string): Array<{ line: number; body: string[] }> {
  const lines = text.split('\n');
  const blocks: Array<{ line: number; body: string[] }> = [];
  let open = false;
  let start = 0;
  let body: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i] ?? '')) {
      if (open) blocks.push({ line: start, body });
      else {
        start = i + 1;
        body = [];
      }
      open = !open;
      continue;
    }
    if (open) body.push(lines[i] ?? '');
  }
  return blocks;
}

describe('documentation diagrams', () => {
  it('contains no ASCII art inside fenced blocks', () => {
    const offenders: string[] = [];
    for (const file of markdownFiles()) {
      const rel = file.slice(REPO.length).replace(/\\/g, '/');
      for (const block of fencedBlocks(readFileSync(file, 'utf8'))) {
        // Two or more art lines: one stray `│` in a shell snippet or a `─` in
        // sample output is not a diagram, and failing on it would make the test
        // something people route around.
        const art = block.body.filter((l) => ART.test(l)).length;
        if (art >= 2) offenders.push(`${rel}:${block.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares a language on every mermaid block, so GitHub renders it', () => {
    // ```` ``` ```` with a mermaid body and no language tag renders as a wall of
    // text. The failure is invisible until someone opens the file on GitHub.
    const offenders: string[] = [];
    for (const file of markdownFiles()) {
      const rel = file.slice(REPO.length).replace(/\\/g, '/');
      const lines = readFileSync(file, 'utf8').split('\n');
      let open = false;
      let lang = '';
      let start = 0;
      let body: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const m = (lines[i] ?? '').match(/^\s*```(\w*)/);
        if (m !== null) {
          if (open) {
            const looksMermaid = /^\s*(flowchart|sequenceDiagram|erDiagram|graph|stateDiagram)/.test(
              body[0] ?? '',
            );
            if (looksMermaid && lang !== 'mermaid') offenders.push(`${rel}:${start}`);
            open = false;
          } else {
            open = true;
            lang = m[1] ?? '';
            start = i + 1;
            body = [];
          }
          continue;
        }
        if (open) body.push(lines[i] ?? '');
      }
    }
    expect(offenders).toEqual([]);
  });
});
