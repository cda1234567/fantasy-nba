import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g4_observer\.spec\.ts/,
  timeout: 15 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  outputDir: './playwright-output-g4o',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
