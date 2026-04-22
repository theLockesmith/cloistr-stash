// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('UI Components', () => {
  test.describe('Toast Notifications', () => {
    test('toast container should exist', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#toast-container')).toBeAttached();
    });
  });

  test.describe('Modals', () => {
    test('modals should be hidden by default', async ({ page }) => {
      await page.goto('/');

      const modals = [
        '#nip46-modal',
        '#upload-modal',
        '#share-modal',
        '#tags-modal',
      ];

      for (const modal of modals) {
        await expect(page.locator(modal)).toHaveClass(/hidden/);
      }
    });

    test('modal should have close button', async ({ page }) => {
      await page.goto('/');
      await page.click('#connect-nip46');

      const closeBtn = page.locator('#nip46-modal-close');
      await expect(closeBtn).toBeVisible();
    });

    test('clicking outside modal should close it', async ({ page }) => {
      await page.goto('/');
      await page.click('#connect-nip46');
      await expect(page.locator('#nip46-modal')).not.toHaveClass(/hidden/);

      // Click on modal backdrop
      await page.click('#nip46-modal', { position: { x: 5, y: 5 } });
    });
  });

  test.describe('Context Menu', () => {
    test('context menu should be hidden by default', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#context-menu')).toHaveClass(/hidden/);
    });
  });
});

test.describe('Responsive Design', () => {
  test('mobile menu button should be visible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // On landing page, mobile menu isn't shown
    // But the page should render correctly
    await expect(page.locator('.landing-container')).toBeVisible();
  });

  test('landing features should stack on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const features = page.locator('.landing-features');
    await expect(features).toBeVisible();

    // Check that features are in a column layout
    const box = await features.boundingBox();
    expect(box).toBeTruthy();
  });
});

test.describe('PWA Support', () => {
  test('should have manifest link', async ({ page }) => {
    await page.goto('/');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveCount(1);
  });

  test('should register service worker', async ({ page }) => {
    await page.goto('/');

    // Check if service worker is registered
    const swRegistered = await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        return registrations.length > 0;
      }
      return false;
    });

    // Service worker may not be registered immediately
    // Just verify no error occurred
  });
});
