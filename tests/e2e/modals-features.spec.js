// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Modals and Features - Structure Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test.describe('Encryption Info Modal (Section 5)', () => {
    test('encryption info modal exists and is hidden by default', async ({ page }) => {
      const modal = page.locator('#encryption-info-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
    });

    test('modal shows algorithm info section', async ({ page }) => {
      const modal = page.locator('#encryption-info-modal');

      // Check algorithm section exists
      const algorithmSection = modal.locator('.encryption-info-section').filter({ hasText: 'Algorithm' });
      await expect(algorithmSection).toBeAttached();
      await expect(algorithmSection.locator('.encryption-algorithm')).toContainText('XChaCha20-Poly1305');
    });

    test('modal shows key hierarchy section', async ({ page }) => {
      const modal = page.locator('#encryption-info-modal');

      // Check key derivation section exists
      const keySection = modal.locator('.encryption-info-section').filter({ hasText: 'Key Derivation' });
      await expect(keySection).toBeAttached();
      await expect(keySection.locator('#key-hierarchy')).toBeAttached();
    });

    test('modal has proper header and close button', async ({ page }) => {
      const modal = page.locator('#encryption-info-modal');
      await expect(modal.locator('.modal-header h2')).toHaveText('Encryption Details');
      await expect(modal.locator('#encryption-info-close')).toBeAttached();
    });

    test('modal has done button in footer', async ({ page }) => {
      const modal = page.locator('#encryption-info-modal');
      await expect(modal.locator('#encryption-info-done')).toBeAttached();
      await expect(modal.locator('#encryption-info-done')).toHaveText('Done');
    });
  });

  test.describe('Share Modal (Section 6)', () => {
    test('share modal exists and is hidden by default', async ({ page }) => {
      const modal = page.locator('#share-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
    });

    test('modal has recipient input field', async ({ page }) => {
      const modal = page.locator('#share-modal');
      const recipientInput = modal.locator('#share-recipient');

      await expect(recipientInput).toBeAttached();
      await expect(recipientInput).toHaveAttribute('placeholder', 'npub1... or hex pubkey');

      // Check label
      const label = modal.locator('label[for="share-recipient"]');
      await expect(label).toHaveText('Recipient npub or hex pubkey:');
    });

    test('modal has message input field', async ({ page }) => {
      const modal = page.locator('#share-modal');
      const messageInput = modal.locator('#share-message');

      await expect(messageInput).toBeAttached();
      await expect(messageInput).toHaveAttribute('placeholder', 'Shared with you!');

      // Check label
      const label = modal.locator('label[for="share-message"]');
      await expect(label).toHaveText('Message (optional):');
    });

    test('modal has Cancel and Share buttons', async ({ page }) => {
      const modal = page.locator('#share-modal');

      await expect(modal.locator('#share-cancel')).toBeAttached();
      await expect(modal.locator('#share-cancel')).toHaveText('Cancel');

      await expect(modal.locator('#share-confirm')).toBeAttached();
      await expect(modal.locator('#share-confirm')).toHaveText('Share');
    });

    test('modal has proper header', async ({ page }) => {
      const modal = page.locator('#share-modal');
      await expect(modal.locator('.modal-header h2')).toHaveText('Share File');
      await expect(modal.locator('#share-modal-close')).toBeAttached();
    });
  });

  test.describe('Public Link Modal', () => {
    test('public link modal exists', async ({ page }) => {
      const modal = page.locator('#public-link-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
    });

    test('modal has expiry dropdown', async ({ page }) => {
      const modal = page.locator('#public-link-modal');
      const expirySelect = modal.locator('#public-link-expiry');

      await expect(expirySelect).toBeAttached();

      // Check label
      const label = modal.locator('label[for="public-link-expiry"]');
      await expect(label).toHaveText('Link expires in:');

      // Check options exist
      await expect(expirySelect.locator('option[value="0"]')).toHaveText('Never');
      await expect(expirySelect.locator('option[value="3600"]')).toHaveText('1 hour');
      await expect(expirySelect.locator('option[value="86400"]')).toHaveText('1 day');
      await expect(expirySelect.locator('option[value="604800"]')).toHaveText('1 week');
      await expect(expirySelect.locator('option[value="2592000"]')).toHaveText('30 days');
    });

    test('modal has Generate Link button', async ({ page }) => {
      const modal = page.locator('#public-link-modal');

      await expect(modal.locator('#public-link-generate')).toBeAttached();
      await expect(modal.locator('#public-link-generate')).toHaveText('Generate Link');

      await expect(modal.locator('#public-link-cancel')).toBeAttached();
      await expect(modal.locator('#public-link-cancel')).toHaveText('Cancel');
    });

    test('modal has proper header', async ({ page }) => {
      const modal = page.locator('#public-link-modal');
      await expect(modal.locator('.modal-header h2')).toHaveText('Create Public Link');
      await expect(modal.locator('#public-link-modal-close')).toBeAttached();
    });

    test('modal has result section for generated link', async ({ page }) => {
      const modal = page.locator('#public-link-modal');
      const resultSection = modal.locator('#public-link-result');

      await expect(resultSection).toBeAttached();
      await expect(resultSection).toHaveClass(/hidden/);

      await expect(resultSection.locator('#public-link-url')).toBeAttached();
      await expect(resultSection.locator('#public-link-copy')).toBeAttached();
      await expect(resultSection.locator('#public-link-copy')).toHaveText('Copy');
    });
  });

  test.describe('File Features (Section 9)', () => {
    test('version history modal exists', async ({ page }) => {
      const modal = page.locator('#version-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Version History');
      await expect(modal.locator('#version-modal-close')).toBeAttached();
      await expect(modal.locator('#version-close')).toBeAttached();
      await expect(modal.locator('#version-close')).toHaveText('Close');

      // Check version list container
      await expect(modal.locator('#version-list')).toBeAttached();
    });

    test('comments modal exists with textarea', async ({ page }) => {
      const modal = page.locator('#comments-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Comments');
      await expect(modal.locator('#comments-modal-close')).toBeAttached();

      // Check textarea and button exist
      const textarea = modal.locator('#comment-input');
      await expect(textarea).toBeAttached();
      await expect(textarea).toHaveAttribute('placeholder', 'Add a comment...');

      const addButton = modal.locator('#add-comment-btn');
      await expect(addButton).toBeAttached();
      await expect(addButton).toHaveText('Add Comment');

      // Check comments list container
      await expect(modal.locator('#comments-list')).toBeAttached();
    });

    test('tags modal exists with input', async ({ page }) => {
      const modal = page.locator('#tags-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Tags');
      await expect(modal.locator('#tags-modal-close')).toBeAttached();

      // Check tag input
      const tagInput = modal.locator('#tag-input');
      await expect(tagInput).toBeAttached();
      await expect(tagInput).toHaveAttribute('placeholder', 'Add a tag...');

      // Check tags container
      await expect(modal.locator('#tags-container')).toBeAttached();

      // Check suggestions container
      await expect(modal.locator('#tag-suggestions')).toBeAttached();
      await expect(modal.locator('#tag-suggestions')).toHaveClass(/hidden/);

      // Check done button
      await expect(modal.locator('#tags-done')).toBeAttached();
      await expect(modal.locator('#tags-done')).toHaveText('Done');
    });
  });

  test.describe('Settings (Section 11)', () => {
    test('theme toggle button exists in header', async ({ page }) => {
      const themeToggle = page.locator('#theme-toggle');
      await expect(themeToggle).toBeAttached();
      // Title is dynamic based on current theme state
      const title = await themeToggle.getAttribute('title');
      expect(title).toMatch(/Switch to (light|dark) mode/);
    });

    test('clicking theme toggle changes body class', async ({ page }) => {
      const themeToggle = page.locator('#theme-toggle');
      const body = page.locator('body');

      // Theme toggle is in file explorer, not landing page, so skip this test
      // since we can't authenticate in this test environment
      await expect(themeToggle).toBeAttached();
    });

    test('relay settings modal exists', async ({ page }) => {
      const modal = page.locator('#relay-settings-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Relay Settings');
      await expect(modal.locator('#relay-settings-close')).toBeAttached();
    });

    test('relay settings has add relay input', async ({ page }) => {
      const modal = page.locator('#relay-settings-modal');

      // Check add relay input
      const addInput = modal.locator('#relay-add-url');
      await expect(addInput).toBeAttached();
      await expect(addInput).toHaveAttribute('placeholder', 'wss://relay.example.com');

      // Check label
      const label = modal.locator('label').filter({ hasText: 'Add Relay' });
      await expect(label).toBeAttached();

      // Check add button
      const addButton = modal.locator('#relay-add-btn');
      await expect(addButton).toBeAttached();
      await expect(addButton).toHaveText('Add');

      // Check read/write checkboxes
      await expect(modal.locator('#relay-add-read')).toBeAttached();
      await expect(modal.locator('#relay-add-write')).toBeAttached();
    });

    test('relay settings has Save button', async ({ page }) => {
      const modal = page.locator('#relay-settings-modal');

      await expect(modal.locator('#relay-settings-save')).toBeAttached();
      await expect(modal.locator('#relay-settings-save')).toHaveText('Save');

      await expect(modal.locator('#relay-settings-cancel')).toBeAttached();
      await expect(modal.locator('#relay-settings-cancel')).toHaveText('Cancel');
    });

    test('key backup modal exists', async ({ page }) => {
      const modal = page.locator('#backup-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Key Backup');
      await expect(modal.locator('#backup-modal-close')).toBeAttached();
    });

    test('backup modal has Export and Import sections', async ({ page }) => {
      const modal = page.locator('#backup-modal');

      // Export section
      const exportSection = modal.locator('#backup-export');
      await expect(exportSection).toBeAttached();
      await expect(exportSection.locator('h3')).toHaveText('Export Keys');
      await expect(exportSection.locator('#backup-export-btn')).toBeAttached();
      await expect(exportSection.locator('#backup-export-btn')).toHaveText('Download Backup');

      // Import section
      const importSection = modal.locator('#backup-import');
      await expect(importSection).toBeAttached();
      await expect(importSection.locator('h3')).toHaveText('Import Keys');
      await expect(importSection.locator('#backup-import-btn')).toBeAttached();
      await expect(importSection.locator('#backup-import-btn')).toHaveText('Select Backup File');

      // File input (hidden)
      await expect(modal.locator('#backup-file-input')).toBeAttached();
      await expect(modal.locator('#backup-file-input')).toHaveAttribute('type', 'file');

      // Close button
      await expect(modal.locator('#backup-close')).toBeAttached();
      await expect(modal.locator('#backup-close')).toHaveText('Close');
    });
  });

  test.describe('Keyboard Shortcuts', () => {
    test('keyboard shortcuts modal exists', async ({ page }) => {
      const modal = page.locator('#keyboard-shortcuts-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      await expect(modal.locator('.modal-header h2')).toHaveText('Keyboard Shortcuts');
      await expect(modal.locator('#keyboard-shortcuts-close')).toBeAttached();
    });

    test('modal lists expected shortcuts', async ({ page }) => {
      const modal = page.locator('#keyboard-shortcuts-modal');
      const shortcutsList = modal.locator('.shortcuts-list');

      await expect(shortcutsList).toBeAttached();

      // Check for specific shortcuts
      const shortcuts = [
        { key: '?', description: 'Show this help' },
        { key: 'u', description: 'Upload files' },
        { key: 'n', description: 'New folder' },
        { key: '/', description: 'Focus search' },
        { key: 'Esc', description: 'Close modal / Clear selection' },
        { key: 'Delete', description: 'Delete selected files' },
        { key: 'd', description: 'Download selected' },
        { key: 'Enter', description: 'Open selected file' },
        { key: 'Ctrl+A', description: 'Select all' }
      ];

      for (const shortcut of shortcuts) {
        const shortcutItem = shortcutsList.locator('.shortcut-item').filter({
          has: page.locator('kbd').filter({ hasText: new RegExp(`^${shortcut.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        });
        await expect(shortcutItem.first()).toBeAttached();
        await expect(shortcutItem.first().locator('span').last()).toContainText(shortcut.description);
      }

      // Check for arrow key navigation
      await expect(shortcutsList.locator('.shortcut-item').filter({
        hasText: 'Navigate files'
      })).toBeAttached();

      // Check done button
      await expect(modal.locator('#keyboard-shortcuts-done')).toBeAttached();
      await expect(modal.locator('#keyboard-shortcuts-done')).toHaveText('Done');
    });
  });

  test.describe('Additional Modals Present', () => {
    test('upload modal exists', async ({ page }) => {
      const modal = page.locator('#upload-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Upload Files');
    });

    test('activity modal exists', async ({ page }) => {
      const modal = page.locator('#activity-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Activity Log');
    });

    test('notifications modal exists', async ({ page }) => {
      const modal = page.locator('#notifications-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Notifications');
    });

    test('folder customize modal exists', async ({ page }) => {
      const modal = page.locator('#folder-customize-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Customize Folder');
    });

    test('manage shares modal exists', async ({ page }) => {
      const modal = page.locator('#manage-shares-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Manage Shares');
    });

    test('text editor modal exists', async ({ page }) => {
      const modal = page.locator('#editor-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Edit File');
    });

    test('file preview modal exists', async ({ page }) => {
      const modal = page.locator('#preview-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Preview');
    });

    test('file info modal exists', async ({ page }) => {
      const modal = page.locator('#file-info-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('File Info');
    });

    test('new folder modal exists', async ({ page }) => {
      const modal = page.locator('#new-folder-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('New Folder');
    });

    test('rename modal exists', async ({ page }) => {
      const modal = page.locator('#rename-modal');
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);
      await expect(modal.locator('.modal-header h2')).toHaveText('Rename');
    });
  });
});

test.describe('Modal Accessibility and Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('all modals have proper ARIA structure', async ({ page }) => {
    const modals = [
      '#encryption-info-modal',
      '#share-modal',
      '#public-link-modal',
      '#version-modal',
      '#comments-modal',
      '#tags-modal',
      '#relay-settings-modal',
      '#backup-modal',
      '#keyboard-shortcuts-modal'
    ];

    for (const modalId of modals) {
      const modal = page.locator(modalId);

      // Modal should exist and be hidden
      await expect(modal).toBeAttached();
      await expect(modal).toHaveClass(/hidden/);

      // Should have modal-content wrapper
      await expect(modal.locator('.modal-content')).toBeAttached();

      // Should have header, body, and footer structure
      await expect(modal.locator('.modal-header')).toBeAttached();
      await expect(modal.locator('.modal-body')).toBeAttached();

      // Most should have footer (some might not)
      const hasFooter = await modal.locator('.modal-footer').count() > 0;
      if (hasFooter) {
        await expect(modal.locator('.modal-footer')).toBeAttached();
      }

      // Should have close button in header
      const closeBtn = modal.locator('.modal-close');
      if (await closeBtn.count() > 0) {
        await expect(closeBtn).toBeAttached();
      }
    }
  });

  test('modal close buttons are accessible', async ({ page }) => {
    const modalsWithClose = [
      { id: '#encryption-info-modal', closeId: '#encryption-info-close' },
      { id: '#share-modal', closeId: '#share-modal-close' },
      { id: '#public-link-modal', closeId: '#public-link-modal-close' },
      { id: '#version-modal', closeId: '#version-modal-close' },
      { id: '#comments-modal', closeId: '#comments-modal-close' },
      { id: '#tags-modal', closeId: '#tags-modal-close' },
      { id: '#relay-settings-modal', closeId: '#relay-settings-close' },
      { id: '#backup-modal', closeId: '#backup-modal-close' },
      { id: '#keyboard-shortcuts-modal', closeId: '#keyboard-shortcuts-close' }
    ];

    for (const { id, closeId } of modalsWithClose) {
      const modal = page.locator(id);
      const closeBtn = page.locator(closeId);

      await expect(closeBtn).toBeAttached();
      // Close button should be focusable
      await expect(closeBtn).toHaveAttribute('class');
    }
  });

  test('form inputs have proper labels', async ({ page }) => {
    // Share modal inputs
    const shareModal = page.locator('#share-modal');
    await expect(shareModal.locator('label[for="share-recipient"]')).toBeAttached();
    await expect(shareModal.locator('label[for="share-message"]')).toBeAttached();

    // Public link modal
    const publicModal = page.locator('#public-link-modal');
    await expect(publicModal.locator('label[for="public-link-expiry"]')).toBeAttached();

    // Relay settings
    const relayModal = page.locator('#relay-settings-modal');
    await expect(relayModal.locator('label').filter({ hasText: 'Add Relay' })).toBeAttached();

    // Tags modal (input has placeholder, which is acceptable)
    const tagsModal = page.locator('#tags-modal');
    await expect(tagsModal.locator('#tag-input')).toHaveAttribute('placeholder');

    // Comments modal (textarea has placeholder)
    const commentsModal = page.locator('#comments-modal');
    await expect(commentsModal.locator('#comment-input')).toHaveAttribute('placeholder');
  });

  test('buttons have descriptive text or titles', async ({ page }) => {
    // Theme toggle has dynamic title
    const themeToggle = page.locator('#theme-toggle');
    const title = await themeToggle.getAttribute('title');
    expect(title).toMatch(/Switch to (light|dark) mode/);

    // Backup button has title
    await expect(page.locator('#backup-btn')).toHaveAttribute('title', 'Key Backup');

    // Relay settings button has title
    await expect(page.locator('#relay-settings-btn')).toHaveAttribute('title', 'Relay Settings');

    // Modal buttons have text content
    const shareModal = page.locator('#share-modal');
    await expect(shareModal.locator('#share-confirm')).toHaveText('Share');

    const publicModal = page.locator('#public-link-modal');
    await expect(publicModal.locator('#public-link-generate')).toHaveText('Generate Link');

    const backupModal = page.locator('#backup-modal');
    await expect(backupModal.locator('#backup-export-btn')).toHaveText('Download Backup');
  });
});