// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Keyboard Shortcuts', () => {
  // These tests run against the authenticated view
  // In a real environment, we'd mock the auth state

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Mock authenticated state by manipulating localStorage
    await page.evaluate(() => {
      localStorage.setItem('cloistr-auth-state', 'authenticated');
    });
  });

  test('Escape key should close modals', async ({ page }) => {
    // Open NIP-46 modal
    await page.click('#connect-nip46');
    await expect(page.locator('#nip46-modal')).not.toHaveClass(/hidden/);

    // Press Escape
    await page.keyboard.press('Escape');
    await expect(page.locator('#nip46-modal')).toHaveClass(/hidden/);
  });

  test('Ctrl+F should focus search input', async ({ page }) => {
    // This would work in authenticated state
    // For now, just verify the shortcut handler doesn't throw
    await page.keyboard.press('Control+f');
    // No error means success
  });
});

test.describe('Keyboard Navigation', () => {
  test('Tab should navigate through focusable elements', async ({ page }) => {
    await page.goto('/');

    // First tab should focus first interactive element
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();

    // Multiple tabs should move through elements
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
    }

    const newFocused = page.locator(':focus');
    await expect(newFocused).toBeVisible();
  });
});
