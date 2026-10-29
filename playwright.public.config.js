// @ts-check
// Browser test for the public share-link page: the real Go server and the
// real built web app, with a local stand-in for Blossom (tests/e2e-public).
// Needs `npm run build` in web/ first.
const { defineConfig, devices } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests/e2e-public',
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:9483' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
})
