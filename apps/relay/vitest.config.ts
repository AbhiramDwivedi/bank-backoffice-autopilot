import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone config so `npm test` in apps/relay runs this app's suite on its own. The root
// config's `relay` project uses the same files: 'apps/relay/{src,test}/**/*.test.ts'.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'relay',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
