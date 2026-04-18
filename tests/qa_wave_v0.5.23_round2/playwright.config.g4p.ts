import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g4_player\.spec\.ts/,
  timeout: 25 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g4p',
});
