// @ts-check
/**
 * Authenticated app shell: header chrome, the "New" dropdown, sidebar
 * (views + folder tree), and the file browser toolbar/list.
 *
 * These are DOM-presence and basic-interaction tests against the current
 * React app (AppShell + Sidebar + Breadcrumbs + SearchBar + FileBrowser).
 * They intentionally avoid asserting on file/folder data, since this
 * environment has no seeded backend state -- only structure and interaction.
 */
const { test, expect, login } = require('./fixtures');

test.describe('Content header', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('breadcrumb bar shows the "My Stash" root', async ({ page }) => {
    const breadcrumbBar = page.locator('#breadcrumb-bar');
    await expect(breadcrumbBar).toBeVisible();

    const root = page.locator('#breadcrumb .breadcrumb-item');
    await expect(root).toBeVisible();
    await expect(root).toHaveText('My Stash');
    await expect(root).toHaveClass(/active/);
    await expect(root).toHaveAttribute('data-id', '');
  });

  test('New button is visible', async ({ page }) => {
    await expect(page.locator('#new-btn')).toBeVisible();
  });

  test('search input is visible with a placeholder', async ({ page }) => {
    const searchInput = page.locator('.search-input');
    await expect(searchInput).toBeVisible();
    const placeholder = await searchInput.getAttribute('placeholder');
    expect(placeholder).toMatch(/search files/i);
  });

  test('Upload button is visible', async ({ page }) => {
    const uploadBtn = page.locator('.upload-btn');
    await expect(uploadBtn).toBeVisible();
    await expect(uploadBtn).toContainText('Upload');
  });

  test('backup button is visible', async ({ page }) => {
    await expect(page.locator('#backup-btn')).toBeVisible();
  });
});

test.describe('New dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('clicking #new-btn shows the dropdown', async ({ page }) => {
    const dropdown = page.locator('#new-dropdown-content');
    await expect(dropdown).not.toHaveClass(/show/);

    await page.locator('#new-btn').click();

    await expect(dropdown).toHaveClass(/show/);
  });

  test('has Folder, Document, Spreadsheet, Whiteboard, and Presentation items', async ({ page }) => {
    await page.locator('#new-btn').click();
    const dropdown = page.locator('#new-dropdown-content');

    const items = [
      { type: 'folder', label: 'Folder' },
      { type: 'doc', label: 'Document' },
      { type: 'sheet', label: 'Spreadsheet' },
      { type: 'whiteboard', label: 'Whiteboard' },
      { type: 'slides', label: 'Presentation' },
    ];

    for (const { type, label } of items) {
      const item = dropdown.locator(`.dropdown-item[data-type="${type}"]`);
      await expect(item).toBeAttached();
      await expect(item).toContainText(label);
    }
  });

  test('clicking the Folder item opens the New Folder modal', async ({ page }) => {
    const modal = page.locator('#new-folder-modal');
    await expect(modal).toHaveClass(/hidden/);

    await page.locator('#new-btn').click();
    await page.locator('.dropdown-item[data-type="folder"]').click();

    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
  });
});

test.describe('Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('sidebar is visible and labeled as navigation', async ({ page }) => {
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('aria-label', /navigation/i);
  });

  test('shows a "Folders" heading', async ({ page }) => {
    await expect(page.locator('#sidebar-title')).toHaveText('Folders');
  });

  test('has view buttons for My Files, Shared, Starred, Recent, and Trash', async ({ page }) => {
    const labels = ['My Files', 'Shared', 'Starred', 'Recent', 'Trash'];
    for (const label of labels) {
      await expect(page.locator('.sidebar-view', { hasText: label })).toBeVisible();
    }
  });

  test('My Files is active by default', async ({ page }) => {
    const myFiles = page.locator('.sidebar-view', { hasText: 'My Files' });
    const shared = page.locator('.sidebar-view', { hasText: 'Shared' });
    await expect(myFiles).toHaveClass(/active/);
    await expect(shared).not.toHaveClass(/active/);
  });

  test('clicking Shared switches the active view', async ({ page }) => {
    const myFiles = page.locator('.sidebar-view', { hasText: 'My Files' });
    const shared = page.locator('.sidebar-view', { hasText: 'Shared' });

    await shared.click();

    await expect(shared).toHaveClass(/active/);
    await expect(myFiles).not.toHaveClass(/active/);
  });

  test('has Notifications and Activity nav items', async ({ page }) => {
    const notifications = page.locator('#nav-notifications');
    await expect(notifications).toBeVisible();
    await expect(notifications).toContainText('Notifications');

    const activity = page.locator('#nav-activity');
    await expect(activity).toBeVisible();
    await expect(activity).toContainText('Activity');
  });

  test('folder tree has a "My Stash" root with tree role', async ({ page }) => {
    const tree = page.locator('#folder-tree');
    await expect(tree).toHaveAttribute('role', 'tree');

    const root = tree.locator('.folder-tree-item.root');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('role', 'treeitem');
    await expect(root.locator('.folder-tree-name')).toHaveText('My Stash');
  });

  test('root folder is selected by default', async ({ page }) => {
    const root = page.locator('.folder-tree-item.root');
    await expect(root).toHaveAttribute('aria-selected', 'true');
    await expect(root).toHaveClass(/active/);
  });
});

test.describe('File browser', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('file list body is present with list role', async ({ page }) => {
    const list = page.locator('#file-list-body');
    await expect(list).toBeAttached();
    await expect(list).toHaveAttribute('role', 'list');
  });

  test('has list and grid view toggle buttons', async ({ page }) => {
    const listBtn = page.locator('.fb-view-btn[aria-label="List view"]');
    const gridBtn = page.locator('.fb-view-btn[aria-label="Grid view"]');
    await expect(listBtn).toBeVisible();
    await expect(gridBtn).toBeVisible();

    // List view is the default.
    await expect(listBtn).toHaveClass(/active/);
    await expect(gridBtn).not.toHaveClass(/active/);
  });

  test('switching to grid view updates the toggle state', async ({ page }) => {
    const listBtn = page.locator('.fb-view-btn[aria-label="List view"]');
    const gridBtn = page.locator('.fb-view-btn[aria-label="Grid view"]');

    await gridBtn.click();

    await expect(gridBtn).toHaveClass(/active/);
    await expect(listBtn).not.toHaveClass(/active/);
  });

  test('has a sort field selector', async ({ page }) => {
    // The fb-toolbar renders after the file browser initializes; wait for it.
    const toolbar = page.locator('.fb-toolbar');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    const sortSelect = page.locator('#fb-sort-field');
    await expect(sortSelect).toBeVisible();

    // Use auto-retrying assertions so we wait for the options to populate
    // rather than snapshotting with allTextContents() and racing React.
    await expect(sortSelect.locator('option')).toHaveCount(3);
    await expect(sortSelect.locator('option', { hasText: 'Name' })).toBeAttached();
    await expect(sortSelect.locator('option', { hasText: 'Date' })).toBeAttached();
    await expect(sortSelect.locator('option', { hasText: 'Size' })).toBeAttached();
  });

  test('renders either the empty state or a file list', async ({ page }) => {
    const empty = page.locator('.fb-empty');
    const list = page.locator('#file-list-body');

    await expect(list).toBeAttached();
    // One of the two must be true: no files (empty state shown) or files
    // present as rows inside the list body.
    const hasEmptyState = await empty.count();
    const hasRows = await list.locator('.fb-row').count();
    expect(hasEmptyState > 0 || hasRows > 0).toBeTruthy();
  });
});

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('search input is present', async ({ page }) => {
    await expect(page.locator('.search-input')).toBeVisible();
  });

  test('typing shows the clear button', async ({ page }) => {
    const searchInput = page.locator('.search-input');
    const clearBtn = page.locator('.search-clear');

    await expect(clearBtn).toHaveCount(0);

    await searchInput.fill('test');

    await expect(clearBtn).toBeVisible();
  });

  test('clearing the search removes the input value and the clear button', async ({ page }) => {
    const searchInput = page.locator('.search-input');
    const clearBtn = page.locator('.search-clear');

    await searchInput.fill('test');
    await expect(clearBtn).toBeVisible();

    await clearBtn.click();

    await expect(searchInput).toHaveValue('');
    await expect(clearBtn).toHaveCount(0);
  });
});
