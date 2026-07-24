import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Tests run against TypeScript sources, not build output. Without this,
  // `npm test` on a clean checkout would silently exercise a stale `dist/`
  // — or nothing at all.
  resolve: {
    alias: [
      {
        find: /^@friendszone\/policy\/testing$/,
        replacement: fileURLToPath(new URL('./packages/policy/src/testing.ts', import.meta.url)),
      },
      { find: /^@friendszone\/policy$/, replacement: src('packages/policy') },
      { find: /^@friendszone\/contracts$/, replacement: src('packages/contracts') },
      { find: /^@friendszone\/design-tokens$/, replacement: src('packages/design-tokens') },
    ],
  },
  test: {
    include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The policy package is the security kernel. It is pure, fully
      // unit-testable, and therefore has no excuse for uncovered branches.
      thresholds: {
        'packages/policy/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
