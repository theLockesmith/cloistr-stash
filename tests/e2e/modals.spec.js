// @ts-check
/**
 * Modal presence and structure tests.
 *
 * After authentication, the React app renders a fixed set of modals directly
 * into the DOM (never conditionally unmounted) with `class="modal hidden"` by
 * default; visibility is toggled by adding/removing the `hidden` class, not by
 * conditional rendering or inline display/visibility styles. Some modals
 * (Share, ManageShares, VersionHistory, Rename, Move, Publish, Confirm,
 * Migration) are portal-rendered by @cloistr/ui and are NOT always present in
 * the DOM — those are out of scope here except where noted.
 */
const { test, expect, login } = require('./fixtures');

/** Modals that are always attached to the DOM and hidden via `.modal.hidden`. */
const ALWAYS_PRESENT_MODALS = [
  '#new-folder-modal',
  '#keyboard-shortcuts-modal',
  '#encryption-info-modal',
  '#file-info-modal',
  '#preview-modal',
  '#editor-modal',
  '#comments-modal',
  '#backup-modal',
  '#activity-modal',
  '#notifications-modal',
];

test.describe('All modals hidden by default', () => {
  for (const selector of ALWAYS_PRESENT_MODALS) {
    test(`${selector} is attached and hidden`, async ({ page }) => {
      await login(page);
      const modal = page.locator(selector);
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/\bmodal\b/);
      await expect(modal).toHaveClass(/\bhidden\b/);
      await expect(modal).not.toBeVisible();
    });
  }

  test('#folder-customize-modal is attached and hidden', async ({ page }) => {
    await login(page);
    // .first(): #folder-customize-modal is (as of this writing) rendered
    // twice — the real, wired-up FolderCustomizeModal from FileBrowser plus a
    // leftover static stub in App.tsx sharing the same id. .first() keeps
    // this assertion valid whichever one (or both) the DOM currently has, and
    // it keeps working once the duplicate is cleaned up.
    const modal = page.locator('#folder-customize-modal').first();
    await expect(modal).toBeAttached();
    await expect(modal).toHaveClass(/\bmodal\b/);
    await expect(modal).toHaveClass(/\bhidden\b/);
    await expect(modal).not.toBeVisible();
  });

  test('#context-menu is attached and hidden', async ({ page }) => {
    await login(page);
    const menu = page.locator('#context-menu');
    await expect(menu).toBeAttached();
    await expect(menu).toHaveClass(/\bcontext-menu\b/);
    await expect(menu).toHaveClass(/\bhidden\b/);
    await expect(menu).not.toBeVisible();
  });
});

test.describe('New Folder modal', () => {
  async function openNewFolderModal(page) {
    await page.locator('#new-btn').click();
    await page.locator('.dropdown-item[data-type="folder"]').click();
    const modal = page.locator('#new-folder-modal');
    await expect(modal).not.toHaveClass(/hidden/);
    return modal;
  }

  test('opens when triggered from the New dropdown', async ({ page }) => {
    await login(page);
    const modal = await openNewFolderModal(page);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-header h2')).toHaveText('New Folder');
  });

  test('has a name input with a placeholder', async ({ page }) => {
    await login(page);
    await openNewFolderModal(page);
    const input = page.locator('#new-folder-name');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Folder name');
  });

  test('has Cancel and Create Folder buttons', async ({ page }) => {
    await login(page);
    await openNewFolderModal(page);
    await expect(page.locator('#new-folder-cancel')).toHaveText('Cancel');
    await expect(page.locator('#new-folder-create')).toHaveText('Create Folder');
  });

  test('Cancel closes the modal', async ({ page }) => {
    await login(page);
    const modal = await openNewFolderModal(page);
    await page.locator('#new-folder-cancel').click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test('close (X) button closes the modal', async ({ page }) => {
    await login(page);
    const modal = await openNewFolderModal(page);
    await page.locator('#new-folder-modal-close').click();
    await expect(modal).toHaveClass(/hidden/);
  });
});

test.describe('Backup modal', () => {
  test('opens when #backup-btn is clicked', async ({ page }) => {
    await login(page);
    const modal = page.locator('#backup-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.locator('#backup-btn').click();

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-header h2')).toHaveText('Key Backup');
  });

  test('has an export section with a Download Backup button', async ({ page }) => {
    await login(page);
    await page.locator('#backup-btn').click();
    const modal = page.locator('#backup-modal');

    const exportSection = modal.locator('#backup-export');
    await expect(exportSection).toBeVisible();
    await expect(modal.locator('#backup-export-btn')).toHaveText('Download Backup');
  });

  test('has an import section with a Select Backup File button', async ({ page }) => {
    await login(page);
    await page.locator('#backup-btn').click();
    const modal = page.locator('#backup-modal');

    const importSection = modal.locator('#backup-import');
    await expect(importSection).toBeVisible();
    await expect(modal.locator('#backup-import-btn')).toHaveText('Select Backup File');
  });

  test('has a hidden file input for import', async ({ page }) => {
    await login(page);
    await page.locator('#backup-btn').click();
    const fileInput = page.locator('#backup-file-input');

    await expect(fileInput).toBeAttached();
    await expect(fileInput).toHaveAttribute('type', 'file');
    await expect(fileInput).toBeHidden();
  });

  test('close button closes it', async ({ page }) => {
    await login(page);
    const modal = page.locator('#backup-modal');
    await page.locator('#backup-btn').click();
    await expect(modal).not.toHaveClass(/hidden/);

    await page.locator('#backup-modal-close').click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test('footer Close button also closes it', async ({ page }) => {
    await login(page);
    const modal = page.locator('#backup-modal');
    await page.locator('#backup-btn').click();
    await expect(modal).not.toHaveClass(/hidden/);

    await page.locator('#backup-close').click();
    await expect(modal).toHaveClass(/hidden/);
  });
});

test.describe('Keyboard Shortcuts modal', () => {
  test('opens when ? key is pressed', async ({ page }) => {
    await login(page);
    const modal = page.locator('#keyboard-shortcuts-modal');
    await expect(modal).toHaveClass(/hidden/);

    // Click a neutral area first so focus isn't inside a text input, which
    // would suppress the shortcut per the app's isTypingTarget() guard.
    await page.locator('.stash-content').click();
    await page.keyboard.press('?');

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
  });

  test('has shortcut items with kbd elements', async ({ page }) => {
    await login(page);
    await page.locator('.stash-content').click();
    await page.keyboard.press('?');

    const modal = page.locator('#keyboard-shortcuts-modal');
    const list = modal.locator('.shortcuts-list');
    await expect(list).toBeVisible();

    const items = list.locator('.shortcut-item');
    await expect(items.first()).toBeAttached();
    expect(await items.count()).toBeGreaterThan(0);
    await expect(list.locator('kbd').first()).toBeAttached();
  });

  test('Done button closes it', async ({ page }) => {
    await login(page);
    const modal = page.locator('#keyboard-shortcuts-modal');
    await page.locator('.stash-content').click();
    await page.keyboard.press('?');
    await expect(modal).not.toHaveClass(/hidden/);

    await page.locator('#keyboard-shortcuts-done').click();
    await expect(modal).toHaveClass(/hidden/);
  });
});

test.describe('Encryption Info modal', () => {
  // The modal container is always in the DOM; its content (#key-hierarchy)
  // is conditionally rendered only when a file is selected, so we can only
  // verify the container and its close/done buttons here.
  test('container and done button are in the DOM', async ({ page }) => {
    await login(page);
    const modal = page.locator('#encryption-info-modal');
    await expect(modal).toBeAttached();
    await expect(modal).toHaveClass(/hidden/);
    await expect(modal.locator('#encryption-info-close')).toBeAttached();
    await expect(modal.locator('#encryption-info-done')).toBeAttached();
    await expect(modal.locator('#encryption-info-done')).toHaveText('Done');
  });
});

test.describe('Comments modal', () => {
  // Not reachable without a selected file in this test environment; verify
  // presence/structure only.
  test('has a comment input textarea', async ({ page }) => {
    await login(page);
    const modal = page.locator('#comments-modal');
    const textarea = modal.locator('#comment-input');
    await expect(textarea).toBeAttached();
    await expect(textarea).toHaveAttribute('placeholder', 'Add a comment...');
  });

  test('has an Add Comment button', async ({ page }) => {
    await login(page);
    const modal = page.locator('#comments-modal');
    const addButton = modal.locator('#add-comment-btn');
    await expect(addButton).toBeAttached();
    await expect(addButton).toHaveText('Add Comment');
  });

  test('has a comments list container', async ({ page }) => {
    await login(page);
    const modal = page.locator('#comments-modal');
    await expect(modal.locator('#comments-list')).toBeAttached();
  });
});
