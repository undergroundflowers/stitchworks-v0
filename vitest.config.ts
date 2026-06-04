import { defineConfig } from 'vitest/config';

// Standalone Vitest config (kept separate from vite.config.ts so the
// production build config stays untouched). Tests are pure-logic .ts files —
// no JSX — so the default esbuild transform + node environment is enough.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
