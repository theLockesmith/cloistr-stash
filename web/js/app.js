// Main application

const App = {
    files: [],
    folders: [],
    sharedFiles: [],      // Files shared with current user
    trashedFiles: [],     // Files in trash (soft deleted)
    starredFiles: new Set(), // SHA256 hashes of starred files
    recentFiles: [],      // Recently accessed files
    currentFolderId: '',  // Empty string = root folder
    folderPath: [],       // Array of {id, name} for breadcrumb navigation
    authState: 'unauthenticated', // 'unauthenticated' | 'authenticated' | 'denied'
    currentView: 'my-files', // 'my-files' | 'shared' | 'starred' | 'recent' | 'trash'
    searchQuery: '',      // Current search query
    shareFile: null,      // File currently being shared
    selectedFiles: new Set(), // Selected file sha256 hashes for batch operations
    selectedFolders: new Set(), // Selected folder IDs for batch operations
    selectedTrashFiles: new Set(), // Selected trash file sha256 hashes
    selectionMode: false, // Whether in multi-select mode
    TRASH_RETENTION_DAYS: 30, // Auto-purge after 30 days
    fileTags: {},  // Map of sha256 -> array of tags
    availableTags: [], // All known tags for autocomplete

    async init() {
        // Register service worker for offline support
        this.registerServiceWorker();

        // Setup offline detection
        this.setupOfflineHandlers();

        // Check server health first
        try {
            await API.health();
        } catch (err) {
            if (this.isOffline()) {
                UI.toast('You are offline', 'warning');
            } else {
                UI.toast('Cannot connect to server', 'error');
            }
        }

        // Setup event listeners
        this.setupEventListeners();
        this.setupDragAndDrop();
        this.setupModalEventListeners();

        // Initialize thumbnail cache
        UI.initThumbnails();
        UI.loadFolderCustomizations();
        this.loadFileComments();
        this.loadActivityLog();
        this.loadNotifications();
        this.startNotificationPolling();

        // Load local state (starred, recent, tags)
        this.loadStarredState();
        this.loadRecentState();
        this.loadTagsState();

        // Try to restore saved session
        if (Auth.hasSavedSession()) {
            console.log('Found saved session, attempting to restore...');
            UI.showLoginProgress('Reconnecting to your session...');
            try {
                const restored = await Auth.restoreSession();
                if (restored) {
                    console.log('Session restored, verifying authorization...');
                    UI.showLoginProgress('Session restored, verifying...');
                    await this.verifyAuthorization();
                } else {
                    UI.hideLoginProgress();
                }
            } catch (err) {
                console.error('Failed to restore session:', err);
                UI.hideLoginProgress();
                // Show a helpful message if restore failed
                UI.toast('Session expired. Please log in again.', 'info');
            }
        }

        // Update UI to initial state
        this.updateAuthUI();
    },

    setupEventListeners() {
        // Landing page - NIP-07 connect button
        document.getElementById('connect-nip07').addEventListener('click', () => {
            this.connectNIP07();
        });

        // Landing page - NIP-46 connect button
        document.getElementById('connect-nip46').addEventListener('click', () => {
            UI.showModal('nip46-modal');
        });

        // NIP-46 modal
        document.getElementById('nip46-modal-close').addEventListener('click', () => {
            UI.hideModal('nip46-modal');
        });
        document.getElementById('nip46-cancel').addEventListener('click', () => {
            UI.hideModal('nip46-modal');
        });
        document.getElementById('nip46-connect').addEventListener('click', () => {
            this.connectNIP46();
        });
        document.getElementById('bunker-url').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.connectNIP46();
            }
        });

        // Access denied - disconnect button
        document.getElementById('disconnect-btn').addEventListener('click', () => {
            this.disconnect();
        });

        // File explorer - logout button
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.disconnect();
        });

        // File explorer - upload button
        document.getElementById('upload-btn').addEventListener('click', () => {
            Upload.clear();
            UI.renderUploadList([]);
            UI.showModal('upload-modal');
        });

        // File explorer - new folder button
        document.getElementById('new-folder-btn').addEventListener('click', () => {
            this.promptNewFolder();
        });

        // View toggle buttons
        document.getElementById('view-grid').addEventListener('click', () => {
            this.setViewMode('grid');
        });
        document.getElementById('view-list').addEventListener('click', () => {
            this.setViewMode('list');
        });

        // Select all checkbox in header
        document.getElementById('select-all-checkbox').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.selectAllFiles();
            } else {
                this.clearSelection();
            }
        });

        // Tab buttons
        document.getElementById('tab-my-files').addEventListener('click', () => {
            this.switchView('my-files');
        });
        document.getElementById('tab-shared').addEventListener('click', () => {
            this.switchView('shared');
        });

        // Search
        const searchInput = document.getElementById('search-input');
        const searchClear = document.getElementById('search-clear');

        const searchBox = document.querySelector('.search-box');
        searchInput.addEventListener('input', (e) => {
            const hasContent = e.target.value.length > 0;
            searchBox?.classList.toggle('has-content', hasContent);
            this.handleSearch(e.target.value);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearSearch();
                searchInput.blur();
            }
        });

        searchClear.addEventListener('click', () => {
            this.clearSearch();
        });

        // Search filters
        this.setupSearchFilters();

        // Sorting
        this.setupSorting();

        // Theme toggle
        this.setupThemeToggle();

        // Upload modal
        this.setupUploadModal();

        // Share modal
        this.setupShareModal();

        // Preview modal
        this.setupPreviewModal();

        // File info modal
        this.setupFileInfoModal();

        // Mobile menu
        this.setupMobileMenu();

        // Sidebar navigation
        this.setupSidebarNav();

        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
    },

    // Search filter state
    searchFilters: {
        type: '',
        date: '',
        size: '',
    },

    // Sort state
    sortBy: 'date-desc',

    setupSorting() {
        const sortSelect = document.getElementById('sort-select');
        sortSelect?.addEventListener('change', (e) => {
            this.sortBy = e.target.value;
            this.renderCurrentView();
        });
    },

    // Theme state
    currentTheme: 'dark',
    THEME_STORAGE_KEY: 'cloistr-theme',

    setupThemeToggle() {
        // Load saved theme
        const savedTheme = localStorage.getItem(this.THEME_STORAGE_KEY);
        if (savedTheme) {
            this.setTheme(savedTheme);
        } else {
            // Check system preference
            if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
                this.setTheme('light');
            }
        }

        // Toggle button
        const toggleBtn = document.getElementById('theme-toggle');
        toggleBtn?.addEventListener('click', () => {
            const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
            this.setTheme(newTheme);
            localStorage.setItem(this.THEME_STORAGE_KEY, newTheme);
        });

        // Listen for system preference changes
        window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem(this.THEME_STORAGE_KEY)) {
                this.setTheme(e.matches ? 'dark' : 'light');
            }
        });
    },

    setTheme(theme) {
        this.currentTheme = theme;
        document.documentElement.setAttribute('data-theme', theme);

        // Update button icon
        const toggleBtn = document.getElementById('theme-toggle');
        if (toggleBtn) {
            toggleBtn.innerHTML = theme === 'dark' ? '&#9728;' : '&#127769;'; // Sun or moon
            toggleBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        }
    },

    sortFiles(files) {
        const [field, direction] = this.sortBy.split('-');
        const asc = direction === 'asc';

        return [...files].sort((a, b) => {
            let valueA, valueB;

            switch (field) {
                case 'name':
                    valueA = (a.name || '').toLowerCase();
                    valueB = (b.name || '').toLowerCase();
                    return asc ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA);

                case 'date':
                    valueA = a.created_at || 0;
                    valueB = b.created_at || 0;
                    return asc ? valueA - valueB : valueB - valueA;

                case 'size':
                    valueA = a.size || 0;
                    valueB = b.size || 0;
                    return asc ? valueA - valueB : valueB - valueA;

                case 'type':
                    valueA = (a.mime_type || a.mimeType || '').toLowerCase();
                    valueB = (b.mime_type || b.mimeType || '').toLowerCase();
                    return valueA.localeCompare(valueB);

                default:
                    return 0;
            }
        });
    },

    setupSearchFilters() {
        const filterBtn = document.getElementById('search-filter-btn');
        const filterPanel = document.getElementById('search-filters');
        const filterType = document.getElementById('filter-type');
        const filterDate = document.getElementById('filter-date');
        const filterSize = document.getElementById('filter-size');
        const filterReset = document.getElementById('filter-reset');
        const filterApply = document.getElementById('filter-apply');

        // Toggle filter panel
        const searchBox = document.querySelector('.search-box');
        filterBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpening = filterPanel.classList.contains('hidden');
            filterPanel.classList.toggle('hidden');
            searchBox?.classList.toggle('filter-open', isOpening);
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!filterPanel?.contains(e.target) && e.target !== filterBtn) {
                filterPanel?.classList.add('hidden');
                searchBox?.classList.remove('filter-open');
            }
        });

        // Apply filters
        filterApply?.addEventListener('click', () => {
            this.searchFilters.type = filterType?.value || '';
            this.searchFilters.date = filterDate?.value || '';
            this.searchFilters.size = filterSize?.value || '';
            filterPanel?.classList.add('hidden');
            this.updateFilterButtonState();
            this.applyFilters();
        });

        // Reset filters
        filterReset?.addEventListener('click', () => {
            if (filterType) filterType.value = '';
            if (filterDate) filterDate.value = '';
            if (filterSize) filterSize.value = '';
            this.searchFilters = { type: '', date: '', size: '' };
            this.updateFilterButtonState();
            this.applyFilters();
        });
    },

    updateFilterButtonState() {
        const filterBtn = document.getElementById('search-filter-btn');
        if (!filterBtn) return;
        const hasFilters = this.searchFilters.type || this.searchFilters.date || this.searchFilters.size;
        filterBtn.classList.toggle('active', hasFilters);
    },

    applyFilters() {
        const searchInput = document.getElementById('search-input');
        const query = searchInput?.value || '';

        // If search is active, re-search with filters
        if (query) {
            this.handleSearch(query);
        } else {
            // Filter current view
            this.filterCurrentView();
        }
    },

    filterCurrentView() {
        const hasFilters = this.searchFilters.type || this.searchFilters.date || this.searchFilters.size;

        if (!hasFilters) {
            // No filters, show all files
            UI.renderFileList(this.files, this.folders, '');
            return;
        }

        const filteredFiles = this.files.filter(file => this.matchesFilters(file));
        UI.renderFileList(filteredFiles, this.folders, '');
    },

    matchesFilters(file) {
        const { type, date, size } = this.searchFilters;

        // Type filter
        if (type && !this.matchesTypeFilter(file, type)) {
            return false;
        }

        // Date filter
        if (date && !this.matchesDateFilter(file, date)) {
            return false;
        }

        // Size filter
        if (size && !this.matchesSizeFilter(file, size)) {
            return false;
        }

        return true;
    },

    matchesTypeFilter(file, type) {
        const mimeType = file.mime_type || file.mimeType || '';

        switch (type) {
            case 'image':
                return mimeType.startsWith('image/');
            case 'video':
                return mimeType.startsWith('video/');
            case 'audio':
                return mimeType.startsWith('audio/');
            case 'document':
                return mimeType.startsWith('application/pdf') ||
                       mimeType.includes('document') ||
                       mimeType.includes('spreadsheet') ||
                       mimeType.includes('presentation') ||
                       mimeType.startsWith('text/');
            case 'code':
                return mimeType.includes('javascript') ||
                       mimeType.includes('json') ||
                       mimeType.includes('xml') ||
                       mimeType.includes('html') ||
                       mimeType.includes('css') ||
                       file.name?.match(/\.(js|ts|py|go|rs|rb|php|java|c|cpp|h|jsx|tsx|vue|svelte)$/i);
            case 'archive':
                return mimeType.includes('zip') ||
                       mimeType.includes('tar') ||
                       mimeType.includes('gzip') ||
                       mimeType.includes('rar') ||
                       mimeType.includes('7z');
            default:
                return true;
        }
    },

    matchesDateFilter(file, date) {
        const fileDate = file.created_at ? new Date(file.created_at * 1000) : null;
        if (!fileDate) return true;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        switch (date) {
            case 'today':
                return fileDate >= startOfToday;
            case 'week':
                const weekAgo = new Date(startOfToday);
                weekAgo.setDate(weekAgo.getDate() - 7);
                return fileDate >= weekAgo;
            case 'month':
                const monthAgo = new Date(startOfToday);
                monthAgo.setMonth(monthAgo.getMonth() - 1);
                return fileDate >= monthAgo;
            case 'year':
                const yearAgo = new Date(startOfToday);
                yearAgo.setFullYear(yearAgo.getFullYear() - 1);
                return fileDate >= yearAgo;
            default:
                return true;
        }
    },

    matchesSizeFilter(file, size) {
        const fileSize = file.size || 0;
        const KB = 1024;
        const MB = 1024 * KB;

        switch (size) {
            case 'tiny':
                return fileSize < 100 * KB;
            case 'small':
                return fileSize < 1 * MB;
            case 'medium':
                return fileSize >= 1 * MB && fileSize < 10 * MB;
            case 'large':
                return fileSize >= 10 * MB && fileSize < 100 * MB;
            case 'huge':
                return fileSize >= 100 * MB;
            default:
                return true;
        }
    },

    setupSidebarNav() {
        // Starred
        document.getElementById('nav-starred')?.addEventListener('click', () => {
            this.switchView('starred');
        });

        // Recent
        document.getElementById('nav-recent')?.addEventListener('click', () => {
            this.switchView('recent');
        });

        // Trash
        document.getElementById('nav-trash')?.addEventListener('click', () => {
            this.switchView('trash');
        });

        // My Drive (root folder)
        document.querySelector('.folder-tree-item.root')?.addEventListener('click', () => {
            this.currentFolderId = '';
            this.folderPath = [];
            this.switchView('my-files');
        });
    },

    async switchView(view) {
        this.currentView = view;
        this.clearSelection();
        this.closeMobileSidebar();
        this.clearSearch();

        // Update active state in sidebar
        document.querySelectorAll('.sidebar-nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelectorAll('.folder-tree-item').forEach(item => {
            item.classList.remove('active');
        });

        const navItem = document.getElementById(`nav-${view}`);
        if (navItem) navItem.classList.add('active');

        if (view === 'my-files') {
            document.querySelector('.folder-tree-item.root')?.classList.add('active');
        }

        // Update tab states
        document.getElementById('tab-my-files')?.classList.toggle('active', view === 'my-files');
        document.getElementById('tab-shared')?.classList.toggle('active', view === 'shared');

        // Show/hide appropriate UI elements
        const breadcrumbBar = document.getElementById('breadcrumb-bar');
        const uploadBtn = document.getElementById('upload-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');
        const showFilesUI = view === 'my-files';

        if (breadcrumbBar) breadcrumbBar.style.display = showFilesUI ? '' : 'none';
        if (uploadBtn) uploadBtn.style.display = showFilesUI ? '' : 'none';
        if (newFolderBtn) newFolderBtn.style.display = showFilesUI ? '' : 'none';

        // Render appropriate view
        switch (view) {
            case 'my-files':
                await this.loadFiles();
                break;
            case 'shared':
                await this.loadSharedFiles();
                break;
            case 'starred':
                await this.loadStarredFiles();
                break;
            case 'recent':
                await this.loadRecentFiles();
                break;
            case 'trash':
                await this.loadTrashFiles();
                break;
        }
    },

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't handle shortcuts when typing in inputs
            if (e.target.matches('input, textarea, [contenteditable]')) {
                // Escape should still work to blur inputs
                if (e.key === 'Escape') {
                    e.target.blur();
                }
                return;
            }

            // Don't handle if not authenticated
            if (this.authState !== 'authenticated') return;

            const hasSelection = this.selectedFiles.size > 0;
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

            switch (e.key) {
                case '?':
                    // ?: Show keyboard shortcuts help
                    e.preventDefault();
                    this.showKeyboardShortcutsHelp();
                    break;

                case '/':
                    // /: Focus search
                    e.preventDefault();
                    const searchInput = document.getElementById('search-input');
                    if (searchInput) searchInput.focus();
                    break;

                case 'u':
                    // u: Upload (without Ctrl)
                    if (!ctrlKey) {
                        e.preventDefault();
                        Upload.clear();
                        UI.renderUploadList([]);
                        UI.showModal('upload-modal');
                    }
                    break;

                case 'n':
                    // n: New folder (without Ctrl)
                    if (!ctrlKey) {
                        e.preventDefault();
                        UI.showModal('new-folder-modal');
                        document.getElementById('new-folder-name')?.focus();
                    }
                    break;

                case 'a':
                    // Ctrl+A: Select all
                    if (ctrlKey) {
                        e.preventDefault();
                        this.selectAllFiles();
                    }
                    break;

                case 'Escape':
                    // Escape: Clear selection or close modal
                    if (hasSelection) {
                        this.clearSelection();
                    } else {
                        UI.hideAllModals();
                    }
                    break;

                case 'Delete':
                case 'Backspace':
                    // Delete selected files
                    if (hasSelection && !ctrlKey) {
                        e.preventDefault();
                        this.bulkDelete();
                    }
                    break;

                case 'd':
                    // d: Download selected (without Ctrl)
                    if (!ctrlKey && hasSelection) {
                        e.preventDefault();
                        this.bulkDownload();
                    }
                    break;

                case 'Enter':
                    // Enter: Open/preview first selected file or folder
                    if (hasSelection) {
                        e.preventDefault();
                        const sha256 = Array.from(this.selectedFiles)[0];
                        const file = this.files.find(f => f.sha256 === sha256);
                        if (file) {
                            if (this.isPreviewable(file.mime_type)) {
                                this.showPreview(file);
                            } else {
                                this.downloadFile(file);
                            }
                        }
                    }
                    break;

                case 'ArrowDown':
                case 'ArrowUp':
                    // Arrow keys: Navigate file list
                    e.preventDefault();
                    this.navigateFileList(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
                    break;
            }
        });
    },

    // Navigate file list with arrow keys
    navigateFileList(direction, extendSelection = false) {
        const allFiles = [...this.files];
        if (allFiles.length === 0) return;

        // Find current index
        let currentIndex = -1;
        if (this.selectedFiles.size > 0) {
            const lastSelected = Array.from(this.selectedFiles).pop();
            currentIndex = allFiles.findIndex(f => f.sha256 === lastSelected);
        }

        // Calculate new index
        let newIndex = currentIndex + direction;
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= allFiles.length) newIndex = allFiles.length - 1;

        const targetFile = allFiles[newIndex];
        if (!targetFile) return;

        if (extendSelection) {
            // Shift+Arrow: Extend selection
            this.selectedFiles.add(targetFile.sha256);
        } else {
            // Arrow: Move selection
            this.selectedFiles.clear();
            this.selectedFiles.add(targetFile.sha256);
        }

        this.updateSelectionUI();

        // Scroll into view
        const fileItem = document.querySelector(`.file-item[data-sha256="${targetFile.sha256}"]`);
        fileItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },

    setupUploadModal() {
        document.getElementById('upload-modal-close').addEventListener('click', () => {
            UI.hideModal('upload-modal');
        });

        document.getElementById('upload-cancel').addEventListener('click', () => {
            UI.hideModal('upload-modal');
        });

        const uploadDropZone = document.getElementById('upload-drop-zone');
        const fileInput = document.getElementById('file-input');

        uploadDropZone.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            Upload.addFiles(e.target.files);
            UI.renderUploadList(Upload.files);
            UI.updateUploadButton();
            fileInput.value = '';
        });

        uploadDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadDropZone.classList.add('drag-over');
        });

        uploadDropZone.addEventListener('dragleave', () => {
            uploadDropZone.classList.remove('drag-over');
        });

        uploadDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadDropZone.classList.remove('drag-over');
            Upload.addFiles(e.dataTransfer.files);
            UI.renderUploadList(Upload.files);
            UI.updateUploadButton();
        });

        document.getElementById('upload-start').addEventListener('click', () => {
            this.startUpload();
        });

        // Relay settings
        RelaySettingsUI.setupEventListeners();
    },

    dragCounter: 0,
    dragHideTimeout: null,

    setupDragAndDrop() {
        const fileList = document.getElementById('file-list');
        const dropOverlay = document.getElementById('drop-overlay');

        const hideOverlay = () => {
            dropOverlay?.classList.add('hidden');
            this.dragCounter = 0;
            if (this.dragHideTimeout) {
                clearTimeout(this.dragHideTimeout);
                this.dragHideTimeout = null;
            }
        };

        // Track drag enter/leave globally for overlay
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (this.authState !== 'authenticated') return;

            // Only show overlay for file drags (not internal dragging)
            if (e.dataTransfer?.types?.includes('Files')) {
                this.dragCounter++;
                if (this.dragCounter === 1) {
                    dropOverlay?.classList.remove('hidden');
                }
                // Clear any pending hide timeout since we're still dragging
                if (this.dragHideTimeout) {
                    clearTimeout(this.dragHideTimeout);
                    this.dragHideTimeout = null;
                }
            }
        });

        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            // Only decrement for file drags
            if (!e.dataTransfer?.types?.includes('Files')) return;

            this.dragCounter--;
            if (this.dragCounter <= 0) {
                // Use timeout to handle edge cases where dragleave fires before dragenter on child elements
                this.dragHideTimeout = setTimeout(() => {
                    if (this.dragCounter <= 0) {
                        hideOverlay();
                    }
                }, 100);
            }
        });

        // Main area drag and drop
        fileList.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (this.authState === 'authenticated') {
                fileList.classList.add('drag-over');
            }
        });

        fileList.addEventListener('dragleave', (e) => {
            // Only remove if actually leaving the file list
            if (!fileList.contains(e.relatedTarget)) {
                fileList.classList.remove('drag-over');
            }
        });

        fileList.addEventListener('drop', (e) => {
            e.preventDefault();
            fileList.classList.remove('drag-over');
            hideOverlay();

            if (this.authState !== 'authenticated') {
                return;
            }

            // Check if dropping on a folder
            const folderItem = e.target.closest('.folder-item, .folder-grid-item');
            if (folderItem) {
                const folderId = folderItem.dataset.folderId;
                const folderName = folderItem.dataset.folderName;
                this.uploadToFolder(e.dataTransfer.files, folderId, folderName);
            } else {
                // Upload to current folder
                this.uploadToFolder(e.dataTransfer.files, this.currentFolderId);
            }
        });

        // Prevent default drag behavior on document
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
            hideOverlay();
        });
    },

    setViewMode(mode) {
        UI.viewMode = mode;

        // Update button states
        document.getElementById('view-grid').classList.toggle('active', mode === 'grid');
        document.getElementById('view-list').classList.toggle('active', mode === 'list');

        // Re-render current view
        this.renderCurrentView();
    },

    // Debounce timer for search
    searchDebounceTimer: null,
    useEncryptedSearch: false,

    handleSearch(query) {
        this.searchQuery = query.toLowerCase().trim();

        // Show/hide clear button
        const searchClear = document.getElementById('search-clear');
        searchClear.classList.toggle('hidden', !this.searchQuery);

        // Debounce encrypted search
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Use encrypted search for content queries (3+ chars)
        if (this.searchQuery.length >= 3 && Search.indexKey) {
            this.searchDebounceTimer = setTimeout(() => {
                this.performEncryptedSearch(this.searchQuery);
            }, 300);
        } else {
            // Use simple filter for short queries or when search not initialized
            this.renderCurrentView();
        }
    },

    async performEncryptedSearch(query) {
        try {
            const results = await Search.search(query);

            if (results.length > 0) {
                // Convert search results to file format
                const searchFiles = results.map(r => ({
                    sha256: r.sha256,
                    name: r.name,
                    size: r.size,
                    mime_type: r.mimeType,
                    file_id: r.fileId,
                    encrypted: true,
                    _searchScore: r.score,
                }));

                // Merge with existing files, prioritize search results
                const fileIds = new Set(searchFiles.map(f => f.file_id || f.sha256));
                const filteredExisting = this.files.filter(f => {
                    const id = f.file_id || f.fileId || f.sha256;
                    return fileIds.has(id);
                });

                // Render with search results
                UI.renderFileList(filteredExisting.length > 0 ? filteredExisting : searchFiles, [], query);
            } else {
                // Fall back to simple filter
                this.renderCurrentView();
            }
        } catch (err) {
            console.error('Encrypted search failed:', err);
            // Fall back to simple filter
            this.renderCurrentView();
        }
    },

    clearSearch() {
        this.searchQuery = '';
        document.getElementById('search-input').value = '';
        document.getElementById('search-clear').classList.add('hidden');
        document.querySelector('.search-box')?.classList.remove('has-content');
        this.renderCurrentView();
    },

    // Filter files based on search query and filters
    filterBySearch(files) {
        let filtered = files;

        // Apply text search
        if (this.searchQuery) {
            filtered = filtered.filter(file => {
                const name = (file.name || '').toLowerCase();
                const sha = (file.sha256 || '').toLowerCase();
                return name.includes(this.searchQuery) || sha.includes(this.searchQuery);
            });
        }

        // Apply additional filters
        const hasFilters = this.searchFilters?.type || this.searchFilters?.date || this.searchFilters?.size;
        if (hasFilters) {
            filtered = filtered.filter(file => this.matchesFilters(file));
        }

        return filtered;
    },

    // Filter folders based on search query
    filterFoldersBySearch(folders) {
        if (!this.searchQuery) return folders;

        return folders.filter(folder => {
            const name = (folder.name || '').toLowerCase();
            return name.includes(this.searchQuery);
        });
    },

    renderCurrentView() {
        if (this.currentView === 'my-files') {
            const filteredFiles = this.filterBySearch(this.files);
            const sortedFiles = this.sortFiles(filteredFiles);
            const filteredFolders = this.filterFoldersBySearch(this.folders);
            UI.renderFileList(sortedFiles, filteredFolders, this.searchQuery);
        } else {
            const filteredShared = this.filterBySearch(this.sharedFiles);
            const sortedShared = this.sortFiles(filteredShared);
            UI.renderSharedFiles(sortedShared, this.searchQuery);
        }
    },

    async loadSharedFiles() {
        try {
            const pubkey = Auth.isConnected ? Auth.pubkey : null;
            if (!pubkey) return;

            const response = await API.listShares(pubkey, 'received');
            const shares = response.received || [];

            // Decrypt share content and build file list
            this.sharedFiles = [];
            const now = Math.floor(Date.now() / 1000);

            for (const share of shares) {
                // Check if share has expired
                if (share.expires_at && share.expires_at < now) {
                    console.log('Skipping expired share:', share.id?.slice(0, 8));
                    continue;
                }

                try {
                    // Decrypt the share content
                    const decryptedContent = await Auth.nip04Decrypt(
                        share.owner_pubkey,
                        share.encrypted_content
                    );

                    const content = JSON.parse(decryptedContent);

                    this.sharedFiles.push({
                        id: share.id,
                        sha256: content.fileSHA256,
                        name: content.fileName,
                        size: content.fileSize,
                        mime_type: content.fileMimeType,
                        url: content.fileURL,
                        owner_pubkey: share.owner_pubkey,
                        message: content.message,
                        created_at: share.created_at,
                        expires_at: share.expires_at,
                        permission: share.permission,
                        // Encryption fields for shared files
                        encrypted: content.encrypted || false,
                        file_id: content.fileId,
                        fileKey: content.fileKey,  // Decryption key from sharer
                        isShared: true,
                    });
                } catch (decryptErr) {
                    console.warn('Failed to decrypt share:', decryptErr);
                    // Still show the share but without decrypted details
                    this.sharedFiles.push({
                        id: share.id,
                        sha256: share.file_id,
                        name: '(Encrypted)',
                        owner_pubkey: share.owner_pubkey,
                        created_at: share.created_at,
                        expires_at: share.expires_at,
                        encrypted: true,
                    });
                }
            }

            this.renderCurrentView();
        } catch (err) {
            console.error('Failed to load shared files:', err);
            UI.toast('Failed to load shared files', 'error');
        }
    },

    // === Starred Files ===

    async loadStarredFiles() {
        UI.showLoadingSkeleton();

        try {
            // Load starred state from IndexedDB
            await this.loadStarredState();

            // Load all files and filter for starred ones
            const pubkey = Auth.pubkey;
            const response = await API.listFilesInFolder(pubkey, '');
            const allFiles = response.files || [];

            // Filter for files that are starred and not deleted
            const starredFiles = allFiles.filter(f =>
                this.starredFiles.has(f.sha256) && !f.deleted_at && !f.deletedAt
            );

            // Render starred view
            this.renderStarredView(starredFiles);
        } catch (err) {
            console.error('Failed to load starred files:', err);
            UI.showErrorState('Failed to load starred files', () => this.loadStarredFiles());
        }
    },

    async loadStarredState() {
        try {
            const stored = localStorage.getItem('cloistr-starred');
            if (stored) {
                this.starredFiles = new Set(JSON.parse(stored));
            }
        } catch (err) {
            console.warn('Failed to load starred state:', err);
        }
    },

    saveStarredState() {
        try {
            localStorage.setItem('cloistr-starred', JSON.stringify([...this.starredFiles]));
        } catch (err) {
            console.warn('Failed to save starred state:', err);
        }
    },

    toggleStar(sha256) {
        if (this.starredFiles.has(sha256)) {
            this.starredFiles.delete(sha256);
            UI.toast('Removed from starred', 'info');
        } else {
            this.starredFiles.add(sha256);
            UI.toast('Added to starred', 'success');
        }
        this.saveStarredState();

        // Update star icon in current view if visible
        const starBtn = document.querySelector(`.file-item[data-sha256="${sha256}"] .star-btn`);
        if (starBtn) {
            starBtn.classList.toggle('starred', this.starredFiles.has(sha256));
            starBtn.innerHTML = this.starredFiles.has(sha256) ? '&#9733;' : '&#9734;';
        }
    },

    renderStarredView(files) {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        // Hide upload buttons
        document.getElementById('upload-btn').style.display = 'none';
        document.getElementById('new-folder-btn').style.display = 'none';

        if (files.length === 0) {
            body.innerHTML = '';
            if (emptyState) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = `
                    <div class="empty-icon">&#9733;</div>
                    <div class="empty-text">No starred files</div>
                    <div class="empty-subtext">Star files to quickly access them later</div>
                `;
            }
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        const html = files.map(file => UI.renderFileListItem(file)).join('');
        body.innerHTML = html;
        UI.attachFileEventListeners(body);
    },

    // === Recent Files ===

    async loadRecentFiles() {
        UI.showLoadingSkeleton();

        try {
            // Load recent access times from localStorage
            await this.loadRecentState();

            // Load all files
            const pubkey = Auth.pubkey;
            const response = await API.listFilesInFolder(pubkey, '');
            const allFiles = response.files || [];

            // Filter for files that were recently accessed and not deleted
            const recentSha256 = this.recentFiles.map(r => r.sha256);
            const recentFilesData = allFiles.filter(f =>
                recentSha256.includes(f.sha256) && !f.deleted_at && !f.deletedAt
            );

            // Sort by access time (most recent first)
            recentFilesData.sort((a, b) => {
                const accessA = this.recentFiles.find(r => r.sha256 === a.sha256)?.accessedAt || 0;
                const accessB = this.recentFiles.find(r => r.sha256 === b.sha256)?.accessedAt || 0;
                return accessB - accessA;
            });

            // Take only last 50
            const recent50 = recentFilesData.slice(0, 50);

            this.renderRecentView(recent50);
        } catch (err) {
            console.error('Failed to load recent files:', err);
            UI.showErrorState('Failed to load recent files', () => this.loadRecentFiles());
        }
    },

    async loadRecentState() {
        try {
            const stored = localStorage.getItem('cloistr-recent');
            if (stored) {
                this.recentFiles = JSON.parse(stored);
            }
        } catch (err) {
            console.warn('Failed to load recent state:', err);
        }
    },

    recordFileAccess(sha256) {
        // Remove existing entry for this file
        this.recentFiles = this.recentFiles.filter(r => r.sha256 !== sha256);

        // Add to front
        this.recentFiles.unshift({
            sha256,
            accessedAt: Math.floor(Date.now() / 1000),
        });

        // Keep only last 100
        this.recentFiles = this.recentFiles.slice(0, 100);

        // Save
        try {
            localStorage.setItem('cloistr-recent', JSON.stringify(this.recentFiles));
        } catch (err) {
            console.warn('Failed to save recent state:', err);
        }
    },

    renderRecentView(files) {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        // Hide upload buttons
        document.getElementById('upload-btn').style.display = 'none';
        document.getElementById('new-folder-btn').style.display = 'none';

        if (files.length === 0) {
            body.innerHTML = '';
            if (emptyState) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = `
                    <div class="empty-icon">&#128337;</div>
                    <div class="empty-text">No recent files</div>
                    <div class="empty-subtext">Files you open or download will appear here</div>
                `;
            }
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        const html = files.map(file => UI.renderFileListItem(file)).join('');
        body.innerHTML = html;
        UI.attachFileEventListeners(body);
    },

    // === File Tags ===

    loadTagsState() {
        try {
            const stored = localStorage.getItem('cloistr-tags');
            if (stored) {
                this.fileTags = JSON.parse(stored);
            }
            const availableStored = localStorage.getItem('cloistr-available-tags');
            if (availableStored) {
                this.availableTags = JSON.parse(availableStored);
            }
        } catch (err) {
            console.warn('Failed to load tags state:', err);
        }
    },

    saveTagsState() {
        try {
            localStorage.setItem('cloistr-tags', JSON.stringify(this.fileTags));
            localStorage.setItem('cloistr-available-tags', JSON.stringify(this.availableTags));
        } catch (err) {
            console.warn('Failed to save tags state:', err);
        }
    },

    getFileTags(sha256) {
        return this.fileTags[sha256] || [];
    },

    addTagToFile(sha256, tag) {
        const normalizedTag = tag.trim().toLowerCase();
        if (!normalizedTag) return;

        if (!this.fileTags[sha256]) {
            this.fileTags[sha256] = [];
        }

        if (!this.fileTags[sha256].includes(normalizedTag)) {
            this.fileTags[sha256].push(normalizedTag);

            // Add to available tags for autocomplete
            if (!this.availableTags.includes(normalizedTag)) {
                this.availableTags.push(normalizedTag);
            }

            this.saveTagsState();
            UI.toast(`Tag "${normalizedTag}" added`, 'success');
        }
    },

    removeTagFromFile(sha256, tag) {
        if (this.fileTags[sha256]) {
            this.fileTags[sha256] = this.fileTags[sha256].filter(t => t !== tag);
            if (this.fileTags[sha256].length === 0) {
                delete this.fileTags[sha256];
            }
            this.saveTagsState();
            UI.toast(`Tag "${tag}" removed`, 'info');
        }
    },

    showTagsModal(file) {
        const modal = document.getElementById('tags-modal');
        const fileName = document.getElementById('tags-file-name');
        const tagsContainer = document.getElementById('tags-container');
        const tagInput = document.getElementById('tag-input');
        const suggestions = document.getElementById('tag-suggestions');

        if (!modal) return;

        this.tagModalFile = file;
        fileName.textContent = file.name;

        // Render current tags
        this.renderFileTags(tagsContainer, file.sha256);

        // Clear input and suggestions
        tagInput.value = '';
        suggestions.innerHTML = '';
        suggestions.classList.add('hidden');

        UI.showModal('tags-modal');
        tagInput.focus();
    },

    // Folder customization
    customizingFolder: null,
    selectedFolderColor: null,
    selectedFolderIcon: null,

    showFolderCustomizeModal(folderId, folderName) {
        this.customizingFolder = folderId;
        const current = UI.getFolderCustomization(folderId);
        this.selectedFolderColor = current.color;
        this.selectedFolderIcon = current.icon;

        // Set folder name
        document.getElementById('customize-folder-name').textContent = folderName;

        // Render color picker
        const colorPicker = document.getElementById('folder-color-picker');
        colorPicker.innerHTML = UI.folderColors.map(color => {
            const isSelected = color.value === this.selectedFolderColor;
            const isDefault = color.value === null;
            const bg = color.value || '#888';
            return `<div class="color-swatch ${isSelected ? 'selected' : ''} ${isDefault ? 'default' : ''}"
                        data-color="${color.value || ''}"
                        style="background-color: ${bg}"
                        title="${color.name}"></div>`;
        }).join('');

        // Add color swatch click handlers
        colorPicker.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
                this.selectedFolderColor = swatch.dataset.color || null;
            });
        });

        // Render icon picker
        const iconPicker = document.getElementById('folder-icon-picker');
        iconPicker.innerHTML = UI.folderIcons.map(icon => {
            const isSelected = icon.code === this.selectedFolderIcon;
            return `<div class="icon-option ${isSelected ? 'selected' : ''}"
                        data-icon="${icon.code}"
                        title="${icon.name}">${icon.value}</div>`;
        }).join('');

        // Add icon option click handlers
        iconPicker.querySelectorAll('.icon-option').forEach(option => {
            option.addEventListener('click', () => {
                iconPicker.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                const iconCode = option.dataset.icon;
                this.selectedFolderIcon = iconCode === '&#128193;' ? null : iconCode;
            });
        });

        UI.showModal('folder-customize-modal');
    },

    saveFolderCustomization() {
        if (this.customizingFolder) {
            UI.setFolderCustomization(
                this.customizingFolder,
                this.selectedFolderColor,
                this.selectedFolderIcon
            );
            // Refresh the file list to show updated folder
            this.loadFiles();
        }
        UI.hideModal('folder-customize-modal');
        this.customizingFolder = null;
    },

    resetFolderCustomization() {
        if (this.customizingFolder) {
            UI.setFolderCustomization(this.customizingFolder, null, null);
            this.loadFiles();
        }
        UI.hideModal('folder-customize-modal');
        this.customizingFolder = null;
    },

    // File comments storage
    fileComments: {},
    COMMENTS_STORAGE_KEY: 'cloistr-file-comments',
    commentsModalFile: null,

    loadFileComments() {
        try {
            const stored = localStorage.getItem(this.COMMENTS_STORAGE_KEY);
            this.fileComments = stored ? JSON.parse(stored) : {};
        } catch (e) {
            this.fileComments = {};
        }
    },

    saveFileComments() {
        try {
            localStorage.setItem(this.COMMENTS_STORAGE_KEY, JSON.stringify(this.fileComments));
        } catch (e) {
            console.error('Failed to save comments:', e);
        }
    },

    getFileComments(sha256) {
        return this.fileComments[sha256] || [];
    },

    addComment(sha256, text) {
        if (!text.trim()) return;

        if (!this.fileComments[sha256]) {
            this.fileComments[sha256] = [];
        }

        this.fileComments[sha256].push({
            id: Date.now().toString(),
            text: text.trim(),
            timestamp: Date.now(),
        });

        this.saveFileComments();
    },

    deleteComment(sha256, commentId) {
        if (!this.fileComments[sha256]) return;

        this.fileComments[sha256] = this.fileComments[sha256].filter(c => c.id !== commentId);

        if (this.fileComments[sha256].length === 0) {
            delete this.fileComments[sha256];
        }

        this.saveFileComments();
    },

    getCommentCount(sha256) {
        return (this.fileComments[sha256] || []).length;
    },

    showCommentsModal(file) {
        this.commentsModalFile = file;
        const fileName = document.getElementById('comments-file-name');
        const commentsList = document.getElementById('comments-list');
        const commentInput = document.getElementById('comment-input');

        fileName.textContent = file.name;
        commentInput.value = '';

        this.renderComments(commentsList, file.sha256);
        UI.showModal('comments-modal');
        commentInput.focus();
    },

    renderComments(container, sha256) {
        const comments = this.getFileComments(sha256);

        if (comments.length === 0) {
            container.innerHTML = '<div class="no-comments">No comments yet</div>';
            return;
        }

        container.innerHTML = comments.map(comment => `
            <div class="comment-item" data-comment-id="${comment.id}">
                <div class="comment-header">
                    <span class="comment-date">${new Date(comment.timestamp).toLocaleString()}</span>
                    <div class="comment-actions">
                        <button class="comment-action-btn delete" data-action="delete" title="Delete comment">&#10005;</button>
                    </div>
                </div>
                <div class="comment-text">${UI.escapeHtml(comment.text)}</div>
            </div>
        `).join('');

        // Add delete handlers
        container.querySelectorAll('.comment-action-btn[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const commentItem = e.target.closest('.comment-item');
                const commentId = commentItem.dataset.commentId;
                if (confirm('Delete this comment?')) {
                    this.deleteComment(sha256, commentId);
                    this.renderComments(container, sha256);
                }
            });
        });
    },

    // Activity log
    activityLog: [],
    ACTIVITY_STORAGE_KEY: 'cloistr-activity-log',
    MAX_ACTIVITY_ITEMS: 500,

    loadActivityLog() {
        try {
            const stored = localStorage.getItem(this.ACTIVITY_STORAGE_KEY);
            this.activityLog = stored ? JSON.parse(stored) : [];
        } catch (e) {
            this.activityLog = [];
        }
    },

    saveActivityLog() {
        try {
            // Trim to max items
            if (this.activityLog.length > this.MAX_ACTIVITY_ITEMS) {
                this.activityLog = this.activityLog.slice(-this.MAX_ACTIVITY_ITEMS);
            }
            localStorage.setItem(this.ACTIVITY_STORAGE_KEY, JSON.stringify(this.activityLog));
        } catch (e) {
            console.error('Failed to save activity log:', e);
        }
    },

    logActivity(type, details) {
        const entry = {
            id: Date.now().toString(),
            type,
            details,
            timestamp: Date.now(),
        };
        this.activityLog.push(entry);
        this.saveActivityLog();
    },

    getActivityIcon(type) {
        const icons = {
            upload: '&#128194;',     // Folder with up arrow
            download: '&#128229;',   // Inbox
            delete: '&#128465;',     // Trash
            move: '&#128193;',       // Folder
            share: '&#128101;',      // People
            comment: '&#128172;',    // Speech bubble
            folder: '&#128193;',     // Folder
            login: '&#128274;',      // Lock
            logout: '&#128275;',     // Unlock
        };
        return icons[type] || '&#128196;';
    },

    showActivityModal() {
        this.renderActivityLog();
        UI.showModal('activity-modal');
    },

    renderActivityLog(filter = 'all') {
        const container = document.getElementById('activity-list');
        let activities = [...this.activityLog].reverse(); // Most recent first

        if (filter !== 'all') {
            activities = activities.filter(a => a.type === filter);
        }

        if (activities.length === 0) {
            container.innerHTML = '<div class="no-activity">No activity recorded</div>';
            return;
        }

        container.innerHTML = activities.map(activity => `
            <div class="activity-item" data-id="${activity.id}">
                <div class="activity-icon">${this.getActivityIcon(activity.type)}</div>
                <div class="activity-details">
                    <div class="activity-text">${this.formatActivityText(activity)}</div>
                    <div class="activity-time">${this.formatActivityTime(activity.timestamp)}</div>
                </div>
            </div>
        `).join('');
    },

    formatActivityText(activity) {
        const d = activity.details;
        switch (activity.type) {
            case 'upload':
                return `Uploaded <strong>${UI.escapeHtml(d.name || 'file')}</strong>`;
            case 'download':
                return `Downloaded <strong>${UI.escapeHtml(d.name || 'file')}</strong>`;
            case 'delete':
                return `Moved <strong>${UI.escapeHtml(d.name || 'file')}</strong> to trash`;
            case 'move':
                return `Moved <strong>${UI.escapeHtml(d.name || 'file')}</strong> to <strong>${UI.escapeHtml(d.destination || 'folder')}</strong>`;
            case 'share':
                return `Shared <strong>${UI.escapeHtml(d.name || 'file')}</strong>`;
            case 'comment':
                return `Added comment to <strong>${UI.escapeHtml(d.name || 'file')}</strong>`;
            case 'folder':
                return `Created folder <strong>${UI.escapeHtml(d.name || 'folder')}</strong>`;
            case 'login':
                return `Logged in`;
            case 'logout':
                return `Logged out`;
            default:
                return d.message || 'Unknown activity';
        }
    },

    formatActivityTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} minutes ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)} days ago`;

        return new Date(timestamp).toLocaleDateString();
    },

    clearActivityLog() {
        if (confirm('Clear all activity history? This cannot be undone.')) {
            this.activityLog = [];
            this.saveActivityLog();
            this.renderActivityLog();
        }
    },

    // Notifications system
    notifications: [],
    NOTIFICATIONS_STORAGE_KEY: 'cloistr-notifications',
    lastShareCheck: 0,
    notificationPollInterval: null,

    loadNotifications() {
        try {
            const stored = localStorage.getItem(this.NOTIFICATIONS_STORAGE_KEY);
            this.notifications = stored ? JSON.parse(stored) : [];
            this.updateNotificationCount();
        } catch (e) {
            this.notifications = [];
        }
    },

    saveNotifications() {
        try {
            localStorage.setItem(this.NOTIFICATIONS_STORAGE_KEY, JSON.stringify(this.notifications));
            this.updateNotificationCount();
        } catch (e) {
            console.error('Failed to save notifications:', e);
        }
    },

    addNotification(type, data) {
        const notification = {
            id: Date.now().toString(),
            type,
            data,
            timestamp: Date.now(),
            read: false,
        };
        this.notifications.unshift(notification);
        this.saveNotifications();

        // Request browser notification permission if not already granted
        if (Notification.permission === 'granted') {
            new Notification('Cloistr Drive', {
                body: this.getNotificationText(notification),
                icon: '/favicon.svg',
            });
        }
    },

    getNotificationText(notification) {
        const d = notification.data;
        switch (notification.type) {
            case 'share_received':
                return `${d.from || 'Someone'} shared "${d.name}" with you`;
            case 'share_folder':
                return `${d.from || 'Someone'} shared folder "${d.name}" with you`;
            default:
                return 'New notification';
        }
    },

    markNotificationRead(id) {
        const notification = this.notifications.find(n => n.id === id);
        if (notification) {
            notification.read = true;
            this.saveNotifications();
        }
    },

    markAllNotificationsRead() {
        this.notifications.forEach(n => n.read = true);
        this.saveNotifications();
        this.renderNotifications();
    },

    getUnreadCount() {
        return this.notifications.filter(n => !n.read).length;
    },

    updateNotificationCount() {
        const badge = document.getElementById('notification-count');
        const count = this.getUnreadCount();
        if (badge) {
            badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '';
        }
    },

    showNotificationsModal() {
        this.renderNotifications();
        UI.showModal('notifications-modal');
    },

    renderNotifications() {
        const container = document.getElementById('notifications-list');

        if (this.notifications.length === 0) {
            container.innerHTML = '<div class="no-notifications">No notifications</div>';
            return;
        }

        container.innerHTML = this.notifications.map(notification => `
            <div class="notification-item ${notification.read ? '' : 'unread'}" data-id="${notification.id}">
                <div class="notification-icon">${this.getNotificationIcon(notification.type)}</div>
                <div class="notification-content">
                    <div class="notification-title">${this.getNotificationTitle(notification)}</div>
                    <div class="notification-description">${this.getNotificationText(notification)}</div>
                    <div class="notification-time">${this.formatActivityTime(notification.timestamp)}</div>
                    ${this.getNotificationActions(notification)}
                </div>
            </div>
        `).join('');

        // Add click handlers
        container.querySelectorAll('.notification-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                this.markNotificationRead(id);
                item.classList.remove('unread');
            });
        });

        // Add action button handlers
        container.querySelectorAll('.accept-share-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                this.acceptShare(id);
            });
        });

        container.querySelectorAll('.decline-share-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                this.declineShare(id);
            });
        });
    },

    getNotificationIcon(type) {
        const icons = {
            share_received: '&#128101;',
            share_folder: '&#128193;',
        };
        return icons[type] || '&#128276;';
    },

    getNotificationTitle(notification) {
        switch (notification.type) {
            case 'share_received':
                return 'File Shared';
            case 'share_folder':
                return 'Folder Shared';
            default:
                return 'Notification';
        }
    },

    getNotificationActions(notification) {
        if (notification.type === 'share_received' || notification.type === 'share_folder') {
            return `
                <div class="notification-actions">
                    <button class="btn btn-primary accept-share-btn" data-id="${notification.id}">Accept</button>
                    <button class="btn decline-share-btn" data-id="${notification.id}">Decline</button>
                </div>
            `;
        }
        return '';
    },

    acceptShare(notificationId) {
        const notification = this.notifications.find(n => n.id === notificationId);
        if (notification) {
            notification.read = true;
            notification.accepted = true;
            this.saveNotifications();
            UI.toast(`Accepted share: ${notification.data.name}`, 'success');
            this.loadFiles(); // Refresh to show new shared content
            this.renderNotifications();
        }
    },

    declineShare(notificationId) {
        const notification = this.notifications.find(n => n.id === notificationId);
        if (notification) {
            notification.read = true;
            notification.declined = true;
            this.saveNotifications();
            UI.toast('Share declined', 'info');
            this.renderNotifications();
        }
    },

    startNotificationPolling() {
        // Check for new shares every 30 seconds
        this.notificationPollInterval = setInterval(() => {
            this.checkForNewShares();
        }, 30000);

        // Also check immediately
        setTimeout(() => this.checkForNewShares(), 5000);
    },

    async checkForNewShares() {
        try {
            if (!Auth.pubkey) return;

            // Query for shares directed to us via API
            const response = await API.listShares(Auth.pubkey, 'received');
            const shares = response.shares || [];

            // Filter for new shares (not already notified)
            const existingIds = new Set(
                this.notifications
                    .filter(n => n.type === 'share_received' || n.type === 'share_folder')
                    .map(n => n.data.shareId)
            );

            for (const share of shares) {
                if (!existingIds.has(share.id)) {
                    this.addNotification(
                        share.isFolder ? 'share_folder' : 'share_received',
                        {
                            shareId: share.id,
                            name: share.name || 'Unknown',
                            from: share.from ? share.from.slice(0, 8) + '...' : 'Someone',
                        }
                    );
                }
            }
        } catch (e) {
            // Background operation - log but don't interrupt user
            console.warn('Share check failed:', e);
        }
    },

    stopNotificationPolling() {
        if (this.notificationPollInterval) {
            clearInterval(this.notificationPollInterval);
            this.notificationPollInterval = null;
        }
    },

    // Request browser notification permission
    requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    },

    renderFileTags(container, sha256) {
        const tags = this.getFileTags(sha256);
        container.innerHTML = tags.length === 0
            ? '<span class="no-tags">No tags yet</span>'
            : tags.map(tag => `
                <span class="tag-chip">
                    ${UI.escapeHtml(tag)}
                    <button class="tag-remove" data-tag="${UI.escapeHtml(tag)}">&times;</button>
                </span>
            `).join('');

        // Add remove listeners
        container.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                this.removeTagFromFile(sha256, btn.dataset.tag);
                this.renderFileTags(container, sha256);
            });
        });
    },

    filterByTag(tag) {
        // Filter current view by tag
        this.currentTagFilter = tag;
        UI.toast(`Filtering by tag: ${tag}`, 'info');
        this.loadFiles();
    },

    async connectNIP07() {
        try {
            if (!Auth.hasExtension()) {
                UI.toast('No Nostr extension found. Please install nos2x, Alby, or similar.', 'error');
                return;
            }

            const pubkey = await Auth.connect();
            await this.verifyAuthorization();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    async connectNIP46() {
        const bunkerUrl = document.getElementById('bunker-url').value.trim();
        const statusEl = document.getElementById('nip46-status');
        const connectBtn = document.getElementById('nip46-connect');

        if (!bunkerUrl) {
            UI.toast('Please enter a bunker URL', 'error');
            return;
        }

        // Validate URL format
        if (!bunkerUrl.startsWith('bunker://') && !bunkerUrl.startsWith('nostrconnect://')) {
            UI.toast('Invalid bunker URL. Must start with bunker:// or nostrconnect://', 'error');
            return;
        }

        // Show connecting status
        statusEl.classList.remove('hidden', 'error', 'success');
        statusEl.innerHTML = '<div class="spinner"></div><span>Connecting to remote signer...</span>';
        connectBtn.disabled = true;

        try {
            // Connect via NIP-46
            await Auth.connectNIP46(bunkerUrl);

            // Show success
            statusEl.classList.add('success');
            statusEl.innerHTML = '<span>Connected! Verifying authorization...</span>';

            // Verify authorization
            await this.verifyAuthorization();

            // Close modal on success
            UI.hideModal('nip46-modal');
            statusEl.classList.add('hidden');
        } catch (err) {
            console.error('NIP-46 connection failed:', err);

            // Show error in modal
            statusEl.classList.add('error');
            statusEl.innerHTML = `<span>Connection failed: ${err.message}</span>`;

            UI.toast(`Connection failed: ${err.message}`, 'error');
        } finally {
            connectBtn.disabled = false;
        }
    },

    async verifyAuthorization() {
        try {
            // Create a simple auth header for status check
            UI.showLoginProgress('Verifying authorization...');
            console.log('Auth: Creating status auth header...');
            console.log('Auth: Connection type:', Auth.connectionType);
            console.log('Auth: Client-side pubkey:', Auth.pubkey);
            const authHeader = await Auth.createStatusAuth();
            // Decode and log what we're sending
            try {
                const b64 = authHeader.replace('Nostr ', '');
                const decoded = JSON.parse(atob(b64));
                console.log('Auth: Event pubkey in header:', decoded.pubkey);
                console.log('Auth: Event id:', decoded.id);
                console.log('Auth: Event sig:', decoded.sig?.slice(0, 16) + '...');
            } catch (e) {
                console.log('Auth: Could not decode header for logging');
            }
            console.log('Auth: Got auth header, checking status...');
            const result = await API.checkAuthStatus(authHeader);
            console.log('Auth: Status result:', result);
            console.log('Auth: Server saw pubkey:', result.pubkey);

            if (!result.authorized) {
                console.log('Auth: Not authorized. Client pubkey:', Auth.pubkey, 'Server saw:', result.pubkey);
                UI.hideLoginProgress();
                this.authState = 'denied';
                document.getElementById('denied-pubkey').textContent = Auth.pubkey;
                this.updateAuthUI();
                return;
            }

            // Authorization succeeded, now initialize libraries
            try {
                console.log('App: Initializing crypto...');
                UI.showLoginProgress('Initializing encryption...');
                await Crypto.init();
                await Keys.init(Auth.pubkey);

                console.log('App: Initializing search...');
                UI.showLoginProgress('Setting up search index...');
                await Search.init(Auth.pubkey);

                await Versioning.init();
            } catch (initErr) {
                // Library init failed - this is NOT an auth failure
                console.error('Library initialization failed:', initErr);
                UI.toast(`Initialization error: ${initErr.message}. Please refresh the page.`, 'error');
                UI.hideLoginProgress();
                // Stay on landing page, don't show "Access Denied"
                this.authState = 'unauthenticated';
                Auth.disconnect();
                this.updateAuthUI();
                return;
            }

            UI.showLoginProgress('Loading your files...');
            this.authState = 'authenticated';
            await this.loadFiles();
            await this.loadFolderTree();
            UI.hideLoginProgress();
            UI.toast('Connected', 'success');
        } catch (err) {
            console.error('Auth verification failed:', err);
            UI.hideLoginProgress();
            // Check if this is an auth failure or a network/other error
            if (err.message && (err.message.includes('401') || err.message.includes('403') || err.message.includes('unauthorized'))) {
                this.authState = 'denied';
                document.getElementById('denied-pubkey').textContent = Auth.pubkey;
            } else {
                // Network error or other issue - don't show access denied
                UI.toast(`Connection error: ${err.message}. Please try again.`, 'error');
                this.authState = 'unauthenticated';
                Auth.disconnect();
            }
        }

        this.updateAuthUI();
    },

    disconnect() {
        // Clear encryption keys from memory
        Keys.clearCache();

        // Clear search index key
        Search.clearKey();

        // Clear versioning cache
        Versioning.clearCache();

        Auth.disconnect();
        this.authState = 'unauthenticated';
        this.files = [];
        this.folders = [];
        this.sharedFiles = [];
        this.currentFolderId = '';
        this.folderPath = [];
        this.updateAuthUI();
        UI.toast('Disconnected', 'info');
    },

    updateAuthUI() {
        const landingPage = document.getElementById('landing-page');
        const accessDenied = document.getElementById('access-denied');
        const fileExplorer = document.getElementById('file-explorer');

        // Hide all sections first
        landingPage.classList.add('hidden');
        accessDenied.classList.add('hidden');
        fileExplorer.classList.add('hidden');

        // Show appropriate section
        switch (this.authState) {
            case 'unauthenticated':
                landingPage.classList.remove('hidden');
                break;
            case 'denied':
                accessDenied.classList.remove('hidden');
                // Close any open login modals
                UI.hideModal('nip46-modal');
                break;
            case 'authenticated':
                fileExplorer.classList.remove('hidden');
                UI.setConnectedState(Auth.pubkey);
                // Close any open login modals (e.g., if session was restored while modal was open)
                UI.hideModal('nip46-modal');
                break;
        }
    },

    async loadFiles() {
        const pubkey = Auth.isConnected ? Auth.pubkey : null;
        if (!pubkey) return;

        console.log('loadFiles: Starting, pubkey:', pubkey.slice(0, 16) + '...', 'folder:', this.currentFolderId || '(root)');

        // Show loading state
        UI.showLoadingSkeleton();

        try {
            // Load folders and files for current folder
            const [foldersResponse, filesResponse] = await Promise.all([
                API.listFolders(pubkey, this.currentFolderId),
                API.listFilesInFolder(pubkey, this.currentFolderId),
            ]);

            this.folders = foldersResponse.folders || [];
            // Filter out deleted files (they go to trash view) and config events
            const allFiles = filesResponse.files || [];
            this.files = allFiles.filter(f => {
                // Must not be deleted
                if (f.deleted_at || f.deletedAt) return false;
                // Must have a valid sha256 (config events like root-key may not)
                if (!f.sha256 || f.sha256.length < 16) return false;
                // Skip known config event identifiers
                const id = f.id || f.file_id || f.fileId || f.d || '';
                if (id === 'root-key') return false;
                return true;
            });

            console.log('loadFiles: Loaded', this.folders.length, 'folders,', this.files.length, 'files (', allFiles.length - this.files.length, 'in trash)');

            // Restore folder keys from encrypted_key field
            // This ensures folder keys are available after page refresh
            await this.restoreFolderKeys(this.folders);
            if (this.files.length > 0) {
                console.log('loadFiles: First file:', this.files[0]?.name, 'id:', this.files[0]?.id?.slice(0, 16));
            }

            this.renderCurrentView();
            this.renderBreadcrumbs();
            this.updateStorageUsage();
        } catch (err) {
            console.error('loadFiles: Failed -', err);

            if (this.isOffline()) {
                UI.showErrorState('You are offline. Files will load when reconnected.');
            } else {
                UI.showErrorState('Failed to load files', () => this.loadFiles());
            }
        }
    },

    renderBreadcrumbs() {
        const breadcrumbContainer = document.getElementById('breadcrumb');
        if (!breadcrumbContainer) return;

        breadcrumbContainer.innerHTML = '';

        // Root folder link
        const rootLink = document.createElement('span');
        rootLink.className = 'breadcrumb-item';
        rootLink.textContent = 'My Drive';
        rootLink.addEventListener('click', () => this.navigateToFolder('', 'My Drive'));
        breadcrumbContainer.appendChild(rootLink);

        // Add path items
        for (let i = 0; i < this.folderPath.length; i++) {
            const separator = document.createElement('span');
            separator.className = 'breadcrumb-separator';
            separator.textContent = ' / ';
            breadcrumbContainer.appendChild(separator);

            const pathItem = this.folderPath[i];
            const link = document.createElement('span');
            link.className = 'breadcrumb-item';
            link.textContent = pathItem.name;
            link.addEventListener('click', () => {
                // Navigate to this folder and truncate path
                this.folderPath = this.folderPath.slice(0, i + 1);
                this.currentFolderId = pathItem.id;
                this.loadFiles();
            });
            breadcrumbContainer.appendChild(link);
        }
    },

    // Calculate the full path from root to a folder using folder tree data
    getPathToFolder(folderId) {
        if (!folderId) return [];

        const path = [];
        let currentId = folderId;

        // Build a map for quick parent lookup
        const folderMap = new Map();
        this.folderTreeData.forEach(f => folderMap.set(f.id, f));

        // Walk up the tree from target to root
        while (currentId) {
            const folder = folderMap.get(currentId);
            if (!folder) break;
            path.unshift({ id: folder.id, name: folder.name });
            currentId = folder.parent_id;
        }

        return path;
    },

    async navigateToFolder(folderId, folderName) {
        if (folderId === '') {
            // Going to root
            this.currentFolderId = '';
            this.folderPath = [];
        } else {
            // Add to path (for relative navigation from file list)
            this.folderPath.push({ id: folderId, name: folderName });
            this.currentFolderId = folderId;
        }
        await this.loadFiles();
    },

    // Navigate to a folder with absolute path (for sidebar navigation)
    async navigateToFolderAbsolute(folderId) {
        if (folderId === '') {
            this.currentFolderId = '';
            this.folderPath = [];
        } else {
            this.folderPath = this.getPathToFolder(folderId);
            this.currentFolderId = folderId;
        }
        await this.loadFiles();
    },

    async openFolder(folderId, folderName) {
        // Close mobile sidebar if open
        this.closeMobileSidebar();
        await this.navigateToFolder(folderId, folderName);
    },

    async uploadToFolder(files, folderId) {
        Upload.clear();
        Upload.addFiles(files);
        Upload.targetFolderId = folderId;

        // Start upload directly for drag-drop
        await this.startUpload();
    },

    async startUpload() {
        const startBtn = document.getElementById('upload-start');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = 'Uploading...';
        }

        await Upload.uploadAll(
            // On progress
            (item) => {
                UI.renderUploadList(Upload.files);
            },
            // On complete
            async (items) => {
                const successful = items.filter(i => i.status === 'success').length;
                const failed = items.filter(i => i.status === 'error').length;

                if (successful > 0) {
                    UI.toast(`Uploaded ${successful} file${successful > 1 ? 's' : ''}`, 'success');
                    // Log activity for each successful upload
                    items.filter(i => i.status === 'success').forEach(item => {
                        this.logActivity('upload', { name: item.file?.name || 'Unknown file' });
                    });
                }
                if (failed > 0) {
                    UI.toast(`${failed} file${failed > 1 ? 's' : ''} failed`, 'error');
                }

                // Small delay to allow relay to index the new events before refresh
                // This avoids race condition between publish and query
                await new Promise(resolve => setTimeout(resolve, 500));

                // Reload file list
                await this.loadFiles();

                // Reset button
                if (startBtn) {
                    startBtn.textContent = 'Upload';
                    UI.updateUploadButton();
                }

                // Close modal after short delay if all successful
                if (failed === 0) {
                    setTimeout(() => {
                        UI.hideModal('upload-modal');
                        Upload.clear();
                    }, 1000);
                }
            }
        );
    },

    promptNewFolder() {
        // Show the new folder modal
        const input = document.getElementById('new-folder-name');
        input.value = '';
        UI.showModal('new-folder-modal');
        setTimeout(() => input.focus(), 100);
    },

    async createFolder(name) {
        if (!name || !name.trim()) {
            UI.toast('Please enter a folder name', 'error');
            return;
        }

        try {
            // Generate a unique folder ID
            const folderId = Auth.generateFolderId();

            // Generate and store folder key
            console.log('App: Generating folder key for', folderId.slice(0, 8) + '...');
            const folderKey = await Keys.generateFolderKey(folderId);

            // Encrypt the folder key with our own pubkey for storage
            const folderKeyHex = Crypto.bytesToHex(folderKey);
            const encryptedFolderKey = await Auth.nip04Encrypt(Auth.pubkey, folderKeyHex);

            // Create and sign the encrypted folder event
            const signedEvent = await Auth.createEncryptedFolderEvent({
                id: folderId,
                name: name.trim(),
                parentId: this.currentFolderId || null,
                encryptedFolderKey: encryptedFolderKey,
            });

            // Publish directly to relay (client-side)
            await Auth.publishEvent(signedEvent);

            UI.hideModal('new-folder-modal');
            UI.toast(`Created encrypted folder "${name.trim()}"`, 'success');
            this.logActivity('folder', { name: name.trim() });

            // Reload to show new folder
            await this.loadFiles();
            await this.loadFolderTree();
        } catch (err) {
            console.error('Failed to create folder:', err);
            UI.toast(`Failed to create folder: ${err.message}`, 'error');
        }
    },

    async deleteFolder(folderId, folderName) {
        if (!confirm(`Delete folder "${folderName}"? Files inside will not be deleted but will move to root.`)) {
            return;
        }

        try {
            // Create and sign the deletion event
            const signedEvent = await Auth.createFolderDeleteEvent(folderId);

            // Publish directly to relay (client-side)
            await Auth.publishEvent(signedEvent);

            UI.toast(`Deleted folder "${folderName}"`, 'success');

            // Reload to update view
            await this.loadFiles();
            await this.loadFolderTree();
        } catch (err) {
            console.error('Failed to delete folder:', err);
            UI.toast(`Failed to delete folder: ${err.message}`, 'error');
        }
    },

    // Rename tracking state
    renameTarget: null,  // { type: 'file'|'folder', file?, folderId?, folderName? }

    renameFile(fileObj) {
        this.renameTarget = { type: 'file', file: fileObj };
        const input = document.getElementById('rename-input');
        const title = document.getElementById('rename-modal-title');
        const desc = document.getElementById('rename-modal-description');

        title.textContent = 'Rename File';
        desc.textContent = `Rename "${fileObj.name}":`;
        input.value = fileObj.name;
        input.placeholder = 'New filename';

        UI.showModal('rename-modal');
        setTimeout(() => {
            input.focus();
            // Select filename without extension
            const lastDot = fileObj.name.lastIndexOf('.');
            if (lastDot > 0) {
                input.setSelectionRange(0, lastDot);
            } else {
                input.select();
            }
        }, 100);
    },

    renameFolder(folderId, folderName) {
        this.renameTarget = { type: 'folder', folderId, folderName };
        const input = document.getElementById('rename-input');
        const title = document.getElementById('rename-modal-title');
        const desc = document.getElementById('rename-modal-description');

        title.textContent = 'Rename Folder';
        desc.textContent = `Rename "${folderName}":`;
        input.value = folderName;
        input.placeholder = 'New folder name';

        UI.showModal('rename-modal');
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);
    },

    validateName(name) {
        if (!name || !name.trim()) {
            return { valid: false, error: 'Name cannot be empty' };
        }
        const trimmed = name.trim();
        if (trimmed.length > 255) {
            return { valid: false, error: 'Name is too long (max 255 characters)' };
        }
        // Disallow path separators and other dangerous characters
        if (/[<>:"|?*\\\/\x00-\x1f]/.test(trimmed)) {
            return { valid: false, error: 'Name contains invalid characters' };
        }
        // Disallow names that are only dots
        if (/^\.+$/.test(trimmed)) {
            return { valid: false, error: 'Invalid name' };
        }
        return { valid: true };
    },

    async doRename() {
        const newName = document.getElementById('rename-input').value.trim();

        const validation = this.validateName(newName);
        if (!validation.valid) {
            UI.toast(validation.error, 'error');
            return;
        }

        if (!this.renameTarget) {
            UI.toast('No item selected for rename', 'error');
            return;
        }

        try {
            if (this.renameTarget.type === 'file') {
                await this.performFileRename(this.renameTarget.file, newName);
            } else if (this.renameTarget.type === 'folder') {
                await this.performFolderRename(this.renameTarget.folderId, this.renameTarget.folderName, newName);
            }
        } finally {
            this.renameTarget = null;
        }
    },

    async performFileRename(file, newName) {
        if (newName === file.name) {
            UI.hideModal('rename-modal');
            return;  // No change
        }

        try {
            const fileId = file.id || file.file_id || file.fileId || file.d || file.sha256;

            // Create updated metadata event with new name
            const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
                fileId: fileId,
                sha256: file.sha256,
                plaintextHash: file.plaintext_hash || file.plaintextHash,
                name: newName,  // New name
                size: file.size,
                encryptedSize: file.encrypted_size || file.encryptedSize,
                mimeType: file.mime_type,
                folderId: file.folder_id || file.folderId || file.folder,
                encrypted: file.encrypted,
                deletedAt: file.deleted_at || file.deletedAt,
            });

            await Auth.publishEvent(metadataEvent);

            UI.hideModal('rename-modal');
            UI.toast(`Renamed to "${newName}"`, 'success');
            this.logActivity('rename', { oldName: file.name, newName });

            await this.loadFiles();
        } catch (err) {
            console.error('Failed to rename file:', err);
            UI.toast(`Failed to rename: ${err.message}`, 'error');
        }
    },

    async performFolderRename(folderId, oldName, newName) {
        if (newName === oldName) {
            UI.hideModal('rename-modal');
            return;  // No change
        }

        try {
            // Find the folder to get all its metadata
            const folder = this.folders.find(f => f.id === folderId);
            if (!folder) {
                throw new Error('Folder not found');
            }

            // Create updated folder event with new name
            const folderEvent = await Auth.createFolderEvent({
                id: folderId,
                name: newName,  // New name
                description: folder.description || '',
                parentId: folder.parent_id || folder.parentId,
                color: folder.color,
                icon: folder.icon,
                encryptedFolderKey: folder.encrypted_key || folder.encryptedFolderKey,
            });

            await Auth.publishEvent(folderEvent);

            UI.hideModal('rename-modal');
            UI.toast(`Renamed folder to "${newName}"`, 'success');
            this.logActivity('folder_rename', { oldName, newName });

            await this.loadFiles();
            await this.loadFolderTree();
        } catch (err) {
            console.error('Failed to rename folder:', err);
            UI.toast(`Failed to rename folder: ${err.message}`, 'error');
        }
    },

    // Restore folder keys from server response
    // Called after loading folders to ensure keys are available for decryption
    async restoreFolderKeys(folders) {
        if (!Auth.isConnected || !folders || folders.length === 0) return;

        let restored = 0;
        let errors = 0;

        for (const folder of folders) {
            // Skip folders without encrypted keys
            if (!folder.encrypted_key) continue;

            // Check if we already have this folder key
            const hasCachedKey = await Keys.hasFolderKey(folder.id);
            if (hasCachedKey) continue;

            try {
                // Decrypt and restore the folder key
                // The key was encrypted with our own pubkey (self-encryption)
                await Keys.importSharedFolderKey(folder.id, folder.encrypted_key, Auth.pubkey);
                restored++;
            } catch (err) {
                console.error('Failed to restore folder key for', folder.id, ':', err.message);
                errors++;
            }
        }

        if (restored > 0 || errors > 0) {
            console.log(`restoreFolderKeys: Restored ${restored} keys, ${errors} errors`);
        }
    },

    // Folder tree state
    folderTreeData: [],
    expandedFolders: new Set(),

    // Load folder tree
    async loadFolderTree() {
        if (!Auth.isConnected) return;

        try {
            const result = await API.listFolders(Auth.pubkey);
            this.folderTreeData = result.folders || [];

            // Restore folder keys from encrypted_key field
            await this.restoreFolderKeys(this.folderTreeData);

            this.renderFolderTree();
        } catch (err) {
            console.error('Failed to load folder tree:', err);
        }
    },

    // Render folder tree
    renderFolderTree() {
        const container = document.getElementById('folder-tree-root');
        if (!container) return;

        // Build tree structure
        const tree = this.buildFolderTree(this.folderTreeData);
        container.innerHTML = this.renderFolderTreeItems(tree, '');
        this.attachFolderTreeEvents();
    },

    // Build hierarchical tree from flat folder list
    buildFolderTree(folders) {
        const map = new Map();
        const roots = [];

        // First pass: create map
        folders.forEach(folder => {
            map.set(folder.id, { ...folder, children: [] });
        });

        // Second pass: build hierarchy
        folders.forEach(folder => {
            const node = map.get(folder.id);
            if (folder.parent_id && map.has(folder.parent_id)) {
                map.get(folder.parent_id).children.push(node);
            } else {
                roots.push(node);
            }
        });

        return roots;
    },

    // Render folder tree items recursively
    renderFolderTreeItems(folders, parentId) {
        if (!folders || folders.length === 0) {
            return '';
        }

        return folders.map(folder => {
            const hasChildren = folder.children && folder.children.length > 0;
            const isExpanded = this.expandedFolders.has(folder.id);
            const isActive = this.currentFolderId === folder.id;

            let html = `
                <div class="folder-tree-item ${isActive ? 'active' : ''}" data-id="${folder.id}" data-name="${UI.escapeHtml(folder.name)}">
                    ${hasChildren ? `<span class="folder-tree-toggle ${isExpanded ? 'expanded' : ''}">&#9654;</span>` : '<span class="folder-tree-toggle"></span>'}
                    <span class="folder-tree-icon">&#128193;</span>
                    <span class="folder-tree-name">${UI.escapeHtml(folder.name)}</span>
                </div>
            `;

            if (hasChildren) {
                html += `<div class="folder-tree-children ${isExpanded ? '' : 'collapsed'}">${this.renderFolderTreeItems(folder.children, folder.id)}</div>`;
            }

            return html;
        }).join('');
    },

    // Attach event listeners to folder tree items
    attachFolderTreeEvents() {
        const tree = document.getElementById('folder-tree');
        if (!tree) return;

        // Root folder click
        const rootItem = tree.querySelector('.folder-tree-item.root');
        if (rootItem) {
            rootItem.addEventListener('click', () => {
                this.closeMobileSidebar();
                this.navigateToFolderAbsolute('');
                this.updateFolderTreeActive('');
            });
        }

        // Folder items
        tree.querySelectorAll('.folder-tree-item:not(.root)').forEach(item => {
            const folderId = item.dataset.id;
            const folderName = item.dataset.name;

            // Toggle expand/collapse on toggle click
            const toggle = item.querySelector('.folder-tree-toggle');
            if (toggle && toggle.textContent.trim()) {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFolderExpand(folderId);
                });
            }

            // Navigate on item click (use absolute navigation for sidebar)
            item.addEventListener('click', () => {
                this.closeMobileSidebar();
                this.navigateToFolderAbsolute(folderId);
                this.updateFolderTreeActive(folderId);
            });

            // Context menu on right-click
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                UI.showContextMenu(e.clientX, e.clientY, [
                    { label: 'Open', action: () => this.navigateToFolderAbsolute(folderId) },
                    { label: 'Rename', action: () => this.renameFolder(folderId, folderName) },
                    { label: 'Delete', action: () => this.deleteFolder(folderId, folderName), className: 'danger' },
                ]);
            });
        });

        // Sidebar toggle
        const toggleBtn = document.getElementById('sidebar-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.toggleSidebar();
            });
        }
    },

    // Toggle folder expand/collapse
    toggleFolderExpand(folderId) {
        if (this.expandedFolders.has(folderId)) {
            this.expandedFolders.delete(folderId);
        } else {
            this.expandedFolders.add(folderId);
        }
        this.renderFolderTree();
    },

    // Update active state in folder tree
    updateFolderTreeActive(folderId) {
        document.querySelectorAll('.folder-tree-item').forEach(item => {
            item.classList.toggle('active', item.dataset.id === folderId);
        });
        // Update root active state
        const root = document.querySelector('.folder-tree-item.root');
        if (root) {
            root.classList.toggle('active', folderId === '');
        }
    },

    // Toggle sidebar visibility
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) {
            sidebar.classList.toggle('collapsed');
        }
    },

    // Toggle mobile sidebar
    toggleMobileSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar) {
            sidebar.classList.toggle('mobile-open');
            if (overlay) {
                overlay.classList.toggle('visible', sidebar.classList.contains('mobile-open'));
            }
        }
    },

    // Close mobile sidebar
    closeMobileSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar) {
            sidebar.classList.remove('mobile-open');
            if (overlay) {
                overlay.classList.remove('visible');
            }
        }
    },

    // Setup mobile menu
    setupMobileMenu() {
        const mobileMenuBtn = document.getElementById('mobile-menu-btn');
        const overlay = document.getElementById('sidebar-overlay');

        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => {
                this.toggleMobileSidebar();
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                this.closeMobileSidebar();
            });
        }

        // Close sidebar when navigating on mobile
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                this.closeMobileSidebar();
            }
        });
    },

    // === Trash / Recycle Bin ===

    async loadTrashFiles() {
        UI.showLoadingSkeleton();

        try {
            // Load all files and filter for trashed ones
            const pubkey = Auth.pubkey;
            const response = await API.listFilesInFolder(pubkey, '');
            const allFiles = response.files || [];

            // Filter for files with deleted_at metadata
            this.trashedFiles = allFiles.filter(f => f.deleted_at || f.deletedAt);

            // Sort by deletion date (newest first)
            this.trashedFiles.sort((a, b) => {
                const dateA = a.deleted_at || a.deletedAt || 0;
                const dateB = b.deleted_at || b.deletedAt || 0;
                return dateB - dateA;
            });

            this.renderTrashView();
            this.updateTrashCount();
        } catch (err) {
            console.error('Failed to load trash:', err);
            UI.showErrorState('Failed to load trash', () => this.loadTrashFiles());
        }
    },

    renderTrashView() {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        // Update toolbar for trash view
        document.getElementById('upload-btn').style.display = 'none';
        document.getElementById('new-folder-btn').style.display = 'none';

        // Clear trash selection
        this.selectedTrashFiles = this.selectedTrashFiles || new Set();
        this.selectedTrashFiles.clear();

        if (this.trashedFiles.length === 0) {
            body.innerHTML = '';
            if (emptyState) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = `
                    <div class="empty-icon">&#128465;</div>
                    <div class="empty-text">Trash is empty</div>
                    <div class="empty-subtext">Deleted files will appear here for ${this.TRASH_RETENTION_DAYS} days</div>
                `;
            }
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        // Add trash header with Empty Trash button
        const headerHtml = `
            <div class="trash-header">
                <div class="trash-actions">
                    <button class="btn btn-small btn-danger" id="empty-trash-btn">Empty Trash</button>
                    <span class="trash-info">${this.trashedFiles.length} item${this.trashedFiles.length > 1 ? 's' : ''} in trash</span>
                </div>
            </div>
        `;

        const itemsHtml = this.trashedFiles.map(file => this.renderTrashItem(file)).join('');
        body.innerHTML = headerHtml + itemsHtml;

        // Add event listeners
        this.attachTrashEventListeners(body);
    },

    renderTrashItem(file) {
        const mimeType = file.mime_type || '';
        const icon = Upload.getFileIcon(mimeType);
        const size = Upload.formatSize(file.size);
        const deletedAt = file.deleted_at || file.deletedAt;
        const deletedDate = deletedAt ? new Date(deletedAt * 1000).toLocaleDateString() : '-';
        const daysLeft = deletedAt ? Math.max(0, this.TRASH_RETENTION_DAYS - Math.floor((Date.now() / 1000 - deletedAt) / 86400)) : '?';

        return `
            <div class="file-item trash-item" data-sha256="${file.sha256}" data-name="${UI.escapeHtml(file.name)}">
                <div class="file-col file-select">
                    <input type="checkbox" class="trash-checkbox" data-sha256="${file.sha256}" title="Select for bulk action">
                </div>
                <div class="file-col file-name">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name-text">${UI.escapeHtml(file.name)}</span>
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date" title="Deleted on ${deletedDate}">${daysLeft} days left</div>
                <div class="file-col file-actions">
                    <button class="action-btn restore-btn" title="Restore">Restore</button>
                    <button class="action-btn delete-btn delete-permanent" title="Delete permanently">Delete</button>
                </div>
            </div>
        `;
    },

    attachTrashEventListeners(container) {
        // Empty Trash button
        container.querySelector('#empty-trash-btn')?.addEventListener('click', () => {
            if (confirm(`Permanently delete all ${this.trashedFiles.length} items in trash? This cannot be undone.`)) {
                this.emptyTrash();
            }
        });

        // Individual item listeners
        container.querySelectorAll('.trash-item').forEach(item => {
            const sha256 = item.dataset.sha256;
            const fileName = item.dataset.name;

            // Checkbox
            item.querySelector('.trash-checkbox')?.addEventListener('change', (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    this.selectedTrashFiles.add(sha256);
                } else {
                    this.selectedTrashFiles.delete(sha256);
                }
                this.updateTrashSelectionUI();
            });

            item.querySelector('.restore-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.restoreFromTrash(sha256, fileName);
            });

            item.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Permanently delete "${fileName}"? This cannot be undone.`)) {
                    this.permanentDelete(sha256);
                }
            });
        });
    },

    updateTrashSelectionUI() {
        this.selectedTrashFiles = this.selectedTrashFiles || new Set();
        const count = this.selectedTrashFiles.size;
        const emptyTrashBtn = document.getElementById('empty-trash-btn');
        if (emptyTrashBtn) {
            if (count > 0) {
                emptyTrashBtn.textContent = `Delete ${count} Selected`;
            } else {
                emptyTrashBtn.textContent = 'Empty Trash';
            }
        }

        // Update checkbox visual states
        document.querySelectorAll('.trash-checkbox').forEach(cb => {
            const sha256 = cb.dataset.sha256;
            cb.checked = this.selectedTrashFiles.has(sha256);
        });
    },

    async emptyTrash() {
        if (this.trashedFiles.length === 0) return;

        // If specific items are selected, only delete those
        this.selectedTrashFiles = this.selectedTrashFiles || new Set();
        const toDelete = this.selectedTrashFiles.size > 0
            ? this.trashedFiles.filter(f => this.selectedTrashFiles.has(f.sha256))
            : this.trashedFiles;

        UI.toast(`Permanently deleting ${toDelete.length} items...`, 'info');

        try {
            await this.batchPermanentDelete(toDelete);
            UI.toast(`Permanently deleted ${toDelete.length} items`, 'success');
            this.selectedTrashFiles.clear();
            await this.loadTrashFiles();
        } catch (err) {
            console.error('Failed to empty trash:', err);
            UI.toast('Failed to delete some items', 'error');
        }
    },

    async moveToTrash(sha256, fileName) {
        try {
            // Find the file
            const file = this.files.find(f => f.sha256 === sha256);
            if (!file) throw new Error('File not found');

            // Get file ID - try various field names, fall back to sha256 for legacy files
            const fileId = file.id || file.file_id || file.fileId || file.d || file.sha256;
            console.log('moveToTrash: fileId =', fileId, '(from:', file.id ? 'id' : file.file_id ? 'file_id' : file.sha256 ? 'sha256' : 'unknown', ')');

            if (!fileId) {
                throw new Error(`Cannot delete: file has no ID (sha256: ${sha256})`);
            }

            // Update metadata with deleted_at timestamp
            const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
                fileId: fileId,
                sha256: file.sha256,
                plaintextHash: file.plaintext_hash || file.plaintextHash,
                name: file.name,
                size: file.size,
                encryptedSize: file.encrypted_size || file.encryptedSize,
                mimeType: file.mime_type,
                folderId: file.folder_id || file.folderId || file.folder,
                encrypted: file.encrypted,
                deletedAt: Math.floor(Date.now() / 1000),
            });

            await Auth.publishEvent(metadataEvent);

            UI.toast(`"${fileName}" moved to trash`, 'success');
            this.logActivity('delete', { name: fileName });
            await this.loadFiles();
            this.updateTrashCount();
        } catch (err) {
            UI.toast(`Failed to move to trash: ${err.message}`, 'error');
        }
    },

    async restoreFromTrash(sha256, fileName) {
        try {
            const file = this.trashedFiles.find(f => f.sha256 === sha256);
            if (!file) throw new Error('File not found');

            // Update metadata without deleted_at
            const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
                fileId: file.id || file.file_id || file.fileId || file.d || file.sha256,
                sha256: file.sha256,
                plaintextHash: file.plaintext_hash || file.plaintextHash,
                name: file.name,
                size: file.size,
                encryptedSize: file.encrypted_size || file.encryptedSize,
                mimeType: file.mime_type,
                folderId: file.folder_id || file.folderId || file.folder,
                encrypted: file.encrypted,
                // No deletedAt = not in trash
            });

            await Auth.publishEvent(metadataEvent);

            UI.toast(`"${fileName}" restored`, 'success');
            await this.loadTrashFiles();
        } catch (err) {
            UI.toast(`Restore failed: ${err.message}`, 'error');
        }
    },

    async permanentDelete(sha256) {
        try {
            // Find the file to get its ID for metadata deletion
            const file = this.trashedFiles.find(f => f.sha256 === sha256);
            const fileId = file?.id || file?.file_id || file?.fileId || file?.d;

            // Delete blob from Blossom
            let authHeader = null;
            if (Auth.isConnected) {
                authHeader = await Auth.createDeleteAuth(sha256);
            }
            await API.deleteFile(sha256, authHeader);

            // Also delete metadata from relay via kind:5
            if (fileId && Auth.isConnected) {
                try {
                    const deleteEvent = await Auth.createBatchDeleteEvent([fileId], []);
                    await Auth.publishEvent(deleteEvent);
                } catch (err) {
                    console.warn('Failed to delete metadata from relay:', err.message);
                    // Don't fail the whole operation - blob is already deleted
                }
            }

            UI.toast('File permanently deleted', 'success');
            await this.loadTrashFiles();
        } catch (err) {
            UI.toast(`Delete failed: ${err.message}`, 'error');
        }
    },

    // Batch permanent delete for emptying trash
    async batchPermanentDelete(files) {
        if (!files || files.length === 0) return { deleted: 0, failed: 0 };

        let deleted = 0;
        let failed = 0;
        const fileIds = [];

        // Delete blobs from Blossom (must be done individually due to auth)
        for (const file of files) {
            try {
                let authHeader = null;
                if (Auth.isConnected) {
                    authHeader = await Auth.createDeleteAuth(file.sha256);
                }
                await API.deleteFile(file.sha256, authHeader);
                deleted++;

                // Collect file IDs for batch metadata deletion
                const fileId = file.id || file.file_id || file.fileId || file.d;
                if (fileId) {
                    fileIds.push(fileId);
                }
            } catch (err) {
                console.error(`Failed to delete blob ${file.sha256}:`, err);
                failed++;
            }
        }

        // Batch delete all metadata from relay with single kind:5 event
        if (fileIds.length > 0 && Auth.isConnected) {
            try {
                const deleteEvent = await Auth.createBatchDeleteEvent(fileIds, []);
                await Auth.publishEvent(deleteEvent);
                console.log(`Batch deleted ${fileIds.length} file metadata events`);
            } catch (err) {
                console.warn('Failed to batch delete metadata from relay:', err.message);
            }
        }

        return { deleted, failed };
    },

    updateTrashCount() {
        const badge = document.getElementById('trash-count');
        if (badge) {
            badge.textContent = this.trashedFiles.length > 0 ? this.trashedFiles.length : '';
        }
    },

    async deleteFile(sha256) {
        // Soft delete - move to trash
        const file = this.files.find(f => f.sha256 === sha256);
        const fileName = file?.name || 'file';
        await this.moveToTrash(sha256, fileName);
    },

    // Download and decrypt a file
    async downloadFile(file) {
        try {
            // Track as recent file
            this.recordFileAccess(file.sha256);

            UI.toast(`Downloading ${file.name}...`, 'info');

            // Fetch the encrypted blob from Blossom
            const downloadUrl = API.getDownloadURL(file.sha256);
            const response = await fetch(downloadUrl);

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const encryptedData = await response.arrayBuffer();
            console.log(`Download: Fetched ${encryptedData.byteLength} bytes`);

            // Check if file is encrypted
            const isEncrypted = file.encrypted || file.encryption;
            let decryptedData;

            if (isEncrypted) {
                UI.toast(`Decrypting ${file.name}...`, 'info');

                // Get the file key for decryption
                const fileId = file.id || file.file_id || file.fileId || file.d;  // Get file ID from metadata
                const folderId = file.folder_id || file.folderId || file.folder || null;

                if (!fileId) {
                    throw new Error('Cannot decrypt: missing file ID');
                }

                let fileKey;
                if (folderId) {
                    fileKey = await Keys.deriveFileKey(folderId, fileId);
                } else {
                    fileKey = await Keys.deriveRootFileKey(fileId);
                }

                // Decrypt the file
                decryptedData = await Crypto.decryptFile(encryptedData, fileKey);

                // Wipe key from memory
                Crypto.wipeKey(fileKey);

                console.log(`Download: Decrypted to ${decryptedData.byteLength} bytes`);
            } else {
                // Not encrypted, use as-is
                decryptedData = new Uint8Array(encryptedData);
            }

            // Create blob and trigger download
            const mimeType = file.mime_type || file.mimeType || 'application/octet-stream';
            const blob = new Blob([decryptedData], { type: mimeType });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(url);

            UI.toast(`Downloaded ${file.name}`, 'success');
            this.logActivity('download', { name: file.name });

        } catch (err) {
            console.error('Download failed:', err);
            UI.toast(`Download failed: ${err.message}`, 'error');
        }
    },

    // Download a shared file using the key from the share
    async downloadSharedFile(file) {
        try {
            UI.toast(`Downloading shared file ${file.name}...`, 'info');

            const downloadUrl = file.url || API.getDownloadURL(file.sha256);
            const response = await fetch(downloadUrl);

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const encryptedData = await response.arrayBuffer();
            let decryptedData;

            // Check if file is encrypted and we have the key
            if (file.encrypted && file.fileKey) {
                UI.toast(`Decrypting ${file.name}...`, 'info');

                // Convert hex key to bytes
                const fileKey = Crypto.hexToBytes(file.fileKey);

                // Decrypt the file
                decryptedData = await Crypto.decryptFile(encryptedData, fileKey);

                // Wipe key from memory
                Crypto.wipeKey(fileKey);

                console.log(`Shared download: Decrypted to ${decryptedData.byteLength} bytes`);
            } else {
                // Not encrypted or no key provided
                decryptedData = new Uint8Array(encryptedData);
            }

            // Create blob and trigger download
            const mimeType = file.mime_type || 'application/octet-stream';
            const blob = new Blob([decryptedData], { type: mimeType });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(url);
            UI.toast(`Downloaded ${file.name}`, 'success');

        } catch (err) {
            console.error('Download shared file failed:', err);
            UI.toast(`Download failed: ${err.message}`, 'error');
        }
    },

    // Check if file type is previewable
    isPreviewable(mimeType) {
        if (!mimeType) return false;
        return (
            mimeType.startsWith('image/') ||
            mimeType.startsWith('video/') ||
            mimeType.startsWith('audio/') ||
            mimeType.startsWith('text/') ||
            mimeType === 'application/pdf' ||
            mimeType === 'application/json' ||
            mimeType === 'application/javascript' ||
            mimeType === 'application/xml'
        );
    },

    // Get preview type category
    getPreviewType(mimeType, filename = '') {
        if (!mimeType) return 'unsupported';

        // Check for markdown by extension or mime type
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'md' || ext === 'markdown' || mimeType === 'text/markdown') {
            return 'markdown';
        }

        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType === 'application/pdf') return 'pdf';
        if (mimeType.startsWith('text/') ||
            mimeType === 'application/json' ||
            mimeType === 'application/javascript' ||
            mimeType === 'application/xml') return 'text';
        return 'unsupported';
    },

    // Preview file state
    previewFile: null,
    previewBlobUrl: null,
    fileInfoFile: null,

    // Show file info modal
    showFileInfo(file) {
        this.fileInfoFile = file;

        // Populate modal
        document.getElementById('file-info-name').textContent = file.name;
        document.getElementById('file-info-size').textContent = Upload.formatSize(file.size);
        document.getElementById('file-info-type').textContent = file.mime_type || file.mimeType || 'Unknown';

        const date = file.created_at
            ? new Date(file.created_at * 1000).toLocaleString()
            : 'Unknown';
        document.getElementById('file-info-date').textContent = date;

        const isEncrypted = file.encrypted !== false;
        document.getElementById('file-info-encrypted').textContent = isEncrypted ? 'Yes (E2E)' : 'No';

        const hash = file.sha256 || '-';
        document.getElementById('file-info-hash').textContent = hash.slice(0, 16) + '...' + hash.slice(-8);
        document.getElementById('file-info-hash').title = hash;

        UI.showModal('file-info-modal');
    },

    // Preview a file
    async showPreview(file) {
        this.previewFile = file;

        // Track as recent file
        this.recordFileAccess(file.sha256);

        // Show modal and loading state
        document.getElementById('preview-file-name').textContent = file.name;
        document.getElementById('preview-loading').classList.remove('hidden');
        document.getElementById('preview-content').classList.add('hidden');

        // Hide all preview types
        document.getElementById('preview-image').classList.add('hidden');
        document.getElementById('preview-code-container').classList.add('hidden');
        document.getElementById('preview-markdown-container').classList.add('hidden');
        document.getElementById('preview-pdf-container').classList.add('hidden');
        document.getElementById('preview-video-container').classList.add('hidden');
        document.getElementById('preview-audio-container').classList.add('hidden');
        document.getElementById('preview-unsupported').classList.add('hidden');

        UI.showModal('preview-modal');

        try {
            // Fetch and decrypt the file
            const downloadUrl = API.getDownloadURL(file.sha256);
            const response = await fetch(downloadUrl);

            if (!response.ok) {
                throw new Error(`Failed to fetch file: ${response.status}`);
            }

            const encryptedData = await response.arrayBuffer();
            let decryptedData;

            const isEncrypted = file.encrypted || file.encryption;
            if (isEncrypted) {
                const fileId = file.id || file.file_id || file.fileId || file.d;
                const folderId = file.folder_id || file.folderId || file.folder || null;

                if (!fileId) {
                    throw new Error('Cannot decrypt: missing file ID');
                }

                let fileKey;
                if (folderId) {
                    fileKey = await Keys.deriveFileKey(folderId, fileId);
                } else {
                    fileKey = await Keys.deriveRootFileKey(fileId);
                }

                decryptedData = await Crypto.decryptFile(encryptedData, fileKey);
                Crypto.wipeKey(fileKey);
            } else {
                decryptedData = new Uint8Array(encryptedData);
            }

            // Create blob for preview
            const mimeType = file.mime_type || file.mimeType || 'application/octet-stream';
            const blob = new Blob([decryptedData], { type: mimeType });

            // Clean up previous blob URL
            if (this.previewBlobUrl) {
                URL.revokeObjectURL(this.previewBlobUrl);
            }
            this.previewBlobUrl = URL.createObjectURL(blob);

            // Show appropriate preview
            const previewType = this.getPreviewType(mimeType, file.name);
            document.getElementById('preview-loading').classList.add('hidden');
            document.getElementById('preview-content').classList.remove('hidden');

            switch (previewType) {
                case 'image':
                    const imgEl = document.getElementById('preview-image');
                    imgEl.src = this.previewBlobUrl;
                    imgEl.classList.remove('hidden');
                    break;

                case 'video':
                    const videoContainer = document.getElementById('preview-video-container');
                    const videoEl = document.getElementById('preview-video');
                    videoEl.src = this.previewBlobUrl;
                    videoContainer.classList.remove('hidden');
                    this.initMediaControls('video');
                    break;

                case 'audio':
                    const audioContainer = document.getElementById('preview-audio-container');
                    const audioEl = document.getElementById('preview-audio');
                    audioEl.src = this.previewBlobUrl;
                    audioContainer.classList.remove('hidden');
                    this.initMediaControls('audio');
                    break;

                case 'pdf':
                    const pdfContainer = document.getElementById('preview-pdf-container');
                    pdfContainer.classList.remove('hidden');
                    this.initPdfViewer(decryptedData);
                    break;

                case 'markdown':
                    const mdContainer = document.getElementById('preview-markdown-container');
                    const mdText = new TextDecoder().decode(decryptedData);
                    mdContainer.classList.remove('hidden');
                    this.initMarkdownViewer(mdText);
                    break;

                case 'text':
                    const codeContainer = document.getElementById('preview-code-container');
                    const codeEl = document.getElementById('preview-code');
                    const text = new TextDecoder().decode(decryptedData);
                    codeEl.textContent = text;
                    codeContainer.classList.remove('hidden');
                    this.initCodeViewer(file.name, text);
                    break;

                default:
                    document.getElementById('preview-unsupported').classList.remove('hidden');
            }

        } catch (err) {
            console.error('Preview failed:', err);
            document.getElementById('preview-loading').classList.add('hidden');
            document.getElementById('preview-content').classList.remove('hidden');
            document.getElementById('preview-unsupported').classList.remove('hidden');
            document.getElementById('preview-unsupported').innerHTML = `
                <p>Preview failed: ${err.message}</p>
                <button class="btn btn-primary" id="preview-download">Download Instead</button>
            `;
        }
    },

    // Close preview and cleanup
    closePreview() {
        UI.hideModal('preview-modal');

        // Stop any playing media
        const videoEl = document.getElementById('preview-video');
        const audioEl = document.getElementById('preview-audio');
        if (videoEl) videoEl.pause();
        if (audioEl) audioEl.pause();

        // Clean up blob URL
        if (this.previewBlobUrl) {
            URL.revokeObjectURL(this.previewBlobUrl);
            this.previewBlobUrl = null;
        }

        this.previewFile = null;
    },

    // Setup preview modal events
    setupPreviewModal() {
        document.getElementById('preview-modal-close').addEventListener('click', () => {
            this.closePreview();
        });

        document.getElementById('preview-close').addEventListener('click', () => {
            this.closePreview();
        });

        document.getElementById('preview-download-btn').addEventListener('click', () => {
            if (this.previewFile) {
                this.downloadFile(this.previewFile);
            }
        });

        // Handle download button in unsupported preview
        document.getElementById('preview-content').addEventListener('click', (e) => {
            if (e.target.id === 'preview-download' && this.previewFile) {
                this.downloadFile(this.previewFile);
                this.closePreview();
            }
        });
    },

    // Setup file info modal events
    setupFileInfoModal() {
        document.getElementById('file-info-modal-close').addEventListener('click', () => {
            UI.hideModal('file-info-modal');
        });

        document.getElementById('file-info-preview').addEventListener('click', () => {
            if (this.fileInfoFile) {
                UI.hideModal('file-info-modal');
                this.showPreview(this.fileInfoFile);
            }
        });

        document.getElementById('file-info-download').addEventListener('click', () => {
            if (this.fileInfoFile) {
                this.downloadFile(this.fileInfoFile);
            }
        });

        document.getElementById('file-info-share').addEventListener('click', () => {
            if (this.fileInfoFile) {
                UI.hideModal('file-info-modal');
                this.showShareModal(this.fileInfoFile);
            }
        });

        document.getElementById('file-info-delete').addEventListener('click', () => {
            if (this.fileInfoFile && confirm('Delete this file?')) {
                UI.hideModal('file-info-modal');
                this.deleteFile(this.fileInfoFile.sha256);
            }
        });

        document.getElementById('file-info-link').addEventListener('click', () => {
            if (this.fileInfoFile) {
                UI.hideModal('file-info-modal');
                this.showPublicLinkModal(this.fileInfoFile);
            }
        });

        document.getElementById('file-info-history').addEventListener('click', () => {
            if (this.fileInfoFile) {
                UI.hideModal('file-info-modal');
                this.showVersionHistory(this.fileInfoFile);
            }
        });
    },

    // Initialize media controls for video/audio player
    initMediaControls(type) {
        const prefix = type; // 'video' or 'audio'
        const mediaEl = document.getElementById(`preview-${type}`);
        const playBtn = document.getElementById(`${prefix}-play`);
        const seekBar = document.getElementById(`${prefix}-seek`);
        const timeDisplay = document.getElementById(`${prefix}-time`);
        const muteBtn = document.getElementById(`${prefix}-mute`);
        const volumeSlider = document.getElementById(`${prefix}-volume`);
        const speedSelect = document.getElementById(`${prefix}-speed`);
        const pipBtn = document.getElementById(`${prefix}-pip`);
        const fullscreenBtn = document.getElementById(`${prefix}-fullscreen`);

        // Format time helper
        const formatTime = (seconds) => {
            if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        };

        // Remove existing event listeners by cloning elements
        const cloneAndReplace = (el) => {
            if (!el) return null;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            return clone;
        };

        // Clone to remove old listeners
        const newPlayBtn = cloneAndReplace(playBtn);
        const newSeekBar = cloneAndReplace(seekBar);
        const newMuteBtn = cloneAndReplace(muteBtn);
        const newVolumeSlider = cloneAndReplace(volumeSlider);
        const newSpeedSelect = cloneAndReplace(speedSelect);
        const newPipBtn = pipBtn ? cloneAndReplace(pipBtn) : null;
        const newFullscreenBtn = fullscreenBtn ? cloneAndReplace(fullscreenBtn) : null;

        // Play/Pause toggle
        if (newPlayBtn) {
            newPlayBtn.addEventListener('click', () => {
                if (mediaEl.paused) {
                    mediaEl.play();
                } else {
                    mediaEl.pause();
                }
            });
        }

        // Update play button icon based on state
        mediaEl.addEventListener('play', () => {
            if (newPlayBtn) newPlayBtn.innerHTML = '&#10074;&#10074;'; // Pause icon
        });

        mediaEl.addEventListener('pause', () => {
            if (newPlayBtn) newPlayBtn.innerHTML = '&#9654;'; // Play icon
        });

        // Time update - update seek bar and time display
        mediaEl.addEventListener('timeupdate', () => {
            if (mediaEl.duration) {
                const percent = (mediaEl.currentTime / mediaEl.duration) * 100;
                if (newSeekBar) newSeekBar.value = percent;
                if (timeDisplay) {
                    timeDisplay.textContent = `${formatTime(mediaEl.currentTime)} / ${formatTime(mediaEl.duration)}`;
                }
            }
        });

        // When metadata loads, update duration
        mediaEl.addEventListener('loadedmetadata', () => {
            if (timeDisplay) {
                timeDisplay.textContent = `0:00 / ${formatTime(mediaEl.duration)}`;
            }
        });

        // Seek bar interaction
        if (newSeekBar) {
            newSeekBar.addEventListener('input', () => {
                if (mediaEl.duration) {
                    const time = (newSeekBar.value / 100) * mediaEl.duration;
                    mediaEl.currentTime = time;
                }
            });
        }

        // Mute toggle
        if (newMuteBtn) {
            newMuteBtn.addEventListener('click', () => {
                mediaEl.muted = !mediaEl.muted;
                newMuteBtn.innerHTML = mediaEl.muted ? '&#128263;' : '&#128266;'; // Muted vs unmuted icon
                if (newVolumeSlider) {
                    newVolumeSlider.value = mediaEl.muted ? 0 : mediaEl.volume * 100;
                }
            });
        }

        // Volume slider
        if (newVolumeSlider) {
            newVolumeSlider.addEventListener('input', () => {
                mediaEl.volume = newVolumeSlider.value / 100;
                mediaEl.muted = mediaEl.volume === 0;
                if (newMuteBtn) {
                    newMuteBtn.innerHTML = mediaEl.muted ? '&#128263;' : '&#128266;';
                }
            });
        }

        // Playback speed
        if (newSpeedSelect) {
            newSpeedSelect.value = '1'; // Reset to 1x
            newSpeedSelect.addEventListener('change', () => {
                mediaEl.playbackRate = parseFloat(newSpeedSelect.value);
            });
        }

        // Picture-in-Picture (video only)
        if (newPipBtn && type === 'video' && document.pictureInPictureEnabled) {
            newPipBtn.addEventListener('click', async () => {
                try {
                    if (document.pictureInPictureElement) {
                        await document.exitPictureInPicture();
                    } else {
                        await mediaEl.requestPictureInPicture();
                    }
                } catch (err) {
                    console.error('PiP error:', err);
                }
            });
        } else if (newPipBtn) {
            newPipBtn.style.display = 'none'; // Hide if not supported
        }

        // Fullscreen (video only)
        if (newFullscreenBtn && type === 'video') {
            newFullscreenBtn.addEventListener('click', () => {
                const container = document.getElementById('preview-video-container');
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else if (container.requestFullscreen) {
                    container.requestFullscreen();
                } else if (container.webkitRequestFullscreen) {
                    container.webkitRequestFullscreen();
                }
            });
        }

        // Handle ended event
        mediaEl.addEventListener('ended', () => {
            if (newPlayBtn) newPlayBtn.innerHTML = '&#9654;'; // Play icon
            if (newSeekBar) newSeekBar.value = 0;
        });

        // Keyboard shortcuts within media player
        const container = document.getElementById(`preview-${type}-container`);
        container.addEventListener('keydown', (e) => {
            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    if (mediaEl.paused) mediaEl.play();
                    else mediaEl.pause();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 5);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    mediaEl.currentTime = Math.min(mediaEl.duration, mediaEl.currentTime + 5);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    mediaEl.volume = Math.min(1, mediaEl.volume + 0.1);
                    if (newVolumeSlider) newVolumeSlider.value = mediaEl.volume * 100;
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    mediaEl.volume = Math.max(0, mediaEl.volume - 0.1);
                    if (newVolumeSlider) newVolumeSlider.value = mediaEl.volume * 100;
                    break;
                case 'm':
                    e.preventDefault();
                    mediaEl.muted = !mediaEl.muted;
                    if (newMuteBtn) newMuteBtn.innerHTML = mediaEl.muted ? '&#128263;' : '&#128266;';
                    break;
                case 'f':
                    if (type === 'video') {
                        e.preventDefault();
                        if (document.fullscreenElement) {
                            document.exitFullscreen();
                        } else {
                            container.requestFullscreen();
                        }
                    }
                    break;
            }
        });

        // Make container focusable for keyboard events
        container.setAttribute('tabindex', '0');
    },

    // PDF viewer state
    pdfDoc: null,
    pdfPage: 1,
    pdfScale: 1,
    pdfRotation: 0,
    pdfRendering: false,

    // Initialize PDF.js viewer
    async initPdfViewer(pdfData) {
        const loadingEl = document.getElementById('pdf-loading');
        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');

        // Show loading
        loadingEl.classList.remove('hidden');

        try {
            // Set PDF.js worker
            if (window.pdfjsLib) {
                pdfjsLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            } else {
                throw new Error('PDF.js library not loaded');
            }

            // Load PDF from data
            const loadingTask = pdfjsLib.getDocument({ data: pdfData });
            this.pdfDoc = await loadingTask.promise;

            // Update total pages
            document.getElementById('pdf-total-pages').textContent = this.pdfDoc.numPages;
            document.getElementById('pdf-page-input').max = this.pdfDoc.numPages;

            // Reset state
            this.pdfPage = 1;
            this.pdfScale = 1;
            this.pdfRotation = 0;
            document.getElementById('pdf-page-input').value = 1;
            document.getElementById('pdf-zoom-select').value = '1';

            // Hide loading and render first page
            loadingEl.classList.add('hidden');
            await this.renderPdfPage();

            // Setup PDF controls
            this.setupPdfControls();

        } catch (err) {
            console.error('PDF load error:', err);
            loadingEl.classList.add('hidden');
            document.getElementById('preview-pdf-container').classList.add('hidden');
            document.getElementById('preview-unsupported').classList.remove('hidden');
            document.getElementById('preview-unsupported').innerHTML = `
                <p>Failed to load PDF: ${err.message}</p>
                <button class="btn btn-primary" id="preview-download">Download Instead</button>
            `;
        }
    },

    // Render current PDF page
    async renderPdfPage() {
        if (!this.pdfDoc || this.pdfRendering) return;

        this.pdfRendering = true;
        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');

        try {
            const page = await this.pdfDoc.getPage(this.pdfPage);

            // Calculate scale for fit-width or fit-page
            let scale = this.pdfScale;
            const viewport = page.getViewport({ scale: 1, rotation: this.pdfRotation });
            const container = document.getElementById('pdf-viewport');

            if (scale === 'fit-width') {
                scale = (container.clientWidth - 40) / viewport.width;
            } else if (scale === 'fit-page') {
                const scaleX = (container.clientWidth - 40) / viewport.width;
                const scaleY = (container.clientHeight - 40) / viewport.height;
                scale = Math.min(scaleX, scaleY);
            }

            const scaledViewport = page.getViewport({ scale, rotation: this.pdfRotation });

            // Set canvas dimensions
            canvas.height = scaledViewport.height;
            canvas.width = scaledViewport.width;

            // Render page
            await page.render({
                canvasContext: ctx,
                viewport: scaledViewport
            }).promise;

            // Update page input
            document.getElementById('pdf-page-input').value = this.pdfPage;

        } catch (err) {
            console.error('PDF render error:', err);
        }

        this.pdfRendering = false;
    },

    // Setup PDF control event handlers
    setupPdfControls() {
        const prevBtn = document.getElementById('pdf-prev');
        const nextBtn = document.getElementById('pdf-next');
        const pageInput = document.getElementById('pdf-page-input');
        const zoomSelect = document.getElementById('pdf-zoom-select');
        const zoomInBtn = document.getElementById('pdf-zoom-in');
        const zoomOutBtn = document.getElementById('pdf-zoom-out');
        const rotateBtn = document.getElementById('pdf-rotate');
        const fullscreenBtn = document.getElementById('pdf-fullscreen');

        // Clone and replace to remove old listeners
        const cloneAndReplace = (el) => {
            if (!el) return null;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            return clone;
        };

        const newPrevBtn = cloneAndReplace(prevBtn);
        const newNextBtn = cloneAndReplace(nextBtn);
        const newPageInput = cloneAndReplace(pageInput);
        const newZoomSelect = cloneAndReplace(zoomSelect);
        const newZoomInBtn = cloneAndReplace(zoomInBtn);
        const newZoomOutBtn = cloneAndReplace(zoomOutBtn);
        const newRotateBtn = cloneAndReplace(rotateBtn);
        const newFullscreenBtn = cloneAndReplace(fullscreenBtn);

        // Previous page
        if (newPrevBtn) {
            newPrevBtn.addEventListener('click', () => {
                if (this.pdfPage > 1) {
                    this.pdfPage--;
                    this.renderPdfPage();
                }
            });
        }

        // Next page
        if (newNextBtn) {
            newNextBtn.addEventListener('click', () => {
                if (this.pdfPage < this.pdfDoc.numPages) {
                    this.pdfPage++;
                    this.renderPdfPage();
                }
            });
        }

        // Page input
        if (newPageInput) {
            newPageInput.addEventListener('change', () => {
                let page = parseInt(newPageInput.value);
                if (page >= 1 && page <= this.pdfDoc.numPages) {
                    this.pdfPage = page;
                    this.renderPdfPage();
                } else {
                    newPageInput.value = this.pdfPage;
                }
            });
        }

        // Zoom select
        if (newZoomSelect) {
            newZoomSelect.addEventListener('change', () => {
                const value = newZoomSelect.value;
                if (value === 'fit-width' || value === 'fit-page') {
                    this.pdfScale = value;
                } else {
                    this.pdfScale = parseFloat(value);
                }
                this.renderPdfPage();
            });
        }

        // Zoom in
        if (newZoomInBtn) {
            newZoomInBtn.addEventListener('click', () => {
                if (typeof this.pdfScale === 'number') {
                    this.pdfScale = Math.min(3, this.pdfScale + 0.25);
                    newZoomSelect.value = this.pdfScale.toString();
                    // If not a preset, add custom option
                    if (!newZoomSelect.value) {
                        newZoomSelect.value = '1';
                    }
                    this.renderPdfPage();
                }
            });
        }

        // Zoom out
        if (newZoomOutBtn) {
            newZoomOutBtn.addEventListener('click', () => {
                if (typeof this.pdfScale === 'number') {
                    this.pdfScale = Math.max(0.25, this.pdfScale - 0.25);
                    newZoomSelect.value = this.pdfScale.toString();
                    if (!newZoomSelect.value) {
                        newZoomSelect.value = '1';
                    }
                    this.renderPdfPage();
                }
            });
        }

        // Rotate
        if (newRotateBtn) {
            newRotateBtn.addEventListener('click', () => {
                this.pdfRotation = (this.pdfRotation + 90) % 360;
                this.renderPdfPage();
            });
        }

        // Fullscreen
        if (newFullscreenBtn) {
            newFullscreenBtn.addEventListener('click', () => {
                const container = document.getElementById('preview-pdf-container');
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else if (container.requestFullscreen) {
                    container.requestFullscreen();
                }
            });
        }

        // Keyboard shortcuts
        const container = document.getElementById('preview-pdf-container');
        container.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'ArrowLeft':
                case 'PageUp':
                    e.preventDefault();
                    if (this.pdfPage > 1) {
                        this.pdfPage--;
                        this.renderPdfPage();
                    }
                    break;
                case 'ArrowRight':
                case 'PageDown':
                case ' ':
                    e.preventDefault();
                    if (this.pdfPage < this.pdfDoc.numPages) {
                        this.pdfPage++;
                        this.renderPdfPage();
                    }
                    break;
                case 'Home':
                    e.preventDefault();
                    this.pdfPage = 1;
                    this.renderPdfPage();
                    break;
                case 'End':
                    e.preventDefault();
                    this.pdfPage = this.pdfDoc.numPages;
                    this.renderPdfPage();
                    break;
                case '+':
                case '=':
                    e.preventDefault();
                    if (typeof this.pdfScale === 'number') {
                        this.pdfScale = Math.min(3, this.pdfScale + 0.25);
                        this.renderPdfPage();
                    }
                    break;
                case '-':
                    e.preventDefault();
                    if (typeof this.pdfScale === 'number') {
                        this.pdfScale = Math.max(0.25, this.pdfScale - 0.25);
                        this.renderPdfPage();
                    }
                    break;
                case 'r':
                    e.preventDefault();
                    this.pdfRotation = (this.pdfRotation + 90) % 360;
                    this.renderPdfPage();
                    break;
                case 'f':
                    e.preventDefault();
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else {
                        container.requestFullscreen();
                    }
                    break;
            }
        });

        container.setAttribute('tabindex', '0');
    },

    // Get programming language from file extension
    getLanguageFromExtension(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const languageMap = {
            // JavaScript/TypeScript
            'js': 'javascript',
            'jsx': 'javascript',
            'ts': 'typescript',
            'tsx': 'typescript',
            'mjs': 'javascript',
            'cjs': 'javascript',
            // Web
            'html': 'html',
            'htm': 'html',
            'css': 'css',
            'scss': 'scss',
            'sass': 'scss',
            'less': 'less',
            'vue': 'html',
            'svelte': 'html',
            // Backend
            'py': 'python',
            'rb': 'ruby',
            'php': 'php',
            'go': 'go',
            'rs': 'rust',
            'java': 'java',
            'kt': 'kotlin',
            'scala': 'scala',
            'cs': 'csharp',
            'cpp': 'cpp',
            'c': 'c',
            'h': 'c',
            'hpp': 'cpp',
            'swift': 'swift',
            // Data/Config
            'json': 'json',
            'xml': 'xml',
            'yaml': 'yaml',
            'yml': 'yaml',
            'toml': 'ini',
            'ini': 'ini',
            'env': 'ini',
            'conf': 'ini',
            // Shell
            'sh': 'bash',
            'bash': 'bash',
            'zsh': 'bash',
            'fish': 'bash',
            'ps1': 'powershell',
            // Database
            'sql': 'sql',
            // Docs
            'md': 'markdown',
            'markdown': 'markdown',
            'rst': 'plaintext',
            'txt': 'plaintext',
            // Other
            'dockerfile': 'dockerfile',
            'makefile': 'makefile',
            'cmake': 'cmake',
            'r': 'r',
            'lua': 'lua',
            'perl': 'perl',
            'pl': 'perl',
            'ex': 'elixir',
            'exs': 'elixir',
            'erl': 'erlang',
            'hs': 'haskell',
            'clj': 'clojure',
            'lisp': 'lisp',
            'vim': 'vim',
            'diff': 'diff',
            'patch': 'diff',
        };
        return languageMap[ext] || 'plaintext';
    },

    // Initialize code viewer with syntax highlighting
    initCodeViewer(filename, content) {
        const codeEl = document.getElementById('preview-code');
        const langEl = document.getElementById('code-language');
        const lineNumbersEl = document.getElementById('line-numbers');
        const copyBtn = document.getElementById('code-copy');
        const wrapBtn = document.getElementById('code-wrap-toggle');
        const preEl = document.getElementById('preview-text');

        // Detect language
        const language = this.getLanguageFromExtension(filename);
        langEl.textContent = language;

        // Apply syntax highlighting
        codeEl.className = `language-${language}`;
        if (window.hljs) {
            try {
                const highlighted = hljs.highlight(content, { language, ignoreIllegals: true });
                codeEl.innerHTML = highlighted.value;
            } catch (e) {
                // Fallback to auto-detection
                try {
                    const auto = hljs.highlightAuto(content);
                    codeEl.innerHTML = auto.value;
                    langEl.textContent = auto.language || 'plaintext';
                } catch (e2) {
                    codeEl.textContent = content;
                }
            }
        }

        // Generate line numbers
        const lines = content.split('\n');
        lineNumbersEl.innerHTML = lines.map((_, i) => `<div>${i + 1}</div>`).join('');

        // Clone and replace buttons to remove old listeners
        const cloneAndReplace = (el) => {
            if (!el) return null;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            return clone;
        };

        const newCopyBtn = cloneAndReplace(copyBtn);
        const newWrapBtn = cloneAndReplace(wrapBtn);

        // Copy button
        if (newCopyBtn) {
            newCopyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(content);
                    newCopyBtn.textContent = 'Copied!';
                    newCopyBtn.classList.add('active');
                    setTimeout(() => {
                        newCopyBtn.textContent = 'Copy';
                        newCopyBtn.classList.remove('active');
                    }, 2000);
                } catch (err) {
                    console.error('Copy failed:', err);
                    newCopyBtn.textContent = 'Failed';
                    setTimeout(() => {
                        newCopyBtn.textContent = 'Copy';
                    }, 2000);
                }
            });
        }

        // Wrap toggle
        if (newWrapBtn) {
            // Reset wrap state
            preEl.classList.remove('wrap');
            newWrapBtn.classList.remove('active');

            newWrapBtn.addEventListener('click', () => {
                preEl.classList.toggle('wrap');
                newWrapBtn.classList.toggle('active');
            });
        }

        // Sync line number scroll with code scroll
        const codeBody = document.querySelector('.code-body');
        if (codeBody) {
            codeBody.addEventListener('scroll', () => {
                lineNumbersEl.style.marginTop = `-${codeBody.scrollTop}px`;
            });
        }
    },

    // Store raw markdown content for copying
    rawMarkdownContent: '',

    // Initialize markdown viewer with preview/source toggle
    initMarkdownViewer(content) {
        this.rawMarkdownContent = content;

        const previewEl = document.getElementById('markdown-preview');
        const sourceEl = document.getElementById('markdown-source');
        const rawEl = document.getElementById('markdown-raw');
        const previewTab = document.getElementById('md-preview-tab');
        const sourceTab = document.getElementById('md-source-tab');
        const copyBtn = document.getElementById('md-copy');

        // Configure marked options
        if (window.marked) {
            marked.setOptions({
                breaks: true,
                gfm: true,
                headerIds: true,
                highlight: function(code, lang) {
                    if (window.hljs && lang && hljs.getLanguage(lang)) {
                        try {
                            return hljs.highlight(code, { language: lang }).value;
                        } catch (e) {
                            return code;
                        }
                    }
                    return code;
                }
            });

            // Render markdown to HTML
            previewEl.innerHTML = marked.parse(content);
        } else {
            // Fallback if marked is not loaded
            previewEl.innerHTML = `<pre>${this.escapeHtml(content)}</pre>`;
        }

        // Set source code with syntax highlighting
        rawEl.textContent = content;
        if (window.hljs) {
            rawEl.className = 'language-markdown';
            hljs.highlightElement(rawEl);
        }

        // Clone and replace to remove old listeners
        const cloneAndReplace = (el) => {
            if (!el) return null;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            return clone;
        };

        const newPreviewTab = cloneAndReplace(previewTab);
        const newSourceTab = cloneAndReplace(sourceTab);
        const newCopyBtn = cloneAndReplace(copyBtn);

        // Reset to preview view
        previewEl.classList.remove('hidden');
        sourceEl.classList.add('hidden');
        newPreviewTab.classList.add('active');
        newSourceTab.classList.remove('active');

        // Tab switching
        if (newPreviewTab) {
            newPreviewTab.addEventListener('click', () => {
                previewEl.classList.remove('hidden');
                sourceEl.classList.add('hidden');
                newPreviewTab.classList.add('active');
                newSourceTab.classList.remove('active');
            });
        }

        if (newSourceTab) {
            newSourceTab.addEventListener('click', () => {
                previewEl.classList.add('hidden');
                sourceEl.classList.remove('hidden');
                newSourceTab.classList.add('active');
                newPreviewTab.classList.remove('active');
            });
        }

        // Copy button
        if (newCopyBtn) {
            newCopyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(this.rawMarkdownContent);
                    newCopyBtn.textContent = 'Copied!';
                    newCopyBtn.classList.add('active');
                    setTimeout(() => {
                        newCopyBtn.textContent = 'Copy';
                        newCopyBtn.classList.remove('active');
                    }, 2000);
                } catch (err) {
                    console.error('Copy failed:', err);
                }
            });
        }
    },

    // Helper to escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    setupShareModal() {
        document.getElementById('share-modal-close').addEventListener('click', () => {
            UI.hideModal('share-modal');
        });

        document.getElementById('share-cancel').addEventListener('click', () => {
            UI.hideModal('share-modal');
        });

        document.getElementById('share-confirm').addEventListener('click', () => {
            this.createShare();
        });

        // Allow Enter key to submit
        document.getElementById('share-recipient').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createShare();
            }
        });
    },

    shareFolder: null,    // Folder currently being shared

    showShareModal(file) {
        this.shareFile = file;
        this.shareFolder = null;

        // Update modal content
        document.querySelector('#share-modal h2').textContent = 'Share File';
        document.getElementById('share-file-name').textContent = file.name;
        document.getElementById('share-recipient').value = '';
        document.getElementById('share-message').value = '';

        // Reset status
        const statusEl = document.getElementById('share-status');
        statusEl.classList.add('hidden');
        statusEl.classList.remove('success', 'error');

        UI.showModal('share-modal');
        document.getElementById('share-recipient').focus();
    },

    showShareFolderModal(folder) {
        this.shareFolder = folder;
        this.shareFile = null;

        // Update modal content for folder
        document.querySelector('#share-modal h2').textContent = 'Share Folder';
        document.getElementById('share-file-name').textContent = `📁 ${folder.name}`;
        document.getElementById('share-recipient').value = '';
        document.getElementById('share-message').value = '';

        // Reset status
        const statusEl = document.getElementById('share-status');
        statusEl.classList.add('hidden');
        statusEl.classList.remove('success', 'error');

        UI.showModal('share-modal');
        document.getElementById('share-recipient').focus();
    },

    // Convert npub to hex pubkey
    npubToHex(npubOrHex) {
        // If already hex (64 chars), return as is
        if (/^[0-9a-f]{64}$/i.test(npubOrHex)) {
            return npubOrHex.toLowerCase();
        }

        // If npub format, decode bech32
        if (npubOrHex.startsWith('npub1')) {
            try {
                // Simple bech32 decode for npub
                const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
                const data = npubOrHex.slice(5); // Remove 'npub1' prefix

                let bits = [];
                for (const char of data) {
                    const val = ALPHABET.indexOf(char.toLowerCase());
                    if (val === -1) throw new Error('Invalid character');
                    bits.push(...[val >> 4 & 1, val >> 3 & 1, val >> 2 & 1, val >> 1 & 1, val & 1]);
                }

                // Remove checksum (last 30 bits = 6 chars * 5 bits)
                bits = bits.slice(0, -30);

                // Convert 5-bit groups to 8-bit bytes
                const bytes = [];
                for (let i = 0; i + 8 <= bits.length; i += 8) {
                    let byte = 0;
                    for (let j = 0; j < 8; j++) {
                        byte = (byte << 1) | bits[i + j];
                    }
                    bytes.push(byte);
                }

                return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (err) {
                throw new Error('Invalid npub format');
            }
        }

        throw new Error('Invalid pubkey format. Use npub1... or 64-char hex.');
    },

    async createShare() {
        const recipientInput = document.getElementById('share-recipient').value.trim();
        const message = document.getElementById('share-message').value.trim();
        const statusEl = document.getElementById('share-status');
        const confirmBtn = document.getElementById('share-confirm');

        if (!recipientInput) {
            statusEl.textContent = 'Please enter a recipient pubkey';
            statusEl.classList.remove('hidden', 'success');
            statusEl.classList.add('error');
            return;
        }

        // Validate and convert recipient pubkey
        let recipientPubkey;
        try {
            recipientPubkey = this.npubToHex(recipientInput);
        } catch (err) {
            statusEl.textContent = err.message;
            statusEl.classList.remove('hidden', 'success');
            statusEl.classList.add('error');
            return;
        }

        // Don't allow sharing with self
        if (recipientPubkey === Auth.pubkey) {
            statusEl.textContent = 'Cannot share with yourself';
            statusEl.classList.remove('hidden', 'success');
            statusEl.classList.add('error');
            return;
        }

        // Show loading state
        statusEl.textContent = 'Creating share...';
        statusEl.classList.remove('hidden', 'error', 'success');
        confirmBtn.disabled = true;

        try {
            const shareId = Auth.generateShareId();

            // Handle folder sharing
            if (this.shareFolder) {
                const folder = this.shareFolder;

                // Use Sharing module for folder sharing
                await Sharing.shareFolder(folder, recipientPubkey, {
                    message: message,
                    permission: Sharing.PERMISSION_DOWNLOAD,
                });

                // Show success
                statusEl.textContent = 'Folder shared successfully!';
                statusEl.classList.remove('error');
                statusEl.classList.add('success');

                UI.toast(`Shared folder "${folder.name}" with ${recipientInput.slice(0, 12)}...`, 'success');
                this.logActivity('share', { name: folder.name });

                // Close modal after delay
                setTimeout(() => {
                    UI.hideModal('share-modal');
                    this.shareFolder = null;
                }, 1500);

                return;
            }

            // Handle file sharing
            const file = this.shareFile;

            // Get the file key if file is encrypted
            let fileKeyHex = null;
            const isEncrypted = file.encrypted || file.encryption;
            const fileId = file.id || file.file_id || file.fileId || file.d;

            if (isEncrypted && fileId) {
                // Derive the file key
                const folderId = file.folder_id || file.folderId || file.folder || null;
                let fileKey;
                if (folderId) {
                    fileKey = await Keys.deriveFileKey(folderId, fileId);
                } else {
                    fileKey = await Keys.deriveRootFileKey(fileId);
                }
                fileKeyHex = Crypto.bytesToHex(fileKey);
                // Wipe key from memory after converting
                Crypto.wipeKey(fileKey);
            }

            // Create and sign the share event
            const signedEvent = await Auth.createShareEvent({
                id: shareId,
                fileId: fileId || file.sha256,
                fileName: file.name,
                fileSize: file.size,
                fileMimeType: file.mimeType || file.mime_type,
                fileSHA256: file.sha256,
                fileURL: API.getDownloadURL(file.sha256),
                recipientPubkey: recipientPubkey,
                message: message,
                permission: 'download',
                encrypted: isEncrypted,
                fileKey: fileKeyHex,
            });

            // Publish directly to relay (client-side)
            await Auth.publishEvent(signedEvent);

            // Show success
            statusEl.textContent = 'File shared successfully!';
            statusEl.classList.remove('error');
            statusEl.classList.add('success');

            UI.toast(`Shared "${this.shareFile.name}" with ${recipientInput.slice(0, 12)}...`, 'success');
            this.logActivity('share', { name: this.shareFile.name });

            // Close modal after delay
            setTimeout(() => {
                UI.hideModal('share-modal');
                this.shareFile = null;
            }, 1500);

        } catch (err) {
            console.error('Failed to create share:', err);
            statusEl.textContent = `Failed: ${err.message}`;
            statusEl.classList.remove('success');
            statusEl.classList.add('error');
        } finally {
            confirmBtn.disabled = false;
        }
    },

    // === Version History Modal ===
    versionFile: null,

    async showVersionHistory(file) {
        this.versionFile = file;
        const fileId = file.id || file.file_id || file.fileId || file.d;

        // Update modal content
        document.getElementById('version-file-name').textContent = file.name;
        const versionList = document.getElementById('version-list');
        versionList.innerHTML = '<div class="empty-state">Loading versions...</div>';

        UI.showModal('version-modal');

        try {
            await Versioning.init();
            const versions = await Versioning.getVersionHistory(fileId);

            if (versions.length === 0) {
                versionList.innerHTML = '<div class="empty-state">No version history available</div>';
                return;
            }

            versionList.innerHTML = versions.map((v, idx) => `
                <div class="version-item" data-version="${v.version}">
                    <div class="version-info">
                        <span class="version-number">v${v.version}</span>
                        <span class="version-time">${Versioning.formatTimeAgo(v.timestamp)}</span>
                        <span class="version-size">${Upload.formatSize(v.size)}</span>
                        ${v.note ? `<span class="version-note">${UI.escapeHtml(v.note)}</span>` : ''}
                        ${v.autoSave ? '<span class="version-autosave">auto-save</span>' : ''}
                    </div>
                    <div class="version-actions">
                        <button class="btn btn-small version-download-btn" data-version="${v.version}">Download</button>
                        ${idx > 0 ? `<button class="btn btn-small version-restore-btn" data-version="${v.version}">Restore</button>` : '<span class="version-current">Current</span>'}
                    </div>
                </div>
            `).join('');

            // Attach event listeners
            versionList.querySelectorAll('.version-download-btn').forEach(btn => {
                btn.addEventListener('click', () => this.downloadVersion(parseInt(btn.dataset.version)));
            });

            versionList.querySelectorAll('.version-restore-btn').forEach(btn => {
                btn.addEventListener('click', () => this.restoreVersion(parseInt(btn.dataset.version)));
            });

        } catch (err) {
            console.error('Failed to load version history:', err);
            versionList.innerHTML = `<div class="empty-state error">Failed to load versions: ${err.message}</div>`;
        }
    },

    async downloadVersion(versionNumber) {
        try {
            UI.toast(`Downloading version ${versionNumber}...`, 'info');
            const data = await Versioning.downloadVersion(this.versionFile, versionNumber);

            const blob = new Blob([data], { type: this.versionFile.mime_type || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this.versionFile.name}.v${versionNumber}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            UI.toast('Version downloaded', 'success');
        } catch (err) {
            UI.toast(`Download failed: ${err.message}`, 'error');
        }
    },

    async restoreVersion(versionNumber) {
        if (!confirm(`Restore version ${versionNumber}? This will create a new version from the old content.`)) {
            return;
        }

        try {
            UI.toast(`Restoring version ${versionNumber}...`, 'info');
            await Versioning.restoreVersion(this.versionFile, versionNumber);
            UI.toast(`Restored to version ${versionNumber}`, 'success');

            // Refresh the version list
            await this.showVersionHistory(this.versionFile);
            await this.loadFiles();
        } catch (err) {
            UI.toast(`Restore failed: ${err.message}`, 'error');
        }
    },

    // === Encryption Info Modal ===
    showEncryptionInfo(file) {
        const hierarchy = document.getElementById('key-hierarchy');
        const folderId = file.folder_id || file.folderId;

        // Build key hierarchy visualization
        let hierarchyHTML = '';

        if (folderId) {
            hierarchyHTML = `
                <div class="key-node key-node-root">
                    <span class="key-node-icon">&#128273;</span>
                    <span class="key-node-label">Root Key</span>
                    <span class="key-node-desc">Master key from Nostr identity</span>
                </div>
                <div class="key-arrow">&#8595;</div>
                <div class="key-node key-node-folder">
                    <span class="key-node-icon">&#128193;</span>
                    <span class="key-node-label">Folder Key</span>
                    <span class="key-node-desc">Derived via HKDF</span>
                </div>
                <div class="key-arrow">&#8595;</div>
                <div class="key-node key-node-file">
                    <span class="key-node-icon">&#128196;</span>
                    <span class="key-node-label">File Key</span>
                    <span class="key-node-desc">Unique per file</span>
                </div>
            `;
        } else {
            hierarchyHTML = `
                <div class="key-node key-node-root">
                    <span class="key-node-icon">&#128273;</span>
                    <span class="key-node-label">Root Key</span>
                    <span class="key-node-desc">Master key from Nostr identity</span>
                </div>
                <div class="key-arrow">&#8595;</div>
                <div class="key-node key-node-file">
                    <span class="key-node-icon">&#128196;</span>
                    <span class="key-node-label">File Key</span>
                    <span class="key-node-desc">Derived directly from root</span>
                </div>
            `;
        }

        hierarchy.innerHTML = hierarchyHTML;
        UI.showModal('encryption-info-modal');
    },

    // === Keyboard Shortcuts Help ===
    showKeyboardShortcutsHelp() {
        UI.showModal('keyboard-shortcuts-modal');
    },

    // === Public Link Modal ===
    publicLinkFile: null,

    showPublicLinkModal(file) {
        this.publicLinkFile = file;

        document.getElementById('public-link-file-name').textContent = file.name;
        document.getElementById('public-link-expiry').value = '0';
        document.getElementById('public-link-result').classList.add('hidden');
        document.getElementById('public-link-status').classList.add('hidden');
        document.getElementById('public-link-url').value = '';

        UI.showModal('public-link-modal');
    },

    async generatePublicLink() {
        const expirySeconds = parseInt(document.getElementById('public-link-expiry').value);
        const statusEl = document.getElementById('public-link-status');
        const resultEl = document.getElementById('public-link-result');
        const urlInput = document.getElementById('public-link-url');
        const generateBtn = document.getElementById('public-link-generate');

        statusEl.textContent = 'Generating link...';
        statusEl.classList.remove('hidden', 'error', 'success');
        generateBtn.disabled = true;

        try {
            const expiresAt = expirySeconds > 0 ? Math.floor(Date.now() / 1000) + expirySeconds : null;

            const publicLink = await Sharing.generatePublicLink(this.publicLinkFile, {
                expiresAt: expiresAt,
            });

            urlInput.value = publicLink.url;
            resultEl.classList.remove('hidden');
            statusEl.classList.add('hidden');

            UI.toast('Public link created', 'success');

        } catch (err) {
            console.error('Failed to generate public link:', err);
            statusEl.textContent = `Failed: ${err.message}`;
            statusEl.classList.add('error');
        } finally {
            generateBtn.disabled = false;
        }
    },

    copyPublicLink() {
        const urlInput = document.getElementById('public-link-url');
        urlInput.select();
        document.execCommand('copy');
        UI.toast('Link copied to clipboard', 'success');
    },

    // === Manage Shares Modal ===
    manageSharesFile: null,

    async showManageSharesModal(file) {
        this.manageSharesFile = file;
        const fileId = file.id || file.file_id || file.fileId || file.d;

        document.getElementById('manage-shares-file-name').textContent = file.name;
        const sharesList = document.getElementById('manage-shares-list');
        sharesList.innerHTML = '<div class="empty-state">Loading shares...</div>';
        document.getElementById('manage-shares-status').classList.add('hidden');

        UI.showModal('manage-shares-modal');

        try {
            // Get outgoing shares for this file
            const shares = await Sharing.listOutgoingShares();
            const fileShares = shares.filter(s => {
                // Match by file reference tag
                const fileTag = s.tags?.find(t => t[0] === 'file');
                return fileTag && fileTag[1]?.includes(fileId);
            });

            if (fileShares.length === 0) {
                sharesList.innerHTML = '<div class="empty-state">No active shares for this file</div>';
                return;
            }

            sharesList.innerHTML = fileShares.map(share => {
                const recipientTag = share.tags?.find(t => t[0] === 'p');
                const recipient = recipientTag ? recipientTag[1] : 'Unknown';
                const permTag = share.tags?.find(t => t[0] === 'permission');
                const permission = permTag ? permTag[1] : 'view';
                const expTag = share.tags?.find(t => t[0] === 'expiration');
                const expiresAt = expTag ? parseInt(expTag[1]) : null;
                const isExpired = expiresAt && expiresAt < Math.floor(Date.now() / 1000);

                return `
                    <div class="share-item ${isExpired ? 'expired' : ''}" data-share-id="${share.id || ''}">
                        <div class="share-info">
                            <span class="share-recipient">${recipient.slice(0, 8)}...${recipient.slice(-8)}</span>
                            <span class="share-permission">${permission}</span>
                            <span class="share-expiry">${Sharing.formatExpiration(expiresAt)}</span>
                        </div>
                        <button class="btn btn-small btn-danger revoke-share-btn" data-share-id="${share.id || ''}">Revoke</button>
                    </div>
                `;
            }).join('');

            // Attach revoke handlers
            sharesList.querySelectorAll('.revoke-share-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const shareId = btn.dataset.shareId;
                    if (shareId && confirm('Revoke this share?')) {
                        await this.revokeShare(shareId);
                    }
                });
            });

        } catch (err) {
            console.error('Failed to load shares:', err);
            sharesList.innerHTML = `<div class="empty-state error">Failed to load shares: ${err.message}</div>`;
        }
    },

    async revokeShare(shareId) {
        const statusEl = document.getElementById('manage-shares-status');
        try {
            statusEl.textContent = 'Revoking share...';
            statusEl.classList.remove('hidden', 'error', 'success');

            await Sharing.revokeShare(shareId);

            statusEl.textContent = 'Share revoked';
            statusEl.classList.add('success');
            UI.toast('Share revoked', 'success');

            // Refresh the list
            await this.showManageSharesModal(this.manageSharesFile);

        } catch (err) {
            statusEl.textContent = `Failed: ${err.message}`;
            statusEl.classList.add('error');
            UI.toast(`Revoke failed: ${err.message}`, 'error');
        }
    },

    async rekeyFile() {
        if (!this.manageSharesFile) return;

        const statusEl = document.getElementById('manage-shares-status');
        const file = this.manageSharesFile;

        if (!confirm(`Re-encrypt "${file.name}"?\n\nThis will:\n- Generate a new encryption key\n- Re-upload the file encrypted with the new key\n- Invalidate all existing shares and public links\n\nThis cannot be undone.`)) {
            return;
        }

        try {
            statusEl.textContent = 'Re-encrypting file...';
            statusEl.classList.remove('hidden', 'error', 'success');

            const result = await Sharing.revokeAndReencryptFile(file);

            statusEl.textContent = 'File re-encrypted with new key';
            statusEl.classList.add('success');
            UI.toast('File re-encrypted successfully', 'success');

            // Refresh files list
            await this.loadFiles();

            // Close modal after delay
            setTimeout(() => UI.hideModal('manage-shares-modal'), 1500);

        } catch (err) {
            statusEl.textContent = `Re-encryption failed: ${err.message}`;
            statusEl.classList.add('error');
            UI.toast(`Re-encryption failed: ${err.message}`, 'error');
        }
    },

    // === Collaboration Editor ===
    editorFile: null,
    editorSession: null,

    async openEditor(file) {
        const mimeType = file.mime_type || file.mimeType || '';
        if (!Collaboration.isCollaborativeFileType(mimeType)) {
            UI.toast('This file type cannot be edited', 'error');
            return;
        }

        this.editorFile = file;
        document.getElementById('editor-file-name').textContent = `Edit: ${file.name}`;
        document.getElementById('editor-textarea').value = 'Loading...';
        document.getElementById('editor-status').textContent = 'Loading...';
        document.getElementById('editor-collaborators').innerHTML = '';

        UI.showModal('editor-modal');

        try {
            // Start collaboration session
            this.editorSession = await Collaboration.startSession(file, {
                onSync: (session) => {
                    document.getElementById('editor-status').textContent = 'Ready';
                },
                onAwarenessChange: (changes, states) => {
                    this.updateCollaboratorsList(states);
                },
            });

            // Bind to textarea
            const textarea = document.getElementById('editor-textarea');
            Collaboration.bindToTextarea(this.editorSession, textarea);

            document.getElementById('editor-status').textContent = 'Ready';

        } catch (err) {
            console.error('Failed to open editor:', err);
            document.getElementById('editor-textarea').value = `Error: ${err.message}`;
            document.getElementById('editor-status').textContent = 'Error';
        }
    },

    updateCollaboratorsList(states) {
        const container = document.getElementById('editor-collaborators');
        const collaborators = Array.from(states.values())
            .filter(s => s.user)
            .map(s => s.user);

        container.innerHTML = collaborators.map(user => `
            <span class="collaborator" style="background-color: ${user.color}" title="${user.name}">
                ${user.name.slice(0, 2).toUpperCase()}
            </span>
        `).join('');
    },

    async saveEditor() {
        if (!this.editorSession) return;

        try {
            document.getElementById('editor-status').textContent = 'Saving...';
            await Collaboration.saveDocument(this.editorSession);
            document.getElementById('editor-status').textContent = 'Saved';
            UI.toast('File saved', 'success');
        } catch (err) {
            document.getElementById('editor-status').textContent = 'Save failed';
            UI.toast(`Save failed: ${err.message}`, 'error');
        }
    },

    async closeEditor(save = false) {
        if (save && this.editorSession) {
            await this.saveEditor();
        }

        if (this.editorSession) {
            const fileId = this.editorFile?.file_id || this.editorFile?.fileId || this.editorFile?.d;
            await Collaboration.endSession(fileId);
            this.editorSession = null;
        }

        this.editorFile = null;
        UI.hideModal('editor-modal');
        await this.loadFiles();
    },

    async inviteCollaborator() {
        if (!this.editorSession) return;

        const npub = prompt('Enter collaborator npub or hex pubkey:');
        if (!npub || !npub.trim()) return;

        try {
            const pubkey = this.npubToHex(npub.trim());
            const fileId = this.editorFile?.file_id || this.editorFile?.fileId || this.editorFile?.d;
            await Collaboration.inviteCollaborator(fileId, pubkey);
            UI.toast('Collaborator invited', 'success');
        } catch (err) {
            UI.toast(`Invite failed: ${err.message}`, 'error');
        }
    },

    // === Key Backup Modal ===
    showBackupModal() {
        document.getElementById('backup-status').classList.add('hidden');
        UI.showModal('backup-modal');
    },

    async exportKeyBackup() {
        const statusEl = document.getElementById('backup-status');

        try {
            statusEl.textContent = 'Generating backup...';
            statusEl.classList.remove('hidden', 'error', 'success');

            const backup = await Keys.exportBackup();

            // Download the backup
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cloistr-drive-backup-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            statusEl.textContent = 'Backup downloaded!';
            statusEl.classList.add('success');
            UI.toast('Key backup exported', 'success');

        } catch (err) {
            statusEl.textContent = `Export failed: ${err.message}`;
            statusEl.classList.add('error');
            UI.toast(`Backup failed: ${err.message}`, 'error');
        }
    },

    async importKeyBackup(file) {
        const statusEl = document.getElementById('backup-status');

        try {
            statusEl.textContent = 'Importing backup...';
            statusEl.classList.remove('hidden', 'error', 'success');

            const text = await file.text();
            const backup = JSON.parse(text);

            await Keys.importBackup(backup);

            statusEl.textContent = 'Backup restored!';
            statusEl.classList.add('success');
            UI.toast('Keys restored from backup', 'success');

        } catch (err) {
            statusEl.textContent = `Import failed: ${err.message}`;
            statusEl.classList.add('error');
            UI.toast(`Import failed: ${err.message}`, 'error');
        }
    },

    // === Relay Settings ===
    editingRelays: [], // Temporary storage for relays being edited

    async showRelaySettingsModal() {
        // Load current relay preferences
        await this.loadRelaySettings();
        UI.showModal('relay-settings-modal');
    },

    async loadRelaySettings() {
        const listEl = document.getElementById('relay-list');
        const sourceInfoEl = document.getElementById('relay-source-info');

        if (!Auth.pubkey) {
            listEl.innerHTML = '<div class="relay-list-empty">Connect to view relay settings</div>';
            return;
        }

        listEl.innerHTML = '<div class="relay-list-empty">Loading...</div>';

        try {
            const prefs = await RelayPrefs.getRelayPrefs(Auth.pubkey);

            // Convert to editing format
            this.editingRelays = [];
            const seenUrls = new Set();

            // Combine read and write relays
            for (const url of prefs.readRelays || []) {
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    this.editingRelays.push({
                        url,
                        read: true,
                        write: (prefs.writeRelays || []).includes(url)
                    });
                }
            }
            for (const url of prefs.writeRelays || []) {
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    this.editingRelays.push({
                        url,
                        read: false,
                        write: true
                    });
                }
            }

            this.renderRelayList();

            // Show source info
            const sourceMap = {
                'cloistr-relays': 'Loaded from your Cloistr relay preferences',
                'nip65': 'Loaded from your NIP-65 relay list',
                'discovery': 'Loaded from Cloistr discovery service',
                'default': 'Using default relay (no preferences saved)'
            };
            sourceInfoEl.textContent = sourceMap[prefs.source] || `Source: ${prefs.source}`;

        } catch (err) {
            listEl.innerHTML = `<div class="relay-list-empty">Error loading relays: ${err.message}</div>`;
            console.error('Failed to load relay settings:', err);
        }
    },

    renderRelayList() {
        const listEl = document.getElementById('relay-list');

        if (this.editingRelays.length === 0) {
            listEl.innerHTML = '<div class="relay-list-empty">No relays configured</div>';
            return;
        }

        listEl.innerHTML = this.editingRelays.map((relay, index) => `
            <div class="relay-item" data-index="${index}">
                <span class="relay-url" title="${relay.url}">${relay.url}</span>
                <span class="relay-badge ${relay.read ? 'active' : 'inactive'}"
                      data-action="toggle-read" title="Toggle read">R</span>
                <span class="relay-badge ${relay.write ? 'active' : 'inactive'}"
                      data-action="toggle-write" title="Toggle write">W</span>
                <button class="relay-remove" data-action="remove" title="Remove relay">&times;</button>
            </div>
        `).join('');

        // Add click handlers for badges and remove buttons
        listEl.querySelectorAll('.relay-item').forEach(item => {
            const index = parseInt(item.dataset.index);

            item.querySelector('[data-action="toggle-read"]').addEventListener('click', () => {
                this.toggleRelayFlag(index, 'read');
            });
            item.querySelector('[data-action="toggle-write"]').addEventListener('click', () => {
                this.toggleRelayFlag(index, 'write');
            });
            item.querySelector('[data-action="remove"]').addEventListener('click', () => {
                this.removeRelay(index);
            });
        });
    },

    toggleRelayFlag(index, flag) {
        if (index >= 0 && index < this.editingRelays.length) {
            this.editingRelays[index][flag] = !this.editingRelays[index][flag];
            // Allow both to be off - relay will be disabled (not included in published event)
            this.renderRelayList();
        }
    },

    removeRelay(index) {
        if (index >= 0 && index < this.editingRelays.length) {
            this.editingRelays.splice(index, 1);
            this.renderRelayList();
        }
    },

    addRelayFromInput() {
        const urlInput = document.getElementById('relay-add-url');
        const readCheckbox = document.getElementById('relay-add-read');
        const writeCheckbox = document.getElementById('relay-add-write');

        let url = urlInput.value.trim();

        // Validate URL
        if (!url) {
            UI.toast('Please enter a relay URL', 'error');
            return;
        }

        // Add wss:// prefix if missing
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
            url = 'wss://' + url;
        }

        // Check for duplicates
        if (this.editingRelays.some(r => r.url === url)) {
            UI.toast('Relay already in list', 'error');
            return;
        }

        // Validate URL format
        try {
            new URL(url);
        } catch {
            UI.toast('Invalid relay URL', 'error');
            return;
        }

        // Add the relay
        this.editingRelays.push({
            url,
            read: readCheckbox.checked,
            write: writeCheckbox.checked
        });

        // Clear input and reset checkboxes
        urlInput.value = '';
        readCheckbox.checked = true;
        writeCheckbox.checked = true;

        this.renderRelayList();
        UI.toast('Relay added', 'success');
    },

    async saveRelaySettings() {
        if (this.editingRelays.length === 0) {
            UI.toast('Add at least one relay', 'error');
            return;
        }

        // Ensure at least one write relay
        const hasWrite = this.editingRelays.some(r => r.write);
        if (!hasWrite) {
            UI.toast('At least one relay must have write enabled', 'error');
            return;
        }

        try {
            UI.toast('Saving relay preferences...', 'info');

            await RelayPrefs.publishRelayPrefs(this.editingRelays);

            UI.hideModal('relay-settings-modal');
            UI.toast('Relay preferences saved', 'success');

        } catch (err) {
            UI.toast(`Failed to save: ${err.message}`, 'error');
            console.error('Failed to save relay settings:', err);
        }
    },

    // === Migration Tool ===
    async checkMigration() {
        // Check for unencrypted files that can be migrated
        const unencryptedFiles = this.files.filter(f => !f.encrypted && !f.encryption);

        if (unencryptedFiles.length > 0) {
            document.getElementById('migration-files').innerHTML = `
                <p>Found ${unencryptedFiles.length} unencrypted file(s):</p>
                <ul>
                    ${unencryptedFiles.slice(0, 10).map(f => `<li>${UI.escapeHtml(f.name)}</li>`).join('')}
                    ${unencryptedFiles.length > 10 ? `<li>...and ${unencryptedFiles.length - 10} more</li>` : ''}
                </ul>
            `;
            UI.showModal('migration-modal');
        }
    },

    async migrateFiles() {
        const unencryptedFiles = this.files.filter(f => !f.encrypted && !f.encryption);
        const progressEl = document.getElementById('migration-progress');
        const barEl = document.getElementById('migration-bar');
        const statusEl = document.getElementById('migration-status-text');
        const startBtn = document.getElementById('migration-start');

        progressEl.classList.remove('hidden');
        startBtn.disabled = true;

        let migrated = 0;
        let failed = 0;

        for (let i = 0; i < unencryptedFiles.length; i++) {
            const file = unencryptedFiles[i];
            statusEl.textContent = `Migrating ${file.name}...`;
            barEl.style.width = `${((i + 1) / unencryptedFiles.length) * 100}%`;

            try {
                // Download the file
                const downloadUrl = API.getDownloadURL(file.sha256);
                const response = await fetch(downloadUrl);
                const data = await response.arrayBuffer();

                // Re-upload encrypted
                await Upload.uploadEncryptedFile(new Uint8Array(data), file.name, file.mime_type, this.currentFolderId);

                // Delete the old unencrypted file
                await API.deleteFile(file.sha256, await Auth.createDeleteAuth(file.sha256));

                migrated++;
            } catch (err) {
                console.error(`Failed to migrate ${file.name}:`, err);
                failed++;
            }
        }

        statusEl.textContent = `Complete: ${migrated} migrated, ${failed} failed`;
        startBtn.disabled = false;

        await this.loadFiles();
        UI.toast(`Migration complete: ${migrated} files encrypted`, 'success');
    },

    // Helper: Download file data (used by Collaboration)
    async downloadFileData(file) {
        const downloadUrl = API.getDownloadURL(file.sha256);
        const response = await fetch(downloadUrl);

        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }

        const encryptedData = await response.arrayBuffer();
        const isEncrypted = file.encrypted || file.encryption;

        if (isEncrypted) {
            const fileId = file.id || file.file_id || file.fileId || file.d;
            const folderId = file.folder_id || file.folderId || file.folder || null;

            let fileKey;
            if (folderId) {
                fileKey = await Keys.deriveFileKey(folderId, fileId);
            } else {
                fileKey = await Keys.deriveRootFileKey(fileId);
            }

            const decryptedData = await Crypto.decryptFile(encryptedData, fileKey);
            Crypto.wipeKey(fileKey);

            return decryptedData;
        }

        return new Uint8Array(encryptedData);
    },

    // Setup additional modal event listeners
    setupModalEventListeners() {
        // Click outside modal to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                // Only close if clicking on the backdrop (the modal itself), not the content
                if (e.target === modal) {
                    UI.hideModal(modal.id);
                }
            });
        });

        // Batch toolbar select-all checkbox
        document.getElementById('batch-select-all-checkbox')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                this.selectAllFiles();
            } else {
                this.clearSelection();
            }
        });
        document.getElementById('batch-download-btn')?.addEventListener('click', () => {
            this.bulkDownload();
        });
        document.getElementById('batch-delete-btn')?.addEventListener('click', () => {
            this.bulkDelete();
        });
        document.getElementById('batch-cancel-btn')?.addEventListener('click', () => {
            this.clearSelection();
        });

        // Version modal
        document.getElementById('version-modal-close').addEventListener('click', () => {
            UI.hideModal('version-modal');
        });
        document.getElementById('version-close').addEventListener('click', () => {
            UI.hideModal('version-modal');
        });

        // Public link modal
        document.getElementById('public-link-modal-close').addEventListener('click', () => {
            UI.hideModal('public-link-modal');
        });
        document.getElementById('public-link-cancel').addEventListener('click', () => {
            UI.hideModal('public-link-modal');
        });
        document.getElementById('public-link-generate').addEventListener('click', () => {
            this.generatePublicLink();
        });
        document.getElementById('public-link-copy').addEventListener('click', () => {
            this.copyPublicLink();
        });

        // Editor modal
        document.getElementById('editor-modal-close').addEventListener('click', () => {
            this.closeEditor(false);
        });
        document.getElementById('editor-close').addEventListener('click', () => {
            this.closeEditor(false);
        });
        document.getElementById('editor-save').addEventListener('click', () => {
            this.saveEditor();
        });
        document.getElementById('editor-save-close').addEventListener('click', () => {
            this.closeEditor(true);
        });
        document.getElementById('editor-invite').addEventListener('click', () => {
            this.inviteCollaborator();
        });

        // Backup modal
        document.getElementById('backup-btn').addEventListener('click', () => {
            this.showBackupModal();
        });
        document.getElementById('backup-modal-close').addEventListener('click', () => {
            UI.hideModal('backup-modal');
        });
        document.getElementById('backup-close').addEventListener('click', () => {
            UI.hideModal('backup-modal');
        });
        document.getElementById('backup-export-btn').addEventListener('click', () => {
            this.exportKeyBackup();
        });
        document.getElementById('backup-import-btn').addEventListener('click', () => {
            document.getElementById('backup-file-input').click();
        });
        document.getElementById('backup-file-input').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.importKeyBackup(e.target.files[0]);
                e.target.value = '';
            }
        });

        // Keyboard Shortcuts modal
        document.getElementById('keyboard-shortcuts-close')?.addEventListener('click', () => {
            UI.hideModal('keyboard-shortcuts-modal');
        });
        document.getElementById('keyboard-shortcuts-done')?.addEventListener('click', () => {
            UI.hideModal('keyboard-shortcuts-modal');
        });

        // Encryption Info modal
        document.getElementById('encryption-info-close').addEventListener('click', () => {
            UI.hideModal('encryption-info-modal');
        });
        document.getElementById('encryption-info-done').addEventListener('click', () => {
            UI.hideModal('encryption-info-modal');
        });

        // Manage Shares modal
        document.getElementById('manage-shares-modal-close').addEventListener('click', () => {
            UI.hideModal('manage-shares-modal');
        });
        document.getElementById('manage-shares-close').addEventListener('click', () => {
            UI.hideModal('manage-shares-modal');
        });
        document.getElementById('rekey-file-btn').addEventListener('click', () => {
            this.rekeyFile();
        });

        // Migration modal
        document.getElementById('migration-modal-close').addEventListener('click', () => {
            UI.hideModal('migration-modal');
        });
        document.getElementById('migration-cancel').addEventListener('click', () => {
            UI.hideModal('migration-modal');
        });
        document.getElementById('migration-start').addEventListener('click', () => {
            this.migrateFiles();
        });

        // New folder modal
        document.getElementById('new-folder-modal-close').addEventListener('click', () => {
            UI.hideModal('new-folder-modal');
        });
        document.getElementById('new-folder-cancel').addEventListener('click', () => {
            UI.hideModal('new-folder-modal');
        });
        document.getElementById('new-folder-create').addEventListener('click', () => {
            const name = document.getElementById('new-folder-name').value;
            this.createFolder(name);
        });
        document.getElementById('new-folder-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const name = document.getElementById('new-folder-name').value;
                this.createFolder(name);
            } else if (e.key === 'Escape') {
                UI.hideModal('new-folder-modal');
            }
        });

        // Rename modal
        document.getElementById('rename-modal-close').addEventListener('click', () => {
            UI.hideModal('rename-modal');
            this.renameTarget = null;
        });
        document.getElementById('rename-cancel').addEventListener('click', () => {
            UI.hideModal('rename-modal');
            this.renameTarget = null;
        });
        document.getElementById('rename-confirm').addEventListener('click', () => {
            this.doRename();
        });
        document.getElementById('rename-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.doRename();
            } else if (e.key === 'Escape') {
                UI.hideModal('rename-modal');
                this.renameTarget = null;
            }
        });

        // Tags modal
        document.getElementById('tags-modal-close')?.addEventListener('click', () => {
            UI.hideModal('tags-modal');
        });
        document.getElementById('tags-done')?.addEventListener('click', () => {
            UI.hideModal('tags-modal');
        });

        const tagInput = document.getElementById('tag-input');
        const tagSuggestions = document.getElementById('tag-suggestions');

        tagInput?.addEventListener('input', (e) => {
            const value = e.target.value.trim().toLowerCase();
            if (value.length > 0) {
                // Show suggestions
                const matches = this.availableTags.filter(t =>
                    t.includes(value) && !this.getFileTags(this.tagModalFile?.sha256).includes(t)
                );
                if (matches.length > 0) {
                    tagSuggestions.innerHTML = matches.map(t =>
                        `<div class="tag-suggestion" data-tag="${UI.escapeHtml(t)}">${UI.escapeHtml(t)}</div>`
                    ).join('');
                    tagSuggestions.classList.remove('hidden');

                    tagSuggestions.querySelectorAll('.tag-suggestion').forEach(el => {
                        el.addEventListener('click', () => {
                            if (this.tagModalFile) {
                                this.addTagToFile(this.tagModalFile.sha256, el.dataset.tag);
                                this.renderFileTags(document.getElementById('tags-container'), this.tagModalFile.sha256);
                            }
                            tagInput.value = '';
                            tagSuggestions.classList.add('hidden');
                        });
                    });
                } else {
                    tagSuggestions.classList.add('hidden');
                }
            } else {
                tagSuggestions.classList.add('hidden');
            }
        });

        tagInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = tagInput.value.trim();
                if (value && this.tagModalFile) {
                    this.addTagToFile(this.tagModalFile.sha256, value);
                    this.renderFileTags(document.getElementById('tags-container'), this.tagModalFile.sha256);
                    tagInput.value = '';
                    tagSuggestions.classList.add('hidden');
                }
            } else if (e.key === 'Escape') {
                tagSuggestions.classList.add('hidden');
            }
        });

        // Folder customize modal
        document.getElementById('folder-customize-close')?.addEventListener('click', () => {
            UI.hideModal('folder-customize-modal');
            this.customizingFolder = null;
        });

        document.getElementById('folder-customize-save')?.addEventListener('click', () => {
            this.saveFolderCustomization();
        });

        document.getElementById('folder-customize-reset')?.addEventListener('click', () => {
            this.resetFolderCustomization();
        });

        // Comments modal
        document.getElementById('comments-modal-close')?.addEventListener('click', () => {
            UI.hideModal('comments-modal');
            this.commentsModalFile = null;
        });

        document.getElementById('add-comment-btn')?.addEventListener('click', () => {
            const input = document.getElementById('comment-input');
            if (this.commentsModalFile && input.value.trim()) {
                this.addComment(this.commentsModalFile.sha256, input.value);
                input.value = '';
                this.renderComments(
                    document.getElementById('comments-list'),
                    this.commentsModalFile.sha256
                );
            }
        });

        // Allow Enter+Ctrl to submit comment
        document.getElementById('comment-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                document.getElementById('add-comment-btn')?.click();
            }
        });

        // Activity modal
        document.getElementById('activity-modal-close')?.addEventListener('click', () => {
            UI.hideModal('activity-modal');
        });

        document.getElementById('activity-filter')?.addEventListener('change', (e) => {
            this.renderActivityLog(e.target.value);
        });

        document.getElementById('clear-activity')?.addEventListener('click', () => {
            this.clearActivityLog();
        });

        // Activity sidebar navigation
        document.getElementById('nav-activity')?.addEventListener('click', () => {
            this.showActivityModal();
        });

        // Notifications modal
        document.getElementById('notifications-modal-close')?.addEventListener('click', () => {
            UI.hideModal('notifications-modal');
        });

        document.getElementById('mark-all-read')?.addEventListener('click', () => {
            this.markAllNotificationsRead();
        });

        document.getElementById('nav-notifications')?.addEventListener('click', () => {
            this.showNotificationsModal();
        });

        // Relay Settings modal - event listeners are handled by RelaySettingsUI.setupEventListeners()
        // in setupDragAndDrop() init, so we don't duplicate them here.

        // Request notification permission when user interacts
        document.addEventListener('click', () => {
            this.requestNotificationPermission();
        }, { once: true });
    },

    // Register service worker for offline support
    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', async () => {
                try {
                    const registration = await navigator.serviceWorker.register('/sw.js', {
                        scope: '/',
                    });

                    console.log('ServiceWorker registered:', registration.scope);

                    // Check for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New version available
                                UI.toast('New version available. Refresh to update.', 'info');
                            }
                        });
                    });
                } catch (err) {
                    console.warn('ServiceWorker registration failed:', err);
                }
            });
        }
    },

    // Check if app is running offline
    isOffline() {
        return !navigator.onLine;
    },

    // Handle online/offline events
    setupOfflineHandlers() {
        const offlineBanner = document.getElementById('offline-banner');

        // Initial check
        if (!navigator.onLine && offlineBanner) {
            offlineBanner.classList.add('visible');
        }

        window.addEventListener('online', () => {
            if (offlineBanner) offlineBanner.classList.remove('visible');
            UI.toast('Back online', 'success');
            // Sync any pending operations
            this.syncPendingOperations();
        });

        window.addEventListener('offline', () => {
            if (offlineBanner) offlineBanner.classList.add('visible');
            UI.toast('You are offline. Changes will sync when reconnected.', 'warning');
        });
    },

    // Sync pending operations when back online
    async syncPendingOperations() {
        // Trigger background sync if supported
        if ('serviceWorker' in navigator && 'sync' in window.registration) {
            try {
                await window.registration.sync.register('upload-sync');
            } catch (err) {
                console.warn('Background sync not available:', err);
            }
        }
    },

    // === File Operations ===

    // Move file to a different folder
    async moveFileToFolder(file, targetFolderId, targetFolderName) {
        try {
            UI.toast(`Moving ${file.name} to ${targetFolderName}...`, 'info');

            // Update the file metadata event with new folder tag
            const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
                fileId: file.file_id,
                sha256: file.sha256,
                plaintextHash: file.plaintext_hash || file.plaintextHash,
                name: file.name,
                size: file.size,
                encryptedSize: file.encrypted_size || file.encryptedSize,
                mimeType: file.mime_type,
                folderId: targetFolderId, // New folder
                encrypted: file.encrypted,
            });

            // Publish the updated metadata
            await Auth.publishEvent(metadataEvent);

            UI.toast(`Moved ${file.name} to ${targetFolderName}`, 'success');
            this.logActivity('move', { name: file.name, destination: targetFolderName });

            // Refresh files
            await this.loadFiles();

        } catch (err) {
            console.error('Move file failed:', err);
            UI.toast(`Failed to move file: ${err.message}`, 'error');
        }
    },

    // === Batch Operations ===

    // Toggle file selection
    toggleFileSelection(sha256) {
        if (this.selectedFiles.has(sha256)) {
            this.selectedFiles.delete(sha256);
        } else {
            this.selectedFiles.add(sha256);
        }
        this.updateSelectionUI();
    },

    // Toggle folder selection
    toggleFolderSelection(folderId) {
        if (this.selectedFolders.has(folderId)) {
            this.selectedFolders.delete(folderId);
        } else {
            this.selectedFolders.add(folderId);
        }
        this.updateSelectionUI();
    },

    // Select all files and folders in current view
    selectAllFiles() {
        if (this.currentView === 'trash') {
            // Select all trash files
            this.selectedTrashFiles = this.selectedTrashFiles || new Set();
            this.trashedFiles.forEach(f => this.selectedTrashFiles.add(f.sha256));
            this.updateTrashSelectionUI();
        } else {
            // Select all regular files and folders
            this.files.forEach(f => this.selectedFiles.add(f.sha256));
            this.folders.forEach(f => this.selectedFolders.add(f.id));
            this.updateSelectionUI();
        }
    },

    // Clear all selections
    clearSelection() {
        this.selectedFiles.clear();
        this.selectedFolders.clear();
        if (this.selectedTrashFiles) {
            this.selectedTrashFiles.clear();
        }
        this.selectionMode = false;
        if (this.currentView === 'trash') {
            this.updateTrashSelectionUI();
        } else {
            this.updateSelectionUI();
        }
    },

    // Update selection UI (checkboxes, toolbar)
    updateSelectionUI() {
        const fileCount = this.selectedFiles.size;
        const folderCount = this.selectedFolders.size;
        const totalCount = fileCount + folderCount;
        const toolbar = document.getElementById('batch-toolbar');

        if (totalCount > 0) {
            this.selectionMode = true;
            if (toolbar) {
                toolbar.classList.remove('hidden');
                // Build descriptive selection count
                const parts = [];
                if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
                if (folderCount > 0) parts.push(`${folderCount} folder${folderCount > 1 ? 's' : ''}`);
                document.getElementById('selected-count').textContent = parts.join(', ') + ' selected';
            }
        } else {
            this.selectionMode = false;
            if (toolbar) toolbar.classList.add('hidden');
        }

        // Update file checkboxes
        document.querySelectorAll('.file-checkbox').forEach(cb => {
            const sha256 = cb.dataset.sha256;
            cb.checked = this.selectedFiles.has(sha256);
        });

        // Update folder checkboxes
        document.querySelectorAll('.folder-checkbox').forEach(cb => {
            const folderId = cb.dataset.folderId;
            cb.checked = this.selectedFolders.has(folderId);
        });

        // Update item selected state
        document.querySelectorAll('.file-item').forEach(item => {
            const sha256 = item.dataset.sha256;
            const folderId = item.dataset.folderId;
            if (sha256) {
                item.classList.toggle('selected', this.selectedFiles.has(sha256));
            } else if (folderId) {
                item.classList.toggle('selected', this.selectedFolders.has(folderId));
            }
        });

        // Update select-all checkbox state (both header and batch toolbar)
        const totalItems = this.files.length + this.folders.length;
        const allSelected = totalCount > 0 && totalCount === totalItems;
        const someSelected = totalCount > 0 && totalCount < totalItems;

        const selectAllCheckbox = document.getElementById('select-all-checkbox');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allSelected;
            selectAllCheckbox.indeterminate = someSelected;
        }

        const batchSelectAll = document.getElementById('batch-select-all-checkbox');
        if (batchSelectAll) {
            batchSelectAll.checked = allSelected;
            batchSelectAll.indeterminate = someSelected;
        }
    },

    // Bulk delete selected files and folders
    async bulkDelete() {
        const fileCount = this.selectedFiles.size;
        const folderCount = this.selectedFolders.size;
        const totalCount = fileCount + folderCount;
        if (totalCount === 0) return;

        const parts = [];
        if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
        if (folderCount > 0) parts.push(`${folderCount} folder${folderCount > 1 ? 's' : ''}`);
        const description = parts.join(' and ');

        if (!confirm(`Delete ${description}? This cannot be undone.`)) {
            return;
        }

        UI.toast(`Deleting ${description}...`, 'info');

        let deleted = 0;
        let failed = 0;

        // Throttle delay to avoid relay rate limits (5 events/sec for unknown pubkeys)
        const throttleDelay = () => new Promise(resolve => setTimeout(resolve, 250));

        // Soft delete files with throttling (each file needs unique metadata update)
        for (const sha256 of this.selectedFiles) {
            try {
                await this.deleteFile(sha256, true); // suppress individual toasts
                deleted++;
                await throttleDelay();
            } catch (err) {
                console.error(`Failed to delete file ${sha256}:`, err);
                failed++;
            }
        }

        // Batch delete folders with single kind:5 event (NIP-09)
        if (this.selectedFolders.size > 0) {
            try {
                const folderIds = Array.from(this.selectedFolders);
                const signedEvent = await Auth.createBatchDeleteEvent([], folderIds);
                await Auth.publishEvent(signedEvent);
                deleted += folderIds.length;
                console.log(`Batch deleted ${folderIds.length} folders with single event`);
            } catch (err) {
                console.error('Failed to batch delete folders:', err);
                failed += this.selectedFolders.size;
            }
        }

        this.clearSelection();
        await this.loadFiles();
        await this.loadFolderTree();

        if (failed === 0) {
            UI.toast(`Deleted ${deleted} items`, 'success');
        } else {
            UI.toast(`Deleted ${deleted}, failed ${failed}`, 'warning');
        }
    },

    // Bulk download selected files (as individual downloads)
    async bulkDownload() {
        const count = this.selectedFiles.size;
        if (count === 0) return;

        UI.toast(`Downloading ${count} files...`, 'info');

        for (const sha256 of this.selectedFiles) {
            const file = this.files.find(f => f.sha256 === sha256);
            if (file) {
                await this.downloadFile(file);
                // Small delay between downloads
                await new Promise(r => setTimeout(r, 500));
            }
        }

        this.clearSelection();
    },

    // === Storage Usage ===

    // Calculate and display storage usage
    async updateStorageUsage() {
        const valueEl = document.getElementById('storage-value');
        const barFill = document.getElementById('storage-bar-fill');
        const detailsEl = document.getElementById('storage-details');

        if (!valueEl || !barFill) return;

        // Try to get quota from server
        try {
            if (Auth.pubkey) {
                const quota = await API.getQuota(Auth.pubkey);

                if (quota.enabled) {
                    // Server quota is enabled - show server-side values
                    valueEl.textContent = quota.used_human;

                    if (quota.limit > 0) {
                        // Show percentage
                        barFill.style.width = quota.percent + '%';
                        detailsEl.textContent = `${quota.used_human} of ${quota.limit_human} used`;
                    } else {
                        // Unlimited quota
                        barFill.style.width = '0%';
                        detailsEl.textContent = 'Unlimited storage';
                    }

                    // Color coding based on usage
                    barFill.classList.remove('warning', 'danger');
                    if (quota.percent > 90) {
                        barFill.classList.add('danger');
                    } else if (quota.percent > 70) {
                        barFill.classList.add('warning');
                    }
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to get quota from server:', err);
        }

        // Fallback: calculate from loaded files
        let totalBytes = 0;
        let fileCount = 0;

        for (const file of this.files) {
            // Use encrypted_size if available, otherwise size
            const size = file.encrypted_size || file.encryptedSize || file.size || 0;
            totalBytes += size;
            fileCount++;
        }

        // Also count files in subfolders (we may not have them all loaded, so just show current view)
        const formattedSize = Upload.formatSize(totalBytes);
        valueEl.textContent = formattedSize;

        // For the bar, use a soft cap of 10GB for visualization
        const softCap = 10 * 1024 * 1024 * 1024; // 10GB
        const percentage = Math.min((totalBytes / softCap) * 100, 100);
        barFill.style.width = percentage + '%';

        // Color coding based on usage
        barFill.classList.remove('warning', 'danger');
        if (percentage > 90) {
            barFill.classList.add('danger');
        } else if (percentage > 70) {
            barFill.classList.add('warning');
        }

        // Details
        detailsEl.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''} in current folder`;
    },
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
