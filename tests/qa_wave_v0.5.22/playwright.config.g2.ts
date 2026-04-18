import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g2_player\.spec\.ts/,
  timeout: 15 * 60 * 1000,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  outputDir: 'playwright-output-g2',
});
