import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /g2_observer\.spec\.ts/,
  timeout: 20 * 60 * 1000,
  reporter: [['list']],
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'https://nbafantasy.cda1234567.com',
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  outputDir: 'playwright-output-g2obs',
});
