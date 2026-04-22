// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright Test Configuration
 * @see https://playwright.dev/docs/test-configuration
 *
 * Port allocation for local testing (9400-9499 range for Cloistr projects):
 * - 9480: cloistr-stash (this project)
 * - 9481: cloistr-space (reserved)
 * - 9482-9489: reserved for other cloistr services
 *
 * Production testing: Use playwright-prod.config.js or set TEST_BASE_URL env var
 */

const TEST_PORT = process.env.TEST_PORT || 9480;
const baseURL = process.env.TEST_BASE_URL || `http://localhost:${TEST_PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
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
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  webServer: {
    command: `DRIVE_PORT=${TEST_PORT} go run ./cmd/server`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
