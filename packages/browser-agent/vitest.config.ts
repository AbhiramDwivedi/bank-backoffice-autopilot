import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Browser tests drive headless Chromium against fixtures served over HTTP. globalSetup rebuilds
// dist/cu-agent.js first, so no test ever runs a stale bundle.
export default defineConfig({
  test: {
    name: 'browser-agent',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 90000,
  },
});
