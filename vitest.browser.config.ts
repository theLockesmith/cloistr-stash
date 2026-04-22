import { defineConfig } from 'vitest/config';

/**
 * Vitest Browser Mode Configuration
 *
 * This runs tests in real browser (Chromium/Firefox/WebKit) to access
 * browser APIs that jsdom doesn't support (SubtleCrypto, IndexedDB, etc.)
 *
 * Usage:
 *   npx vitest --config vitest.browser.config.ts
 *   npm run test:browser
 *
 * Note: This project also has a Puppeteer-based runner:
 *   npm run test:puppeteer
 *
 * Port: Uses 9480 (cloistr test port allocation)
 */
export default defineConfig({
  test: {
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
      headless: true,
      screenshotFailures: true,
    },
    // Test files that need real browser APIs
    include: [
      'web/js/tests/**/*.test.ts',
      'web/js/tests/**/*.browser.test.ts',
      'tests/browser/**/*.test.ts',
    ],
    // Longer timeout for browser startup
    testTimeout: 30000,
    // Reporter
    reporters: ['verbose'],
  },
  // Serve static files from web/
  publicDir: 'web',
  server: {
    port: 9480,
  },
});
