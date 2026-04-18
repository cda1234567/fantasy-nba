import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g1_player\.spec\.ts/,
  timeout: 20 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: false,
    launchOptions: { slowMo: 400 },
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
