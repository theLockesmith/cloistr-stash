// @ts-check
const { test, expect, login, TEST_PUBKEY } = require('./fixtures');

test.describe('Authentication - NIP-07 (browser extension)', () => {
  test('connecting with the mock extension takes the user to the file browser', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.landing')).toBeVisible();
    await expect(page.locator('.stash-content')).toHaveCount(0);

    await page.locator('#connect-nip07').click();

    await expect(page.locator('.stash-content')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.landing')).toHaveCount(0);
  });

  test('renders the shared header, footer, and sidebar after auth', async ({ page }) => {
    await login(page);

    await expect(page.locator('.stash-app')).toBeVisible();
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
  });
});

test.describe('Authentication - NIP-46 modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('opens on click and exposes the required fields', async ({ page }) => {
    const modal = page.locator('#nip46-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.locator('#connect-nip46').click();

    await expect(modal).toBeVisible();
    await expect(modal).not.toHaveClass(/hidden/);
    await expect(page.locator('#nip46-modal-title')).toHaveText('Connect with Remote Signer');
    await expect(page.locator('#bunker-url')).toBeVisible();
    await expect(page.locator('#nip46-cancel')).toBeVisible();
    await expect(page.locator('#nip46-connect')).toBeVisible();
    await expect(page.locator('#nip46-modal-close')).toBeVisible();
  });

  test('submitting an empty bunker URL shows validation feedback', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    await page.locator('#bunker-url').fill('');
    await page.locator('#nip46-connect').click();

    // Invalid submission surfaces as a toast and/or the inline status area;
    // either way the modal must not silently proceed to a connecting state.
    const toast = page.locator('.cloistr-toast-error, .toast.error');
    const status = page.locator('#nip46-status.error');
    await expect(toast.or(status)).toBeVisible({ timeout: 5_000 });

    // The modal stays open and the user is still on the landing page.
    await expect(page.locator('#nip46-modal')).not.toHaveClass(/hidden/);
    await expect(page.locator('.stash-content')).toHaveCount(0);
  });

  test('Cancel closes the modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    await page.locator('#nip46-cancel').click();

    await expect(page.locator('#nip46-modal')).toHaveClass(/hidden/);
  });

  test('clicking the backdrop closes the modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modal = page.locator('#nip46-modal');
    await expect(modal).toBeVisible();

    // Click the modal container itself (the backdrop), not its content box.
    await modal.click({ position: { x: 5, y: 5 } });

    await expect(modal).toHaveClass(/hidden/);
  });

  test('Escape key closes the modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator('#nip46-modal')).toHaveClass(/hidden/);
  });

  test('close (X) button closes the modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    await page.locator('#nip46-modal-close').click();

    await expect(page.locator('#nip46-modal')).toHaveClass(/hidden/);
  });

  test('focus moves to the bunker URL input when the modal opens', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    await expect(page.locator('#bunker-url')).toBeFocused({ timeout: 2_000 });
  });

  test('pressing Enter in the bunker URL input triggers connect', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    await expect(page.locator('#nip46-modal')).toBeVisible();

    const bunkerInput = page.locator('#bunker-url');
    await bunkerInput.fill('bunker://' + TEST_PUBKEY + '?relay=wss://relay.example.com');
    await bunkerInput.press('Enter');

    // Enter invokes the same connect handler as clicking #nip46-connect.
    // When connectNip46() fires, the auth state machine sets isConnecting,
    // and App.tsx unmounts the landing page (including the modal) in favour
    // of a connecting spinner. So the test can't check #nip46-status;
    // instead verify the landing page is gone.
    await expect(page.locator('.landing')).toHaveCount(0, { timeout: 10_000 });
  });
});
