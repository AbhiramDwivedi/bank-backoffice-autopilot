import { defineConfig } from 'vitest/config';

// One project per workspace package, plus the cross-package end-to-end suite. Unit projects run
// in parallel. End-to-end tests drive Chromium against the mock app and run one file at a time so
// browser contention cannot make them flaky.
const UNIT = { testTimeout: 30000, hookTimeout: 60000 };

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/src/**/*.test.ts'], ...UNIT } },
      { test: { name: 'adapter-playwright', include: ['packages/adapter-playwright/src/**/*.test.ts'], ...UNIT } },
      // Desktop: unit tests run anywhere against the fake bridge; *.integration.test.ts open real
      // windows on Windows only, one file at a time so at most one test app is on screen.
      {
        test: { name: 'adapter-desktop', include: ['packages/adapter-desktop/src/**/*.test.ts'], fileParallelism: false, testTimeout: 60000, hookTimeout: 180000 },
      },
      { test: { name: 'adapter-anthropic', include: ['packages/adapter-anthropic/src/**/*.test.ts'], ...UNIT } },
      { test: { name: 'adapter-jev', include: ['packages/adapter-jev/src/**/*.test.ts'], ...UNIT } },
      { test: { name: 'adapter-credentials', include: ['packages/adapter-credentials/src/**/*.test.ts'], ...UNIT } },
      { test: { name: 'cli', include: ['apps/cu/src/**/*.test.ts'], ...UNIT } },
      { test: { name: 'mock-app', include: ['apps/mock-app/**/*.test.ts'], ...UNIT } },
      { test: { name: 'relay', include: ['apps/relay/{src,test}/**/*.test.ts'], testTimeout: 30000, hookTimeout: 90000 } },
      {
        test: {
          name: 'browser-agent',
          include: ['packages/browser-agent/test/**/*.test.ts'],
          globalSetup: ['packages/browser-agent/test/global-setup.ts'],
          testTimeout: 60000,
          hookTimeout: 90000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60000,
          hookTimeout: 90000,
        },
      },
    ],
  },
});
