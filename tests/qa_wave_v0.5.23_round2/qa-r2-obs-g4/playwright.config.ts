import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  timeout: 20 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
