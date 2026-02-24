// Main application

const App = {
    files: [],
    folders: [],
    sharedFiles: [],      // Files shared with current user
    currentFolderId: '',  // Empty string = root folder
    folderPath: [],       // Array of {id, name} for breadcrumb navigation
    authState: 'unauthenticated', // 'unauthenticated' | 'authenticated' | 'denied'
    currentView: 'my-files', // 'my-files' | 'shared'
    searchQuery: '',      // Current search query
    shareFile: null,      // File currently being shared

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

        // Try to restore saved session
        if (Auth.hasSavedSession()) {
            console.log('Found saved session, attempting to restore...');
            try {
                const restored = await Auth.restoreSession();
                if (restored) {
                    console.log('Session restored, verifying authorization...');
                    await this.verifyAuthorization();
                }
            } catch (err) {
                console.error('Failed to restore session:', err);
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

        searchInput.addEventListener('input', (e) => {
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

        // Upload modal
        this.setupUploadModal();

        // Share modal
        this.setupShareModal();

        // Preview modal
        this.setupPreviewModal();

        // Mobile menu
        this.setupMobileMenu();
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
    },

    setupDragAndDrop() {
        const fileList = document.getElementById('file-list');

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

            if (this.authState !== 'authenticated') {
                return;
            }

            // Check if dropping on a folder
            const folderItem = e.target.closest('.folder-item');
            if (folderItem) {
                // Upload to specific folder (future feature)
                const folderId = folderItem.dataset.id;
                this.uploadToFolder(e.dataTransfer.files, folderId);
            } else {
                // Upload to current folder
                this.uploadToFolder(e.dataTransfer.files, null);
            }
        });

        // Prevent default drag behavior on document
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
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
        this.renderCurrentView();
    },

    // Filter files based on search query
    filterBySearch(files) {
        if (!this.searchQuery) return files;

        return files.filter(file => {
            const name = (file.name || '').toLowerCase();
            const sha = (file.sha256 || '').toLowerCase();
            return name.includes(this.searchQuery) || sha.includes(this.searchQuery);
        });
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
            const filteredFolders = this.filterFoldersBySearch(this.folders);
            UI.renderFileList(filteredFiles, filteredFolders, this.searchQuery);
        } else {
            const filteredShared = this.filterBySearch(this.sharedFiles);
            UI.renderSharedFiles(filteredShared, this.searchQuery);
        }
    },

    async switchView(view) {
        this.currentView = view;

        // Clear search when switching views
        this.clearSearch();

        // Update tab states
        document.getElementById('tab-my-files').classList.toggle('active', view === 'my-files');
        document.getElementById('tab-shared').classList.toggle('active', view === 'shared');

        // Show/hide appropriate UI elements
        const breadcrumbBar = document.getElementById('breadcrumb-bar');
        const uploadBtn = document.getElementById('upload-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');

        if (view === 'my-files') {
            breadcrumbBar.style.display = '';
            uploadBtn.style.display = '';
            newFolderBtn.style.display = '';
            await this.loadFiles();
        } else {
            breadcrumbBar.style.display = 'none';
            uploadBtn.style.display = 'none';
            newFolderBtn.style.display = 'none';
            await this.loadSharedFiles();
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
            console.log('Auth: Creating status auth header...');
            const authHeader = await Auth.createStatusAuth();
            console.log('Auth: Got auth header, checking status...');
            const result = await API.checkAuthStatus(authHeader);
            console.log('Auth: Status result:', result);

            if (result.authorized) {
                this.authState = 'authenticated';

                // Initialize crypto and key management
                console.log('App: Initializing crypto...');
                await Crypto.init();
                await Keys.init(Auth.pubkey);

                // Initialize search index
                console.log('App: Initializing search...');
                await Search.init(Auth.pubkey);

                // Initialize versioning
                await Versioning.init();

                await this.loadFiles();
                await this.loadFolderTree();
                UI.toast('Connected', 'success');
            } else {
                console.log('Auth: Not authorized. Pubkey:', Auth.pubkey);
                this.authState = 'denied';
                document.getElementById('denied-pubkey').textContent = Auth.pubkey;
            }
        } catch (err) {
            console.error('Auth verification failed:', err);
            this.authState = 'denied';
            document.getElementById('denied-pubkey').textContent = Auth.pubkey;
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
                break;
            case 'authenticated':
                fileExplorer.classList.remove('hidden');
                UI.setConnectedState(Auth.pubkey);
                break;
        }
    },

    async loadFiles() {
        const pubkey = Auth.isConnected ? Auth.pubkey : null;
        if (!pubkey) return;

        // Show loading state
        UI.showLoadingSkeleton();

        try {
            // Load folders and files for current folder
            const [foldersResponse, filesResponse] = await Promise.all([
                API.listFolders(pubkey, this.currentFolderId),
                API.listFilesInFolder(pubkey, this.currentFolderId),
            ]);

            this.folders = foldersResponse.folders || [];
            this.files = filesResponse.files || [];

            this.renderCurrentView();
            this.renderBreadcrumbs();
        } catch (err) {
            console.error('Failed to load files:', err);

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

    async navigateToFolder(folderId, folderName) {
        if (folderId === '') {
            // Going to root
            this.currentFolderId = '';
            this.folderPath = [];
        } else {
            // Add to path
            this.folderPath.push({ id: folderId, name: folderName });
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
                }
                if (failed > 0) {
                    UI.toast(`${failed} file${failed > 1 ? 's' : ''} failed`, 'error');
                }

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

    // Folder tree state
    folderTreeData: [],
    expandedFolders: new Set(),

    // Load folder tree
    async loadFolderTree() {
        if (!Auth.isConnected) return;

        try {
            const result = await API.listFolders(Auth.pubkey);
            this.folderTreeData = result.folders || [];
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
                this.openFolder('', 'My Drive');
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

            // Navigate on item click
            item.addEventListener('click', () => {
                this.openFolder(folderId, folderName);
                this.updateFolderTreeActive(folderId);
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

    async deleteFile(sha256) {
        try {
            let authHeader = null;
            if (Auth.isConnected) {
                authHeader = await Auth.createDeleteAuth(sha256);
            }

            await API.deleteFile(sha256, authHeader);
            UI.toast('File deleted', 'success');
            await this.loadFiles();
        } catch (err) {
            UI.toast(`Delete failed: ${err.message}`, 'error');
        }
    },

    // Download and decrypt a file
    async downloadFile(file) {
        try {
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
                const fileId = file.file_id || file.fileId || file.d;  // Get file ID from metadata
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
    getPreviewType(mimeType) {
        if (!mimeType) return 'unsupported';
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

    // Preview a file
    async showPreview(file) {
        this.previewFile = file;

        // Show modal and loading state
        document.getElementById('preview-file-name').textContent = file.name;
        document.getElementById('preview-loading').classList.remove('hidden');
        document.getElementById('preview-content').classList.add('hidden');

        // Hide all preview types
        document.getElementById('preview-image').classList.add('hidden');
        document.getElementById('preview-text').classList.add('hidden');
        document.getElementById('preview-pdf').classList.add('hidden');
        document.getElementById('preview-video').classList.add('hidden');
        document.getElementById('preview-audio').classList.add('hidden');
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
                const fileId = file.file_id || file.fileId || file.d;
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
            const previewType = this.getPreviewType(mimeType);
            document.getElementById('preview-loading').classList.add('hidden');
            document.getElementById('preview-content').classList.remove('hidden');

            switch (previewType) {
                case 'image':
                    const imgEl = document.getElementById('preview-image');
                    imgEl.src = this.previewBlobUrl;
                    imgEl.classList.remove('hidden');
                    break;

                case 'video':
                    const videoEl = document.getElementById('preview-video');
                    videoEl.src = this.previewBlobUrl;
                    videoEl.classList.remove('hidden');
                    break;

                case 'audio':
                    const audioEl = document.getElementById('preview-audio');
                    audioEl.src = this.previewBlobUrl;
                    audioEl.classList.remove('hidden');
                    break;

                case 'pdf':
                    const pdfEl = document.getElementById('preview-pdf');
                    pdfEl.src = this.previewBlobUrl;
                    pdfEl.classList.remove('hidden');
                    break;

                case 'text':
                    const textEl = document.getElementById('preview-text');
                    const text = new TextDecoder().decode(decryptedData);
                    textEl.textContent = text;
                    textEl.classList.remove('hidden');
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
            const fileId = file.file_id || file.fileId || file.d;

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
        const fileId = file.file_id || file.fileId || file.d;

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
        const fileId = file.file_id || file.fileId || file.d;

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
            const fileId = file.file_id || file.fileId || file.d;
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
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
