// @ts-check
/**
 * Shared Playwright fixtures for cloistr-stash E2E tests.
 *
 * Provides a mock NIP-07 signer (window.nostr) injected before page load,
 * and a login() helper that clicks "Connect with Extension" and waits for
 * the authenticated app shell to render.
 *
 * The mock signer returns dummy values — it does not perform real crypto.
 * That is fine for DOM-presence and interaction tests. Tests that verify
 * actual encryption behaviour belong in vitest (web/src/__tests__/).
 */
const { test: base, expect } = require('@playwright/test');

/** 64-char hex pubkey used by the mock signer. */
const TEST_PUBKEY = 'aa'.repeat(32);

/**
 * Extended test fixture that injects window.nostr before every navigation.
 * Import { test, expect } from this file instead of @playwright/test.
 */
const test = base.extend({
  mockNostr: [async ({ page }, use) => {
    await page.addInitScript((pubkey) => {
      window.nostr = {
        getPublicKey: async () => pubkey,
        signEvent: async (event) => ({
          ...event,
          id: '00'.repeat(32),
          sig: '00'.repeat(64),
          pubkey,
        }),
        nip04: {
          encrypt: async (_pk, pt) => btoa(pt),
          decrypt: async (_pk, ct) => atob(ct),
        },
        nip44: {
          encrypt: async (_pk, pt) => btoa(pt),
          decrypt: async (_pk, ct) => atob(ct),
        },
      };
    }, TEST_PUBKEY);
    await use();
  }, { auto: true }],
});

/**
 * Navigate to the app and authenticate via the mock NIP-07 extension.
 * Resolves when the file-browser content area is visible.
 *
 * @param {import('@playwright/test').Page} page
 */
async function login(page) {
  await page.goto('/');
  const connectBtn = page.locator('#connect-nip07');
  await connectBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await connectBtn.click();
  // The app transitions: landing → connecting spinner → stash-content.
  // Wait for the content area that only renders when isConnected is true.
  await page.locator('.stash-content').waitFor({ state: 'visible', timeout: 15_000 });
}

module.exports = { test, expect, login, TEST_PUBKEY };
