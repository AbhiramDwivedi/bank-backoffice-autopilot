import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright smoke config for the CU Core Workstation mock app. The spec starts and
 * stops the app itself (createApp -> listen(0)), so there is no webServer entry here.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
  },
});
