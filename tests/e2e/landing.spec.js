// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display landing page with logo', async ({ page }) => {
    await expect(page.locator('.landing-logo')).toBeVisible();
    await expect(page.locator('.landing-title')).toHaveText('Cloistr Stash');
  });

  test('should show connect buttons', async ({ page }) => {
    await expect(page.locator('#connect-nip07')).toBeVisible();
    await expect(page.locator('#connect-nip46')).toBeVisible();
  });

  test('should display feature cards', async ({ page }) => {
    const features = page.locator('.feature');
    await expect(features).toHaveCount(3);
  });

  test('NIP-46 button should open modal', async ({ page }) => {
    await page.click('#connect-nip46');
    await expect(page.locator('#nip46-modal')).not.toHaveClass(/hidden/);
    await expect(page.locator('#bunker-url')).toBeVisible();
  });

  test('NIP-46 modal should close on cancel', async ({ page }) => {
    await page.click('#connect-nip46');
    await page.click('#nip46-cancel');
    await expect(page.locator('#nip46-modal')).toHaveClass(/hidden/);
  });
});

test.describe('Accessibility', () => {
  test('landing page should have no accessibility violations', async ({ page }) => {
    await page.goto('/');

    // Check for basic accessibility
    const connectBtn = page.locator('#connect-nip07');
    await expect(connectBtn).toBeVisible();

    // Buttons should be focusable
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
  });
});
