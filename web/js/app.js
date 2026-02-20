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
        // Check server health first
        try {
            await API.health();
        } catch (err) {
            UI.toast('Cannot connect to server', 'error');
        }

        // Setup event listeners
        this.setupEventListeners();
        this.setupDragAndDrop();

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

    handleSearch(query) {
        this.searchQuery = query.toLowerCase().trim();

        // Show/hide clear button
        const searchClear = document.getElementById('search-clear');
        searchClear.classList.toggle('hidden', !this.searchQuery);

        // Re-render with filter
        this.renderCurrentView();
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

            for (const share of shares) {
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
            const authHeader = await Auth.createStatusAuth();
            const result = await API.checkAuthStatus(authHeader);

            if (result.authorized) {
                this.authState = 'authenticated';
                await this.loadFiles();
                UI.toast('Connected', 'success');
            } else {
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
        Auth.disconnect();
        this.authState = 'unauthenticated';
        this.files = [];
        this.folders = [];
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
        try {
            const pubkey = Auth.isConnected ? Auth.pubkey : null;
            if (!pubkey) return;

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

    async promptNewFolder() {
        const name = prompt('Folder name:');
        if (!name || !name.trim()) {
            return;
        }

        try {
            // Generate a unique folder ID
            const folderId = Auth.generateFolderId();

            // Create and sign the folder event
            const signedEvent = await Auth.createFolderEvent({
                id: folderId,
                name: name.trim(),
                parentId: this.currentFolderId || null,
            });

            // Publish to server
            await API.createFolder(signedEvent);

            UI.toast(`Created folder "${name.trim()}"`, 'success');

            // Reload to show new folder
            await this.loadFiles();
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

            // Send to server
            await API.deleteFolder(folderId, signedEvent);

            UI.toast(`Deleted folder "${folderName}"`, 'success');

            // Reload to update view
            await this.loadFiles();
        } catch (err) {
            console.error('Failed to delete folder:', err);
            UI.toast(`Failed to delete folder: ${err.message}`, 'error');
        }
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

    showShareModal(file) {
        this.shareFile = file;

        // Update modal content
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

            // Create and sign the share event
            const signedEvent = await Auth.createShareEvent({
                id: shareId,
                fileId: this.shareFile.sha256,
                fileName: this.shareFile.name,
                fileSize: this.shareFile.size,
                fileMimeType: this.shareFile.mimeType,
                fileSHA256: this.shareFile.sha256,
                fileURL: API.getDownloadURL(this.shareFile.sha256),
                recipientPubkey: recipientPubkey,
                message: message,
                permission: 'download',
            });

            // Publish share
            await API.createShare(signedEvent);

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
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
