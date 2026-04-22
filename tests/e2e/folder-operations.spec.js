// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Folder Operations - UI Structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test.describe('New Folder Modal Structure', () => {
    test('new button exists in DOM', async ({ page }) => {
      const newButton = page.locator('#new-btn');
      await expect(newButton).toBeAttached();
      await expect(newButton).toContainText('New');
    });

    test('new dropdown content exists with folder option', async ({ page }) => {
      // Verify dropdown container exists
      const dropdown = page.locator('#new-dropdown-content');
      await expect(dropdown).toBeAttached();

      // Verify Folder option exists in dropdown
      const folderOption = page.locator('[data-type="folder"]');
      await expect(folderOption).toBeAttached();
      await expect(folderOption).toContainText('Folder');
    });

    test('new folder modal exists with proper structure', async ({ page }) => {
      // Verify New Folder modal exists
      const modal = page.locator('#new-folder-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      // Check modal header
      await expect(modal.locator('h2')).toContainText('New Folder');
      await expect(modal.locator('#new-folder-modal-close')).toBeAttached();
    });

    test('modal has name input field with proper attributes', async ({ page }) => {
      const modal = page.locator('#new-folder-modal');

      // Check name input field
      const nameInput = modal.locator('#new-folder-name');
      await expect(nameInput).toBeAttached();
      await expect(nameInput).toHaveAttribute('placeholder', 'Folder name');
      await expect(nameInput).toHaveAttribute('autocomplete', 'off');
      await expect(nameInput).toHaveAttribute('autofocus');
    });

    test('modal has cancel and create buttons', async ({ page }) => {
      const modal = page.locator('#new-folder-modal');

      // Check buttons exist
      const cancelBtn = modal.locator('#new-folder-cancel');
      const createBtn = modal.locator('#new-folder-create');

      await expect(cancelBtn).toBeAttached();
      await expect(cancelBtn).toContainText('Cancel');

      await expect(createBtn).toBeAttached();
      await expect(createBtn).toContainText('Create Folder');
      await expect(createBtn).toHaveClass(/btn-primary/);
    });

    test('modal has proper description and help text', async ({ page }) => {
      const modal = page.locator('#new-folder-modal');

      const description = modal.locator('.modal-description');
      await expect(description).toContainText('Create a new encrypted folder');

      const helpText = modal.locator('.modal-help');
      await expect(helpText).toContainText('Folder contents will be encrypted with a unique key');
    });
  });

  test.describe('Folder Tree Sidebar Structure', () => {
    test('sidebar exists with proper structure', async ({ page }) => {
      const sidebar = page.locator('#sidebar');
      await expect(sidebar).toBeAttached();
      await expect(sidebar).toHaveAttribute('role', 'navigation');
      await expect(sidebar).toHaveAttribute('aria-label', 'File navigation');
    });

    test('sidebar header exists with title and toggle', async ({ page }) => {
      const sidebarHeader = page.locator('.sidebar-header');
      await expect(sidebarHeader).toBeAttached();

      const title = page.locator('#sidebar-title');
      await expect(title).toContainText('Folders');

      const toggle = page.locator('#sidebar-toggle');
      await expect(toggle).toBeAttached();
      await expect(toggle).toHaveAttribute('title', 'Toggle sidebar');
      await expect(toggle).toHaveAttribute('aria-label', 'Toggle sidebar');
      await expect(toggle).toHaveAttribute('aria-expanded');
    });

    test('folder tree exists with proper ARIA attributes', async ({ page }) => {
      const folderTree = page.locator('#folder-tree');
      await expect(folderTree).toBeAttached();
      await expect(folderTree).toHaveAttribute('role', 'tree');
      await expect(folderTree).toHaveAttribute('aria-labelledby', 'sidebar-title');
    });

    test('root folder (My Stash) exists with proper structure', async ({ page }) => {
      const rootFolder = page.locator('.folder-tree-item.root');
      await expect(rootFolder).toBeAttached();
      await expect(rootFolder).toHaveAttribute('role', 'treeitem');
      await expect(rootFolder).toHaveAttribute('tabindex', '0');
      await expect(rootFolder).toHaveAttribute('aria-selected', 'true');

      const rootName = rootFolder.locator('.folder-tree-name');
      await expect(rootName).toContainText('My Stash');

      const rootIcon = rootFolder.locator('.folder-tree-icon');
      await expect(rootIcon).toBeAttached();
      await expect(rootIcon).toHaveAttribute('aria-hidden', 'true');
    });

    test('folder tree children container exists', async ({ page }) => {
      const treeChildren = page.locator('#folder-tree-root');
      await expect(treeChildren).toBeAttached();
      await expect(treeChildren).toHaveAttribute('role', 'group');
    });

    test('sidebar navigation section exists', async ({ page }) => {
      const sidebarNav = page.locator('.sidebar-section');
      await expect(sidebarNav).toBeAttached();
      await expect(sidebarNav).toHaveAttribute('role', 'navigation');
      await expect(sidebarNav).toHaveAttribute('aria-label', 'Quick access');

      // Check key navigation items exist
      const navItems = [
        { id: '#nav-starred', text: 'Starred' },
        { id: '#nav-recent', text: 'Recent' },
        { id: '#nav-trash', text: 'Trash' },
        { id: '#nav-activity', text: 'Activity' },
        { id: '#nav-notifications', text: 'Notifications' }
      ];

      for (const item of navItems) {
        const navItem = page.locator(item.id);
        await expect(navItem).toBeAttached();
        await expect(navItem).toContainText(item.text);
        await expect(navItem).toHaveAttribute('role', 'button');
        await expect(navItem).toHaveAttribute('tabindex', '0');
      }
    });
  });

  test.describe('Breadcrumbs Structure', () => {
    test('breadcrumb bar exists', async ({ page }) => {
      const breadcrumbBar = page.locator('#breadcrumb-bar');
      await expect(breadcrumbBar).toBeAttached();
    });

    test('breadcrumb container exists with proper structure', async ({ page }) => {
      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toBeAttached();
    });

    test('root breadcrumb (My Stash) exists with proper attributes', async ({ page }) => {
      const breadcrumbItem = page.locator('.breadcrumb-item');
      await expect(breadcrumbItem).toBeAttached();
      await expect(breadcrumbItem).toContainText('My Stash');
      await expect(breadcrumbItem).toHaveAttribute('data-id', '');
      await expect(breadcrumbItem).toHaveClass(/active/);
    });
  });

  test.describe('Folder Customize Modal Structure', () => {
    test('folder customize modal exists (hidden by default)', async ({ page }) => {
      const modal = page.locator('#folder-customize-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
    });

    test('modal has proper header structure', async ({ page }) => {
      const modal = page.locator('#folder-customize-modal');
      await expect(modal.locator('h2')).toContainText('Customize Folder');
      await expect(modal.locator('#folder-customize-close')).toBeAttached();
    });

    test('modal has folder name display', async ({ page }) => {
      const folderNameDisplay = page.locator('#customize-folder-name');
      await expect(folderNameDisplay).toBeAttached();
      await expect(folderNameDisplay).toHaveClass(/folder-name-display/);
    });

    test('modal has color picker section', async ({ page }) => {
      const colorSection = page.locator('.customize-section').filter({ hasText: 'Color' });
      await expect(colorSection).toBeAttached();

      const colorPicker = page.locator('#folder-color-picker');
      await expect(colorPicker).toBeAttached();
      await expect(colorPicker).toHaveClass(/color-picker/);
    });

    test('modal has icon picker section', async ({ page }) => {
      const iconSection = page.locator('.customize-section').filter({ hasText: 'Icon' });
      await expect(iconSection).toBeAttached();

      const iconPicker = page.locator('#folder-icon-picker');
      await expect(iconPicker).toBeAttached();
      await expect(iconPicker).toHaveClass(/icon-picker/);
    });

    test('modal has save and reset buttons', async ({ page }) => {
      const modal = page.locator('#folder-customize-modal');

      const saveBtn = modal.locator('#folder-customize-save');
      await expect(saveBtn).toBeAttached();
      await expect(saveBtn).toContainText('Save');
      await expect(saveBtn).toHaveClass(/btn-primary/);

      const resetBtn = modal.locator('#folder-customize-reset');
      await expect(resetBtn).toBeAttached();
      await expect(resetBtn).toContainText('Reset');
    });
  });

  test.describe('Integration - All Folder UI Elements', () => {
    test('all folder-related elements are present in DOM', async ({ page }) => {
      // Verify all key folder UI elements exist together
      await expect(page.locator('#new-btn')).toBeAttached();
      await expect(page.locator('#sidebar')).toBeAttached();
      await expect(page.locator('#breadcrumb-bar')).toBeAttached();
      await expect(page.locator('#folder-tree')).toBeAttached();
      await expect(page.locator('.folder-tree-item.root')).toBeAttached();
      await expect(page.locator('.breadcrumb-item')).toBeAttached();
      await expect(page.locator('#new-folder-modal')).toBeAttached();
      await expect(page.locator('#folder-customize-modal')).toBeAttached();
    });

    test('modals are hidden by default', async ({ page }) => {
      const modals = [
        '#new-folder-modal',
        '#folder-customize-modal'
      ];

      for (const modal of modals) {
        await expect(page.locator(modal)).toHaveClass(/hidden/);
      }
    });

    test('dropdown items have proper data attributes', async ({ page }) => {
      const dropdownItems = page.locator('.dropdown-item');

      // Folder option should have data-type="folder"
      const folderItem = page.locator('[data-type="folder"]');
      await expect(folderItem).toBeAttached();
      await expect(folderItem.locator('.dropdown-icon')).toContainText('📁');

      // Check other collaborative items exist
      const collaborativeItems = [
        '[data-type="doc"]',
        '[data-type="sheet"]',
        '[data-type="whiteboard"]',
        '[data-type="slides"]'
      ];

      for (const item of collaborativeItems) {
        await expect(page.locator(item)).toBeAttached();
      }
    });

    test('storage usage section exists in sidebar', async ({ page }) => {
      const storageUsage = page.locator('#storage-usage');
      await expect(storageUsage).toBeAttached();

      await expect(storageUsage.locator('.storage-info')).toBeAttached();
      await expect(storageUsage.locator('#storage-value')).toBeAttached();
      await expect(storageUsage.locator('.storage-bar')).toBeAttached();
      await expect(storageUsage.locator('#storage-bar-fill')).toBeAttached();
    });
  });
});

test.describe('Folder Operations - Responsive Design', () => {
  test('mobile menu button exists for mobile view', async ({ page }) => {
    await page.goto('/');

    const mobileMenuBtn = page.locator('#mobile-menu-btn');
    await expect(mobileMenuBtn).toBeAttached();
    await expect(mobileMenuBtn).toHaveAttribute('title', 'Menu');
  });

  test('sidebar overlay exists for mobile', async ({ page }) => {
    await page.goto('/');

    const sidebarOverlay = page.locator('#sidebar-overlay');
    await expect(sidebarOverlay).toBeAttached();
    await expect(sidebarOverlay).toHaveClass(/sidebar-overlay/);
  });

  test('responsive elements maintain structure on different viewports', async ({ page }) => {
    await page.goto('/');

    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Key elements should still be present
    await expect(page.locator('#sidebar')).toBeAttached();
    await expect(page.locator('#breadcrumb-bar')).toBeAttached();
    await expect(page.locator('#new-btn')).toBeAttached();
    await expect(page.locator('#mobile-menu-btn')).toBeAttached();

    // Test tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });

    await expect(page.locator('#sidebar')).toBeAttached();
    await expect(page.locator('#breadcrumb-bar')).toBeAttached();
    await expect(page.locator('#new-btn')).toBeAttached();
  });
});

test.describe('Folder Operations - Accessibility Structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('folder tree has proper ARIA structure', async ({ page }) => {
    const folderTree = page.locator('#folder-tree');
    await expect(folderTree).toHaveAttribute('role', 'tree');

    const rootItem = page.locator('.folder-tree-item.root');
    await expect(rootItem).toHaveAttribute('role', 'treeitem');
    await expect(rootItem).toHaveAttribute('tabindex', '0');
    await expect(rootItem).toHaveAttribute('aria-selected', 'true');
  });

  test('buttons have proper accessibility attributes', async ({ page }) => {
    const sidebarToggle = page.locator('#sidebar-toggle');
    await expect(sidebarToggle).toHaveAttribute('aria-label', 'Toggle sidebar');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded');

    const newBtn = page.locator('#new-btn');
    await expect(newBtn).toBeAttached();
    // New button should be focusable
    await expect(newBtn).not.toHaveAttribute('tabindex', '-1');
  });

  test('modal close buttons have proper attributes', async ({ page }) => {
    const newFolderClose = page.locator('#new-folder-modal-close');
    await expect(newFolderClose).toBeAttached();

    const customizeClose = page.locator('#folder-customize-close');
    await expect(customizeClose).toBeAttached();
  });

  test('navigation items have proper ARIA roles', async ({ page }) => {
    const navItems = page.locator('.sidebar-nav-item');

    for (let i = 0; i < await navItems.count(); i++) {
      const item = navItems.nth(i);
      await expect(item).toHaveAttribute('role', 'button');
      await expect(item).toHaveAttribute('tabindex', '0');
    }
  });

  test('form inputs have proper labels', async ({ page }) => {
    const modal = page.locator('#new-folder-modal');
    const nameInput = modal.locator('#new-folder-name');

    await expect(nameInput).toHaveAttribute('placeholder', 'Folder name');
    await expect(nameInput).toHaveAttribute('autocomplete', 'off');
  });
});