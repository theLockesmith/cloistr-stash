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

  // The server's -web flag defaults to `web`, which is the Vite SOURCE tree, not
  // the build. Serving it returns web/index.html verbatim -- `<div id="root">`
  // plus `<script type="module" src="/src/main.tsx">` -- and the Go static
  // handler hands /src/main.tsx back as `application/x-tiled-tsx`, a MIME type a
  // browser will not execute as a module. Measured 2026-09-04: the app never
  // mounted, so every spec ran against an empty #root and the whole suite failed
  // on locators that could not possibly exist. Dockerfile line 47 copies
  // /web/dist to /app/web and line 54 passes `-web /app/web`, so production has
  // always served the BUILD. Test what ships.
  webServer: {
    command: `npm --prefix web run build && GOWORK=off DRIVE_PORT=${TEST_PORT} go run ./cmd/server -web web/dist`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300 * 1000,
  },
});
