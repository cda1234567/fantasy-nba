import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g1_player\.spec\.ts/,
  timeout: 30 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20000,
    navigationTimeout: 45000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g1p',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
