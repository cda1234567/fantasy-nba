import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g3_player\.spec\.ts/,
  timeout: 40 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20000,
    navigationTimeout: 45000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g3p',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
