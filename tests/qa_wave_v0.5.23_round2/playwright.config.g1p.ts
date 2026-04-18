import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g1_player\.spec\.ts/,
  timeout: 30 * 60 * 1000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g1p',
});
