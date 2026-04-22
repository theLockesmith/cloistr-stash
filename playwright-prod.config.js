// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Production Playwright Test Configuration
 * Runs tests against stash.cloistr.xyz
 */

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  workers: 2,
  reporter: [
    ['html', { outputFolder: 'playwright-report-prod' }],
    ['json', { outputFile: 'test-results-prod.json' }],
    ['list']
  ],
  use: {
    baseURL: 'https://stash.cloistr.xyz',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  // No webServer - testing against production
});
