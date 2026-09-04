// @ts-check
const { test, expect } = require('@playwright/test');

// Landing page renders whenever no user is authenticated -- no auth mock
// needed here, so this file intentionally imports the plain Playwright
// test/expect rather than the mockNostr-injecting fixture in fixtures.js.

test.describe('Landing Page (unauthenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders logo, title, and tagline', async ({ page }) => {
    const brand = page.locator('.landing-brand');
    await expect(brand.locator('.landing-logo')).toBeVisible();
    await expect(page.locator('.landing-title')).toHaveText('Cloistr Stash');
    await expect(page.locator('.landing-tagline')).toBeVisible();
    await expect(page.locator('.landing-tagline')).not.toBeEmpty();
  });

  test('shows both connect buttons, visible and enabled', async ({ page }) => {
    const nip07 = page.locator('#connect-nip07');
    const nip46 = page.locator('#connect-nip46');

    await expect(nip07).toBeVisible();
    await expect(nip07).toBeEnabled();
    await expect(nip07).toHaveText('Connect with Extension');

    await expect(nip46).toBeVisible();
    await expect(nip46).toBeEnabled();
    await expect(nip46).toHaveText('Connect with Remote Signer');
  });

  test('displays three feature cards', async ({ page }) => {
    const features = page.locator('.landing-features .feature');
    await expect(features).toHaveCount(3);

    for (const feature of await features.all()) {
      await expect(feature.locator('.feature-icon')).toBeVisible();
      await expect(feature.locator('p')).not.toBeEmpty();
    }
  });

  test('shows auth help text with a link to the signer', async ({ page }) => {
    const help = page.locator('.auth-help');
    await expect(help).toBeVisible();

    const signerLink = help.locator('a[href*="signer.cloistr.xyz"]');
    await expect(signerLink).toBeVisible();
  });

  test('NIP-46 modal help links to signer.cloistr.xyz and nsec.app', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modalHelp = page.locator('#nip46-modal .modal-help');
    await expect(modalHelp).toBeVisible();

    await expect(modalHelp.locator('a[href*="signer.cloistr.xyz"]')).toBeVisible();
    await expect(modalHelp.locator('a[href*="nsec.app"]')).toBeVisible();
  });

  test('clicking "Connect with Remote Signer" opens the NIP-46 modal', async ({ page }) => {
    const modal = page.locator('#nip46-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.locator('#connect-nip46').click();

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(page.locator('#nip46-modal-title')).toHaveText('Connect with Remote Signer');
  });

  test('NIP-46 modal has a bunker URL input, Cancel, and Connect buttons', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modal = page.locator('#nip46-modal');

    const bunkerInput = modal.locator('#bunker-url');
    await expect(bunkerInput).toBeVisible();
    await expect(bunkerInput).toHaveAttribute('placeholder', 'bunker://...');

    await expect(modal.locator('#nip46-cancel')).toBeVisible();
    await expect(modal.locator('#nip46-connect')).toBeVisible();
  });

  test('Cancel button closes the NIP-46 modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modal = page.locator('#nip46-modal');
    await expect(modal).not.toHaveClass(/hidden/);

    await modal.locator('#nip46-cancel').click();

    await expect(modal).toHaveClass(/hidden/);
  });

  test('close (X) button closes the NIP-46 modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modal = page.locator('#nip46-modal');
    await expect(modal).not.toHaveClass(/hidden/);

    await modal.locator('#nip46-modal-close').click();

    await expect(modal).toHaveClass(/hidden/);
  });

  test('Escape key closes the NIP-46 modal', async ({ page }) => {
    await page.locator('#connect-nip46').click();
    const modal = page.locator('#nip46-modal');
    await expect(modal).not.toHaveClass(/hidden/);

    await page.keyboard.press('Escape');

    await expect(modal).toHaveClass(/hidden/);
  });

  test('Tab navigation reaches both connect buttons in order', async ({ page }) => {
    // Wait for the landing page to fully render before tabbing — without this
    // the Tab presses race the React mount and focus stays on the body.
    await page.locator('#connect-nip07').waitFor({ state: 'visible', timeout: 10_000 });

    // Tab forward from the top of the page (through the shared header's logo
    // link, Apps button, and Sign In button) and confirm keyboard users reach
    // both landing connect buttons, in document order.
    const focusedIds = [];
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement?.id ?? '');
      if (id) focusedIds.push(id);
      if (id === 'connect-nip46') break;
    }

    expect(focusedIds).toContain('connect-nip07');
    expect(focusedIds).toContain('connect-nip46');
    expect(focusedIds.indexOf('connect-nip07')).toBeLessThan(focusedIds.indexOf('connect-nip46'));
  });
});
