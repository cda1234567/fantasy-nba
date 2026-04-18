import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g3_observer\.spec\.ts/,
  timeout: 10 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 45000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g3o',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
