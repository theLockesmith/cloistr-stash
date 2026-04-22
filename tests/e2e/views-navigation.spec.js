// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Views & Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for basic DOM elements to be loaded
    await page.waitForLoadState('domcontentloaded');

    // Force show the file explorer for UI testing purposes
    // We don't need actual auth for testing UI element presence and basic interactions
    await page.evaluate(() => {
      // Show the file explorer directly
      document.getElementById('landing-page').classList.add('hidden');
      document.getElementById('access-denied').classList.add('hidden');
      document.getElementById('file-explorer').classList.remove('hidden');

      // Set a basic mock user pubkey for display
      const userPubkey = document.getElementById('user-pubkey');
      if (userPubkey) {
        userPubkey.textContent = 'npub1test123...';
      }
    });

    // Wait for the file explorer to be visible
    await expect(page.locator('#file-explorer')).toBeVisible();
  });

  test.describe('Search & Filtering (Section 7)', () => {
    test('search input should exist and be focusable in toolbar', async ({ page }) => {
      const searchInput = page.locator('#search-input');

      // Search input should exist and be visible
      await expect(searchInput).toBeVisible();
      await expect(searchInput).toHaveAttribute('placeholder', 'Search files...');

      // Should be focusable
      await searchInput.focus();
      await expect(searchInput).toBeFocused();

      // Should be in the toolbar center section
      const searchBox = page.locator('.search-box');
      await expect(searchBox).toBeVisible();
      await expect(searchBox).toContainText('⧩'); // Filter button should be visible
    });

    test('filter button should exist with correct icon and tooltip', async ({ page }) => {
      const filterButton = page.locator('#search-filter-btn');

      // Filter button should exist with ⧩ symbol
      await expect(filterButton).toBeVisible();
      await expect(filterButton).toHaveText('⧩');
      await expect(filterButton).toHaveAttribute('title', 'Filter by type, date, or size');
    });

    test('clicking filter button should show filter panel', async ({ page }) => {
      const filterButton = page.locator('#search-filter-btn');
      const filterPanel = page.locator('#search-filters');

      // Filter panel should be hidden initially
      await expect(filterPanel).toHaveClass(/hidden/);

      // Click filter button
      await filterButton.click();

      // Filter panel should now be visible
      await expect(filterPanel).not.toHaveClass(/hidden/);
      await expect(filterPanel).toBeVisible();
    });

    test('filter panel should have all required dropdowns and buttons', async ({ page }) => {
      const filterButton = page.locator('#search-filter-btn');
      await filterButton.click();

      const filterPanel = page.locator('#search-filters');
      await expect(filterPanel).toBeVisible();

      // Type dropdown
      const typeFilter = page.locator('#filter-type');
      await expect(typeFilter).toBeVisible();
      await expect(page.locator('label').filter({ hasText: 'File Type' })).toBeVisible();

      // Check Type options
      const typeOptions = await typeFilter.locator('option').allTextContents();
      expect(typeOptions).toContain('All Types');
      expect(typeOptions).toContain('Images');
      expect(typeOptions).toContain('Videos');
      expect(typeOptions).toContain('Audio');
      expect(typeOptions).toContain('Documents');
      expect(typeOptions).toContain('Code');
      expect(typeOptions).toContain('Archives');

      // Date dropdown
      const dateFilter = page.locator('#filter-date');
      await expect(dateFilter).toBeVisible();
      await expect(page.locator('label').filter({ hasText: 'Date' })).toBeVisible();

      // Check Date options
      const dateOptions = await dateFilter.locator('option').allTextContents();
      expect(dateOptions).toContain('Any Time');
      expect(dateOptions).toContain('Today');
      expect(dateOptions).toContain('This Week');
      expect(dateOptions).toContain('This Month');
      expect(dateOptions).toContain('This Year');

      // Size dropdown
      const sizeFilter = page.locator('#filter-size');
      await expect(sizeFilter).toBeVisible();
      await expect(page.locator('label').filter({ hasText: 'Size' })).toBeVisible();

      // Check Size options
      const sizeOptions = await sizeFilter.locator('option').allTextContents();
      expect(sizeOptions).toContain('Any Size');
      expect(sizeOptions).toContain('Tiny (<100KB)');
      expect(sizeOptions).toContain('Small (<1MB)');
      expect(sizeOptions).toContain('Medium (1-10MB)');
      expect(sizeOptions).toContain('Large (10-100MB)');
      expect(sizeOptions).toContain('Huge (>100MB)');

      // Filter action buttons
      const resetButton = page.locator('#filter-reset');
      const applyButton = page.locator('#filter-apply');

      await expect(resetButton).toBeVisible();
      await expect(resetButton).toHaveText('Reset');
      await expect(applyButton).toBeVisible();
      await expect(applyButton).toHaveText('Apply');
    });

    test('clear search button should appear when text is entered', async ({ page }) => {
      const searchInput = page.locator('#search-input');
      const clearButton = page.locator('#search-clear');

      // Clear button should be hidden initially
      await expect(clearButton).toHaveClass(/hidden/);

      // Type in search input
      await searchInput.fill('test');

      // Clear button should now be visible
      await expect(clearButton).not.toHaveClass(/hidden/);
      await expect(clearButton).toBeVisible();
      await expect(clearButton).toHaveText('✕');

      // Clicking clear button should clear the input and hide the button
      await clearButton.click();
      await expect(searchInput).toHaveValue('');
      await expect(clearButton).toHaveClass(/hidden/);
    });
  });

  test.describe('Views (Section 8)', () => {
    test('view tabs should exist with correct states', async ({ page }) => {
      const myFilesTab = page.locator('#tab-my-files');
      const sharedTab = page.locator('#tab-shared');

      // Both tabs should exist and be attached (may be hidden on mobile initially)
      await expect(myFilesTab).toBeAttached();
      await expect(myFilesTab).toHaveText('My Files');
      await expect(sharedTab).toBeAttached();
      await expect(sharedTab).toHaveText('Shared with Me');

      // My Files should be active by default
      await expect(myFilesTab).toHaveClass(/active/);
      await expect(sharedTab).not.toHaveClass(/active/);

      // Clicking Shared tab should make it active
      await sharedTab.click();
      await expect(sharedTab).toHaveClass(/active/);
      await expect(myFilesTab).not.toHaveClass(/active/);

      // Switch back to My Files
      await myFilesTab.click();
      await expect(myFilesTab).toHaveClass(/active/);
      await expect(sharedTab).not.toHaveClass(/active/);
    });

    test('view toggle buttons should exist and function', async ({ page }) => {
      const gridViewBtn = page.locator('#view-grid');
      const listViewBtn = page.locator('#view-list');
      const fileList = page.locator('#file-list');

      // Both view buttons should exist
      await expect(gridViewBtn).toBeVisible();
      await expect(gridViewBtn).toHaveAttribute('title', 'Grid view');
      await expect(gridViewBtn).toHaveText('▦');

      await expect(listViewBtn).toBeVisible();
      await expect(listViewBtn).toHaveAttribute('title', 'List view');
      await expect(listViewBtn).toHaveText('≡');

      // List view should be active by default (based on HTML)
      await expect(listViewBtn).toHaveClass(/active/);

      // Click grid view button
      await gridViewBtn.click();

      // Grid view button should become active
      await expect(gridViewBtn).toHaveClass(/active/);
      await expect(listViewBtn).not.toHaveClass(/active/);

      // File list should have grid class (assuming this changes the layout)
      // Note: We can't easily test the visual change, but we can test the button states

      // Switch back to list view
      await listViewBtn.click();
      await expect(listViewBtn).toHaveClass(/active/);
      await expect(gridViewBtn).not.toHaveClass(/active/);
    });

    test('sort dropdown should exist with all required options', async ({ page }) => {
      const sortSelect = page.locator('#sort-select');

      await expect(sortSelect).toBeVisible();
      await expect(sortSelect).toHaveAttribute('aria-label', 'Sort files');

      // Check all sort options
      const sortOptions = await sortSelect.locator('option').allTextContents();
      expect(sortOptions).toContain('Name (A-Z)');
      expect(sortOptions).toContain('Name (Z-A)');
      expect(sortOptions).toContain('Date (Newest)');
      expect(sortOptions).toContain('Date (Oldest)');
      expect(sortOptions).toContain('Size (Largest)');
      expect(sortOptions).toContain('Size (Smallest)');
      expect(sortOptions).toContain('Type');

      // Date (Newest) should be selected by default
      await expect(sortSelect).toHaveValue('date-desc');

      // Test changing sort option
      await sortSelect.selectOption('name-asc');
      await expect(sortSelect).toHaveValue('name-asc');
    });
  });

  test.describe('Sidebar Navigation', () => {
    test('all sidebar navigation items should exist with correct icons and labels', async ({ page }) => {
      // Starred nav item
      const starredNav = page.locator('#nav-starred');
      await expect(starredNav).toBeVisible();
      await expect(starredNav).toHaveAttribute('title', 'Starred files');
      await expect(starredNav).toHaveAttribute('aria-label', 'Starred files');
      await expect(starredNav.locator('.sidebar-nav-name')).toHaveText('Starred');
      await expect(starredNav.locator('.sidebar-nav-icon')).toHaveText('★');

      // Recent nav item
      const recentNav = page.locator('#nav-recent');
      await expect(recentNav).toBeVisible();
      await expect(recentNav).toHaveAttribute('title', 'Recently accessed');
      await expect(recentNav).toHaveAttribute('aria-label', 'Recent files');
      await expect(recentNav.locator('.sidebar-nav-name')).toHaveText('Recent');
      await expect(recentNav.locator('.sidebar-nav-icon')).toHaveText('🕑');

      // Trash nav item
      const trashNav = page.locator('#nav-trash');
      await expect(trashNav).toBeVisible();
      await expect(trashNav).toHaveAttribute('title', 'Deleted files');
      await expect(trashNav).toHaveAttribute('aria-label', 'Trash');
      await expect(trashNav.locator('.sidebar-nav-name')).toHaveText('Trash');
      await expect(trashNav.locator('.sidebar-nav-icon')).toHaveText('🗑');

      // Activity nav item
      const activityNav = page.locator('#nav-activity');
      await expect(activityNav).toBeVisible();
      await expect(activityNav).toHaveAttribute('title', 'Activity log');
      await expect(activityNav).toHaveAttribute('aria-label', 'Activity');
      await expect(activityNav.locator('.sidebar-nav-name')).toHaveText('Activity');
      await expect(activityNav.locator('.sidebar-nav-icon')).toHaveText('📋');

      // Notifications nav item
      const notificationsNav = page.locator('#nav-notifications');
      await expect(notificationsNav).toBeVisible();
      await expect(notificationsNav).toHaveAttribute('title', 'Share notifications');
      await expect(notificationsNav).toHaveAttribute('aria-label', 'Notifications');
      await expect(notificationsNav.locator('.sidebar-nav-name')).toHaveText('Notifications');
      await expect(notificationsNav.locator('.sidebar-nav-icon')).toHaveText('🔔');

      // Relay Settings nav item
      const relaySettingsNav = page.locator('#nav-relay-settings');
      await expect(relaySettingsNav).toBeVisible();
      await expect(relaySettingsNav).toHaveAttribute('title', 'Relay settings');
      await expect(relaySettingsNav).toHaveAttribute('aria-label', 'Relay Settings');
      await expect(relaySettingsNav.locator('.sidebar-nav-name')).toHaveText('Relay Settings');
      await expect(relaySettingsNav.locator('.sidebar-nav-icon')).toHaveText('⚡');
    });

    test('sidebar navigation items should be keyboard accessible', async ({ page }) => {
      // Test that nav items have proper tabindex and role attributes
      const navItems = [
        '#nav-starred',
        '#nav-recent',
        '#nav-trash',
        '#nav-activity',
        '#nav-notifications',
        '#nav-relay-settings'
      ];

      for (const selector of navItems) {
        const navItem = page.locator(selector);
        await expect(navItem).toHaveAttribute('role', 'button');
        await expect(navItem).toHaveAttribute('tabindex', '0');

        // Test focus
        await navItem.focus();
        await expect(navItem).toBeFocused();
      }
    });

    test('notification badge should exist in DOM', async ({ page }) => {
      const notificationBadge = page.locator('#notification-count');
      await expect(notificationBadge).toBeAttached();
      await expect(notificationBadge).toHaveClass(/notification-badge/);
    });

    test('trash count badge should exist in DOM', async ({ page }) => {
      const trashBadge = page.locator('#trash-count');
      await expect(trashBadge).toBeAttached();
      await expect(trashBadge).toHaveAttribute('aria-live', 'polite');
    });

    test('sidebar nav items should be clickable', async ({ page }) => {
      // Test that navigation items are clickable (they should exist and respond to clicks)
      // We're testing UI presence, not the full application logic

      const navItems = [
        '#nav-starred',
        '#nav-recent',
        '#nav-trash',
        '#nav-activity',
        '#nav-notifications',
        '#nav-relay-settings'
      ];

      for (const selector of navItems) {
        const navItem = page.locator(selector);
        await expect(navItem).toBeVisible();

        // Test that the item is clickable (won't throw error)
        // Use scrollIntoView for mobile compatibility
        await navItem.scrollIntoViewIfNeeded();
        await navItem.click({ trial: true });
      }

      // Test that the root folder item is also clickable
      const rootFolder = page.locator('.folder-tree-item.root');
      await expect(rootFolder).toBeVisible();
      await rootFolder.click({ trial: true });
    });
  });

  test.describe('Breadcrumb Navigation', () => {
    test('breadcrumb should show current location', async ({ page }) => {
      const breadcrumb = page.locator('#breadcrumb');
      const rootBreadcrumb = breadcrumb.locator('.breadcrumb-item');

      // Should show root location by default
      await expect(rootBreadcrumb).toBeVisible();
      await expect(rootBreadcrumb).toHaveText('My Stash');
      await expect(rootBreadcrumb).toHaveClass(/active/);
      await expect(rootBreadcrumb).toHaveAttribute('data-id', '');
    });
  });

  test.describe('Folder Tree Navigation', () => {
    test('folder tree should have proper structure and accessibility', async ({ page }) => {
      const folderTree = page.locator('#folder-tree');
      const rootItem = page.locator('.folder-tree-item.root');

      // Folder tree should have proper ARIA attributes
      await expect(folderTree).toHaveAttribute('role', 'tree');
      await expect(folderTree).toHaveAttribute('aria-labelledby', 'sidebar-title');

      // Root item should have proper attributes
      await expect(rootItem).toHaveAttribute('role', 'treeitem');
      await expect(rootItem).toHaveAttribute('tabindex', '0');
      await expect(rootItem).toHaveAttribute('aria-selected', 'true');
      await expect(rootItem.locator('.folder-tree-name')).toHaveText('My Stash');
      await expect(rootItem.locator('.folder-tree-icon')).toHaveText('📁');
    });

    test('sidebar should have toggle functionality', async ({ page }) => {
      const sidebar = page.locator('#sidebar');
      const sidebarToggle = page.locator('#sidebar-toggle');

      // Sidebar should be visible initially
      await expect(sidebar).toBeVisible();
      await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');

      // Toggle button should exist
      await expect(sidebarToggle).toBeVisible();
      await expect(sidebarToggle).toHaveAttribute('title', 'Toggle sidebar');
      await expect(sidebarToggle).toHaveAttribute('aria-label', 'Toggle sidebar');
    });
  });

  test.describe('Storage Usage Display', () => {
    test('storage usage section should exist with proper elements', async ({ page }) => {
      const storageUsage = page.locator('#storage-usage');

      await expect(storageUsage).toBeVisible();
      await expect(storageUsage.locator('.storage-label')).toHaveText('Storage');
      await expect(storageUsage.locator('#storage-value')).toBeVisible();

      // Storage bar fill and details exist in DOM (may be styled as hidden initially)
      await expect(storageUsage.locator('#storage-bar-fill')).toBeAttached();
      await expect(storageUsage.locator('#storage-details')).toBeAttached();
    });
  });

  test.describe('Mobile Responsiveness', () => {
    test('mobile menu button should exist but be hidden on desktop', async ({ page }) => {
      const mobileMenuBtn = page.locator('#mobile-menu-btn');

      // Should exist but be hidden on desktop (display: none)
      await expect(mobileMenuBtn).toHaveAttribute('style', 'display: none;');
      await expect(mobileMenuBtn).toHaveAttribute('title', 'Menu');
    });

    test('sidebar overlay should exist for mobile', async ({ page }) => {
      const sidebarOverlay = page.locator('#sidebar-overlay');
      await expect(sidebarOverlay).toBeAttached();
      await expect(sidebarOverlay).toHaveClass(/sidebar-overlay/);
    });
  });
});

test.describe('Accessibility Features', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      // Show the file explorer directly for UI testing
      document.getElementById('landing-page').classList.add('hidden');
      document.getElementById('access-denied').classList.add('hidden');
      document.getElementById('file-explorer').classList.remove('hidden');

      // Set a basic mock user pubkey for display
      const userPubkey = document.getElementById('user-pubkey');
      if (userPubkey) {
        userPubkey.textContent = 'npub1test123...';
      }
    });

    await expect(page.locator('#file-explorer')).toBeVisible();
  });

  test('search and filter elements should have proper ARIA labels', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    const sortSelect = page.locator('#sort-select');
    const fileListRegion = page.locator('#file-list');

    // Search input should have autocomplete disabled for security
    await expect(searchInput).toHaveAttribute('autocomplete', 'off');

    // Sort dropdown should have ARIA label
    await expect(sortSelect).toHaveAttribute('aria-label', 'Sort files');

    // File list should have proper region role and label
    await expect(fileListRegion).toHaveAttribute('role', 'region');
    await expect(fileListRegion).toHaveAttribute('aria-label', 'File browser');
  });

  test('keyboard navigation should work for main interface elements', async ({ page }) => {
    // Test tabbing through main interface elements
    await page.keyboard.press('Tab');

    // Should be able to focus on interactive elements
    // This is a basic test - more detailed keyboard nav testing would require specific scenarios
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
  });
});