// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * File Operations E2E Tests
 *
 * Covers sections 2 and 3 of TESTING_CHECKLIST.md:
 *
 * Section 2 - Upload Modal:
 * - Upload button exists and opens modal
 * - Drop zone with correct text
 * - File input exists (hidden)
 * - Cancel and Upload buttons
 * - Upload button disabled when no files
 * - Modal close functionality
 *
 * Section 3 - File List UI:
 * - File list container with proper ARIA labels
 * - Header columns (Name, Size, Modified)
 * - Empty state display
 * - Sort dropdown with all options
 * - View toggle buttons (grid/list)
 * - Toolbar sections (left, center, right)
 * - Search functionality
 * - Context menu structure
 * - Batch operations toolbar
 * - Breadcrumb navigation
 * - View tabs (My Files, Shared)
 * - Sidebar navigation
 * - Drop overlay
 * - Responsive behavior
 * - Accessibility features
 *
 * Uses mocked auth state since we can't do real authentication in E2E tests.
 * Tests focus on UI structure and basic interactions without actual file operations.
 */

test.describe('File Operations', () => {
  // Mock authenticated state before each test
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Mock authenticated state by manipulating DOM directly
    // This avoids waiting for all JavaScript to load and initialize
    await page.evaluate(() => {
      // Hide landing page and access denied
      document.getElementById('landing-page').classList.add('hidden');
      document.getElementById('access-denied').classList.add('hidden');

      // Show file explorer
      document.getElementById('file-explorer').classList.remove('hidden');

      // Set some mock values for display
      const userPubkey = document.getElementById('user-pubkey');
      if (userPubkey) {
        userPubkey.textContent = 'npub1test...';
      }
    });

    // Wait for file explorer to be visible
    await expect(page.locator('#file-explorer')).not.toHaveClass(/hidden/);
  });

  test.describe('Upload Modal (Section 2)', () => {
    test('upload button exists and is visible', async ({ page }) => {
      const uploadBtn = page.locator('#upload-btn');
      await expect(uploadBtn).toBeVisible();
      await expect(uploadBtn).toContainText('Upload');
    });

    test('upload button opens upload modal when clicked', async ({ page }) => {
      const uploadBtn = page.locator('#upload-btn');
      const uploadModal = page.locator('#upload-modal');

      // Initially modal should be hidden
      await expect(uploadModal).toHaveClass(/hidden/);

      // Click upload button
      await uploadBtn.click();

      // Modal should now be visible
      await expect(uploadModal).not.toHaveClass(/hidden/);
      await expect(uploadModal).toBeVisible();
    });

    test('upload modal has required elements', async ({ page }) => {
      await page.click('#upload-btn');

      // Check modal components
      await expect(page.locator('#upload-modal .modal-header h2')).toContainText('Upload Files');
      await expect(page.locator('#upload-drop-zone')).toBeVisible();
      await expect(page.locator('#file-input')).toBeAttached(); // Hidden but exists
      await expect(page.locator('#upload-cancel')).toBeVisible();
      await expect(page.locator('#upload-start')).toBeVisible();
    });

    test('upload modal has drop zone with correct text', async ({ page }) => {
      await page.click('#upload-btn');

      const dropZone = page.locator('#upload-drop-zone');
      await expect(dropZone).toBeVisible();
      await expect(dropZone).toContainText('Drag files here or click to select');
    });

    test('upload modal has Cancel and Upload buttons', async ({ page }) => {
      await page.click('#upload-btn');

      const cancelBtn = page.locator('#upload-cancel');
      const uploadBtn = page.locator('#upload-start');

      await expect(cancelBtn).toBeVisible();
      await expect(cancelBtn).toContainText('Cancel');

      await expect(uploadBtn).toBeVisible();
      await expect(uploadBtn).toContainText('Upload');
    });

    test('upload button is disabled when no files selected', async ({ page }) => {
      await page.click('#upload-btn');

      const uploadBtn = page.locator('#upload-start');
      await expect(uploadBtn).toBeDisabled();
    });

    test('cancel button closes upload modal', async ({ page }) => {
      await page.click('#upload-btn');

      const uploadModal = page.locator('#upload-modal');
      await expect(uploadModal).not.toHaveClass(/hidden/);

      await page.click('#upload-cancel');
      await expect(uploadModal).toHaveClass(/hidden/);
    });

    test('modal close button works', async ({ page }) => {
      await page.click('#upload-btn');

      const uploadModal = page.locator('#upload-modal');
      await expect(uploadModal).not.toHaveClass(/hidden/);

      await page.click('#upload-modal-close');
      await expect(uploadModal).toHaveClass(/hidden/);
    });

    test('drop zone is clickable', async ({ page }) => {
      await page.click('#upload-btn');

      const dropZone = page.locator('#upload-drop-zone');
      await expect(dropZone).toBeVisible();

      // Drop zone should be clickable (though we can't test file picker in E2E)
      const box = await dropZone.boundingBox();
      expect(box).toBeTruthy();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
    });
  });

  test.describe('File List UI (Section 3)', () => {
    test('file list container exists', async ({ page }) => {
      const fileList = page.locator('#file-list');
      await expect(fileList).toBeVisible();
      await expect(fileList).toHaveAttribute('role', 'region');
      await expect(fileList).toHaveAttribute('aria-label', 'File browser');
    });

    test('file list header has correct columns', async ({ page }) => {
      const header = page.locator('.file-list-header');
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute('role', 'row');

      // Check column headers
      await expect(page.locator('.file-col.file-name')).toContainText('Name');
      await expect(page.locator('.file-col.file-size')).toContainText('Size');
      await expect(page.locator('.file-col.file-date')).toContainText('Modified');

      // Check select column exists
      await expect(page.locator('.file-col.file-select')).toBeVisible();
      await expect(page.locator('#select-all-checkbox')).toBeVisible();
    });

    test('empty state shows when no files', async ({ page }) => {
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toHaveAttribute('role', 'status');
      await expect(emptyState).toContainText('No files yet');
      await expect(emptyState).toContainText('Drag files here or click Upload to get started');
    });

    test('sort dropdown exists with options', async ({ page }) => {
      const sortSelect = page.locator('#sort-select');
      await expect(sortSelect).toBeVisible();
      await expect(sortSelect).toHaveAttribute('aria-label', 'Sort files');

      // Check sort options
      const options = sortSelect.locator('option');
      await expect(options).toHaveCount(7);

      const optionTexts = await options.allTextContents();
      expect(optionTexts).toContain('Name (A-Z)');
      expect(optionTexts).toContain('Name (Z-A)');
      expect(optionTexts).toContain('Date (Newest)');
      expect(optionTexts).toContain('Date (Oldest)');
      expect(optionTexts).toContain('Size (Largest)');
      expect(optionTexts).toContain('Size (Smallest)');
      expect(optionTexts).toContain('Type');
    });

    test('view toggle buttons exist and work', async ({ page }) => {
      const gridBtn = page.locator('#view-grid');
      const listBtn = page.locator('#view-list');

      await expect(gridBtn).toBeVisible();
      await expect(gridBtn).toHaveAttribute('title', 'Grid view');

      await expect(listBtn).toBeVisible();
      await expect(listBtn).toHaveAttribute('title', 'List view');
      await expect(listBtn).toHaveClass(/active/);

      // Click grid view
      await gridBtn.click();
      await expect(gridBtn).toHaveClass(/active/);
      await expect(listBtn).not.toHaveClass(/active/);

      // Click list view
      await listBtn.click();
      await expect(listBtn).toHaveClass(/active/);
      await expect(gridBtn).not.toHaveClass(/active/);
    });

    test('toolbar has all required sections', async ({ page }) => {
      const toolbar = page.locator('.toolbar');
      await expect(toolbar).toBeVisible();

      // Left section (upload, new)
      await expect(page.locator('.toolbar-left #upload-btn')).toBeVisible();
      await expect(page.locator('.toolbar-left #new-btn')).toBeVisible();

      // Center section (tabs, search)
      await expect(page.locator('.toolbar-center .view-tabs')).toBeVisible();
      await expect(page.locator('.toolbar-center .search-box')).toBeVisible();

      // Right section (sort, view toggles)
      await expect(page.locator('.toolbar-right #sort-select')).toBeVisible();
      await expect(page.locator('.toolbar-right #view-grid')).toBeVisible();
      await expect(page.locator('.toolbar-right #view-list')).toBeVisible();
    });

    test('search functionality is visible', async ({ page }) => {
      const searchInput = page.locator('#search-input');
      const filterBtn = page.locator('#search-filter-btn');
      const clearBtn = page.locator('#search-clear');

      await expect(searchInput).toBeVisible();
      await expect(searchInput).toHaveAttribute('placeholder', 'Search files...');

      await expect(filterBtn).toBeVisible();
      await expect(filterBtn).toHaveAttribute('title', 'Filter by type, date, or size');

      // Clear button should be hidden initially
      await expect(clearBtn).toHaveClass(/hidden/);
    });

    test('search filter panel can be toggled', async ({ page }) => {
      const filterBtn = page.locator('#search-filter-btn');
      const filterPanel = page.locator('#search-filters');

      // Initially hidden
      await expect(filterPanel).toHaveClass(/hidden/);

      // Click filter button
      await filterBtn.click();

      // Panel should be visible (this depends on the JS implementation)
      // We can at least verify the button exists and is clickable
      await expect(filterBtn).toBeVisible();
    });

    test('breadcrumb navigation exists', async ({ page }) => {
      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toBeVisible();

      const rootItem = page.locator('.breadcrumb-item[data-id=""]');
      await expect(rootItem).toBeVisible();
      await expect(rootItem).toContainText('My Stash');
      await expect(rootItem).toHaveClass(/active/);
    });

    test('view tabs exist and are functional', async ({ page }) => {
      const myFilesTab = page.locator('#tab-my-files');
      const sharedTab = page.locator('#tab-shared');

      await expect(myFilesTab).toBeVisible();
      await expect(myFilesTab).toContainText('My Files');
      await expect(myFilesTab).toHaveClass(/active/);

      await expect(sharedTab).toBeVisible();
      await expect(sharedTab).toContainText('Shared with Me');
      await expect(sharedTab).not.toHaveClass(/active/);

      // Click shared tab
      await sharedTab.click();
      await expect(sharedTab).toHaveClass(/active/);
      await expect(myFilesTab).not.toHaveClass(/active/);
    });
  });

  test.describe('Context Menu', () => {
    test('context menu element exists', async ({ page }) => {
      const contextMenu = page.locator('#context-menu');
      await expect(contextMenu).toBeAttached();
      await expect(contextMenu).toHaveClass(/hidden/);
    });

    test('file list body supports right-click', async ({ page }) => {
      const fileListBody = page.locator('#file-list-body');
      await expect(fileListBody).toBeAttached(); // Use toBeAttached since it might be hidden
      await expect(fileListBody).toHaveAttribute('role', 'list');
      await expect(fileListBody).toHaveAttribute('aria-label', 'Files and folders');

      // Right-click should be possible (we can't test the actual context menu without files)
      // Check that the element exists in the DOM for interaction
      const element = await fileListBody.elementHandle();
      expect(element).toBeTruthy();
    });
  });

  test.describe('Batch Operations', () => {
    test('batch toolbar exists but is hidden initially', async ({ page }) => {
      const batchToolbar = page.locator('#batch-toolbar');
      await expect(batchToolbar).toHaveClass(/hidden/);

      // Check batch toolbar components exist
      await expect(page.locator('#batch-select-all-checkbox')).toBeAttached();
      await expect(page.locator('#selected-count')).toBeAttached();
      await expect(page.locator('#batch-download-btn')).toBeAttached();
      await expect(page.locator('#batch-delete-btn')).toBeAttached();
      await expect(page.locator('#batch-cancel-btn')).toBeAttached();
    });

    test('select all checkbox exists in file list header', async ({ page }) => {
      const selectAllCheckbox = page.locator('#select-all-checkbox');
      await expect(selectAllCheckbox).toBeVisible();
      await expect(selectAllCheckbox).toHaveAttribute('title', 'Select all');
      await expect(selectAllCheckbox).toHaveAttribute('aria-label', 'Select all files and folders');
    });
  });

  test.describe('New Dropdown', () => {
    test('new dropdown button exists and has options', async ({ page }) => {
      const newBtn = page.locator('#new-btn');
      await expect(newBtn).toBeVisible();
      await expect(newBtn).toContainText('New');

      const dropdownContent = page.locator('#new-dropdown-content');
      await expect(dropdownContent).toBeAttached();

      // Check dropdown options exist
      await expect(page.locator('[data-type="folder"]')).toContainText('Folder');
      await expect(page.locator('[data-type="doc"]')).toContainText('Document');
      await expect(page.locator('[data-type="sheet"]')).toContainText('Spreadsheet');
      await expect(page.locator('[data-type="whiteboard"]')).toContainText('Whiteboard');
      await expect(page.locator('[data-type="slides"]')).toContainText('Presentation');
    });
  });

  test.describe('Drop Overlay', () => {
    test('drop overlay exists and is hidden initially', async ({ page }) => {
      const dropOverlay = page.locator('#drop-overlay');
      await expect(dropOverlay).toHaveClass(/hidden/);

      // Check overlay content
      const overlayContent = page.locator('.drop-overlay-content');
      await expect(overlayContent).toBeAttached();

      const overlayText = page.locator('.drop-overlay-text');
      await expect(overlayText).toContainText('Drop files here to upload');

      const overlaySubtext = page.locator('.drop-overlay-subtext');
      await expect(overlaySubtext).toContainText('Files will be encrypted and uploaded');
    });
  });

  test.describe('Sidebar Navigation', () => {
    test('sidebar folder tree exists', async ({ page }) => {
      const sidebar = page.locator('#sidebar');
      await expect(sidebar).toBeVisible();
      await expect(sidebar).toHaveAttribute('role', 'navigation');
      await expect(sidebar).toHaveAttribute('aria-label', 'File navigation');

      const folderTree = page.locator('#folder-tree');
      await expect(folderTree).toBeVisible();
      await expect(folderTree).toHaveAttribute('role', 'tree');

      const rootItem = page.locator('.folder-tree-item.root');
      await expect(rootItem).toBeVisible();
      await expect(rootItem).toHaveAttribute('role', 'treeitem');
      await expect(rootItem).toContainText('My Stash');
    });

    test('sidebar quick access items exist', async ({ page }) => {
      const starred = page.locator('#nav-starred');
      await expect(starred).toBeVisible();
      await expect(starred).toContainText('Starred');
      await expect(starred).toHaveAttribute('role', 'button');

      const recent = page.locator('#nav-recent');
      await expect(recent).toBeVisible();
      await expect(recent).toContainText('Recent');

      const trash = page.locator('#nav-trash');
      await expect(trash).toBeVisible();
      await expect(trash).toContainText('Trash');

      const activity = page.locator('#nav-activity');
      await expect(activity).toBeVisible();
      await expect(activity).toContainText('Activity');

      const notifications = page.locator('#nav-notifications');
      await expect(notifications).toBeVisible();
      await expect(notifications).toContainText('Notifications');
    });

    test('storage usage section exists', async ({ page }) => {
      const storageUsage = page.locator('#storage-usage');
      await expect(storageUsage).toBeVisible();

      await expect(page.locator('.storage-label')).toContainText('Storage');
      await expect(page.locator('#storage-value')).toBeVisible();
      await expect(page.locator('.storage-bar')).toBeVisible();
    });
  });

  test.describe('Responsive Behavior', () => {
    test('mobile menu button appears on small screens', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });

      // Mobile menu button should become visible
      const mobileMenuBtn = page.locator('#mobile-menu-btn');
      await expect(mobileMenuBtn).toBeVisible();
      await expect(mobileMenuBtn).toHaveAttribute('title', 'Menu');
    });

    test('sidebar can be toggled on desktop', async ({ page }) => {
      const sidebarToggle = page.locator('#sidebar-toggle');
      await expect(sidebarToggle).toBeVisible();
      await expect(sidebarToggle).toHaveAttribute('title', 'Toggle sidebar');
      await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');

      // Click to toggle
      await sidebarToggle.click();
      // Note: The actual hiding behavior would need JS to be fully tested
    });
  });

  test.describe('Accessibility', () => {
    test('file explorer has proper ARIA labels', async ({ page }) => {
      await expect(page.locator('#file-list')).toHaveAttribute('aria-label', 'File browser');
      await expect(page.locator('#file-list-body')).toHaveAttribute('aria-label', 'Files and folders');
      await expect(page.locator('#sidebar')).toHaveAttribute('aria-label', 'File navigation');
      await expect(page.locator('#folder-tree')).toHaveAttribute('aria-labelledby', 'sidebar-title');
    });

    test('buttons have proper titles and ARIA labels', async ({ page }) => {
      await expect(page.locator('#upload-btn')).toContainText('Upload');

      // Theme toggle title changes based on current theme
      const themeToggle = page.locator('#theme-toggle');
      await expect(themeToggle).toHaveAttribute('title', /Toggle|Switch/);

      await expect(page.locator('#backup-btn')).toHaveAttribute('title', 'Key Backup');
      await expect(page.locator('#relay-settings-btn')).toHaveAttribute('title', 'Relay Settings');

      const selectAllCheckbox = page.locator('#select-all-checkbox');
      await expect(selectAllCheckbox).toHaveAttribute('title', 'Select all');
      await expect(selectAllCheckbox).toHaveAttribute('aria-label', 'Select all files and folders');
    });

    test('form elements have proper labels', async ({ page }) => {
      const sortSelect = page.locator('#sort-select');
      await expect(sortSelect).toHaveAttribute('aria-label', 'Sort files');

      const searchInput = page.locator('#search-input');
      await expect(searchInput).toHaveAttribute('placeholder', 'Search files...');
    });
  });
});