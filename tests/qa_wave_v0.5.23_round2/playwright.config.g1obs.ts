import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g1_observer\.spec\.ts/,
  timeout: 300 * 1000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g1obs',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
