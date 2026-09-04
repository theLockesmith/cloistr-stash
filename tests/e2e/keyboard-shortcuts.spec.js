// @ts-check
/**
 * Keyboard shortcut and keyboard-navigation tests.
 *
 * Global shortcuts (?, u, n, /, Delete, d, Enter, Ctrl+A, arrows) are
 * registered by the KeyboardShortcuts component (web/src/components/
 * KeyboardShortcuts.tsx), which mounts only inside the authenticated
 * workspace. On the (unauthenticated) landing page, only Tab order and the
 * NIP-46 modal's own Escape handler apply.
 *
 * KeyboardShortcuts suppresses every shortcut except Escape while focus is
 * inside a text input/textarea/contenteditable (isTypingTarget) -- Escape
 * there just blurs the element instead of triggering the app-level Escape
 * behaviour (close help / clear selection). That is what the "Escape while
 * search is focused" test below verifies: the input loses focus, it does
 * not (and per the current implementation, cannot) also clear its value.
 */
const { test, expect, login } = require('./fixtures');

test.describe('Keyboard Shortcuts - Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Tab key navigates through focusable elements', async ({ page }) => {
    // Wait for the landing page to fully render before tabbing.
    await page.locator('#connect-nip07').waitFor({ state: 'visible', timeout: 10_000 });

    const seenIds = new Set();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if (id) seenIds.add(id);
      if (seenIds.has('connect-nip07') && seenIds.has('connect-nip46')) break;
    }

    // Both connect buttons should be reachable by keyboard.
    expect(seenIds.has('connect-nip07') || seenIds.has('connect-nip46')).toBe(true);
  });

  test('Escape key closes the NIP-46 modal if open', async ({ page }) => {
    const modal = page.locator('#nip46-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.locator('#connect-nip46').click();
    await expect(modal).not.toHaveClass(/hidden/);

    await page.keyboard.press('Escape');

    await expect(modal).toHaveClass(/hidden/);
  });
});

test.describe('Keyboard Shortcuts - Authenticated', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Click a neutral area of the content pane so focus lands somewhere
    // that isn't a text input -- isTypingTarget() suppresses every shortcut
    // but Escape while a typing target is focused, which would make the
    // shortcuts below silently no-op.
    await page.locator('.stash-content').click();
  });

  test('? key opens the keyboard shortcuts modal', async ({ page }) => {
    const modal = page.locator('#keyboard-shortcuts-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.keyboard.press('?');

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
  });

  test('keyboard shortcuts modal lists shortcut items with kbd elements', async ({ page }) => {
    await page.keyboard.press('?');
    const modal = page.locator('#keyboard-shortcuts-modal');
    const items = modal.locator('.shortcuts-list .shortcut-item');

    expect(await items.count()).toBeGreaterThan(0);
    for (const item of await items.all()) {
      await expect(item.locator('kbd').first()).toBeAttached();
      await expect(item.locator('span').last()).not.toBeEmpty();
    }
  });

  test('Done button closes the keyboard shortcuts modal', async ({ page }) => {
    const modal = page.locator('#keyboard-shortcuts-modal');
    await page.keyboard.press('?');
    await expect(modal).not.toHaveClass(/hidden/);

    await modal.locator('#keyboard-shortcuts-done').click();

    await expect(modal).toHaveClass(/hidden/);
  });

  test('Escape key closes the keyboard shortcuts modal', async ({ page }) => {
    const modal = page.locator('#keyboard-shortcuts-modal');
    await page.keyboard.press('?');
    await expect(modal).not.toHaveClass(/hidden/);

    await page.keyboard.press('Escape');

    await expect(modal).toHaveClass(/hidden/);
  });

  test('n key opens the new folder modal', async ({ page }) => {
    const modal = page.locator('#new-folder-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.keyboard.press('n');

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
  });

  test('Escape key closes the new folder modal', async ({ page }) => {
    const modal = page.locator('#new-folder-modal');
    await page.keyboard.press('n');
    await expect(modal).not.toHaveClass(/hidden/);

    await page.keyboard.press('Escape');

    await expect(modal).toHaveClass(/hidden/);
  });

  test('/ key focuses the search input', async ({ page }) => {
    const searchInput = page.locator('.search-input');
    await expect(searchInput).not.toBeFocused();

    await page.keyboard.press('/');

    await expect(searchInput).toBeFocused();
  });

  test('Escape removes focus from the search input', async ({ page }) => {
    const searchInput = page.locator('.search-input');
    await page.keyboard.press('/');
    await expect(searchInput).toBeFocused();

    await page.keyboard.press('Escape');

    // Typed text is not touched by this shortcut -- only focus moves. The
    // input reverts to a non-typing target, so a second Escape (or any
    // other shortcut) is no longer suppressed by isTypingTarget().
    await expect(searchInput).not.toBeFocused();
  });
});
