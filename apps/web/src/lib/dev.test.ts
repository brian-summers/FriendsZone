import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Backstop: development affordances must not reach a production build.
 *
 * The server already refuses `x-dev-actor-id` outside development, so nothing
 * here is the security boundary - `auth.test.ts` and `server.test.ts` hold that
 * line. What these assertions protect is the *client*: a real person should
 * never be offered an identity switcher, and their browser should never be
 * handed a list of seeded account ids to go with it.
 *
 * The mechanism is `import.meta.env.DEV`, which Vite replaces with the literal
 * `false` when building. That turns every guarded branch into dead code the
 * bundler deletes, so the affordance is *absent* from shipped JavaScript rather
 * than hidden in it. These tests read source, because the thing worth catching
 * is a future edit that adds a dev helper without the guard - which looks
 * completely fine in review.
 */

const WEB = 'apps/web/src';

const sources = (): Array<{ file: string; text: string }> => {
  const out: Array<{ file: string; text: string }> = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) {
        out.push({ file: p.split(sep).join('/'), text: readFileSync(p, 'utf8') });
      }
    }
  })(WEB);
  return out;
};

/** Seeded account ids, which exist only to be spoofed. */
const SEED_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

describe('development affordances', () => {
  it('keeps every seeded account id in lib/dev.ts alone', () => {
    // One file to audit. An id appearing anywhere else is either a second
    // switcher or a hard-coded user, and both are worth stopping.
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      if (file.endsWith('lib/dev.ts')) continue;
      for (const id of SEED_IDS) {
        if (text.includes(id)) offenders.push(`${file} contains ${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names the dev actor header in the two files that own it', () => {
    // `api.ts` sends it; `dev.ts` documents why it exists. A third file naming
    // it means some other code path has learned to spoof an identity.
    const allowed = ['lib/api.ts', 'lib/dev.ts'];
    const offenders = sources()
      .filter(
        ({ file, text }) =>
          !allowed.some((a) => file.endsWith(a)) && text.includes('x-dev-actor-id'),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('guards the seeded ids behind import.meta.env.DEV', () => {
    // The list must sit *inside* the DEV branch, not merely beside it: a
    // top-level constant referenced from a guarded block can still survive
    // into the bundle.
    const dev = readFileSync(join(WEB, 'lib/dev.ts'), 'utf8');
    const guardAt = dev.indexOf('import.meta.env.DEV');
    const firstId = dev.indexOf(SEED_IDS[0]!);
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstId).toBeGreaterThan(guardAt);
  });

  it('attaches the dev header only under the guard', () => {
    const api = readFileSync(join(WEB, 'lib/api.ts'), 'utf8');

    // Exactly one assignment, so there is one place to audit.
    const assignments = [...api.matchAll(/headers\[DEV_ACTOR_HEADER\]\s*=/g)];
    expect(assignments).toHaveLength(1);

    /**
     * The guard has to be *in the condition* controlling that assignment.
     *
     * An earlier version of this test searched backwards for the nearest
     * `import.meta.env.DEV` and found the one in the doc comment above, so it
     * kept passing after the real guard was deleted. Matching the `if` and its
     * body together is what makes it mean something.
     */
    const guarded = /if\s*\(\s*import\.meta\.env\.DEV[^)]*\)\s*\{[^}]*headers\[DEV_ACTOR_HEADER\]\s*=/s;
    expect(guarded.test(api), 'header assignment is not inside an import.meta.env.DEV condition').toBe(
      true,
    );
  });

  it('renders the identity switcher only under the guard', () => {
    const app = readFileSync(join(WEB, 'App.tsx'), 'utf8');
    // The guard and the element in one expression, so a deleted condition
    // cannot be satisfied by an `import.meta.env.DEV` mentioned elsewhere.
    const guarded = /import\.meta\.env\.DEV\s*&&\s*\(?\s*<DevActorSwitcher/s;
    expect(app).toContain('<DevActorSwitcher');
    expect(
      guarded.test(app),
      'DevActorSwitcher is not rendered behind import.meta.env.DEV',
    ).toBe(true);
  });

  it('keeps the switcher out of the stylesheet', () => {
    // Vite does not tree-shake CSS, so a `.devbar` rule in app.css would ship
    // to production permanently, styling an element that never renders. The
    // switcher carries its own inline styles instead.
    const css = readFileSync('apps/web/src/styles/app.css', 'utf8');
    expect(css).not.toContain('devbar');
  });

  it('ships no build-status board to users', () => {
    // A "what works / what is a stub" list is a developer artefact, and it goes
    // stale in the way such lists always do - this one still called Things a
    // stub and auth "todo" long after both shipped. The maintained versions of
    // that information are README.md and docs/product/road-to-ga.md.
    const offenders = sources()
      .filter(({ text }) => /What’s here, honestly|className="pill (go|warn)"/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
