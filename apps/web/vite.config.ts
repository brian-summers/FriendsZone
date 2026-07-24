import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Pinned to this file's directory rather than inherited from cwd, so the app
  // serves identically whether launched from the workspace or the repo root.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    // Point at sources so the client picks up workspace changes without a
    // rebuild step, and so type errors surface in the editor immediately.
    alias: [
      {
        find: /^@friendszone\/contracts$/,
        replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      },
      {
        find: /^@friendszone\/design-tokens$/,
        replacement: fileURLToPath(
          new URL('../../packages/design-tokens/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  server: {
    port: 5173,
    /**
     * Same-origin proxy rather than CORS.
     *
     * Enabling cross-origin credentialed requests in development is how a
     * permissive `Access-Control-Allow-Origin` ends up shipped by accident. A
     * proxy keeps dev and production on the same origin story, so there is no
     * CORS configuration to get wrong later.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
