// Main application

const App = {
    files: [],
    authState: 'unauthenticated', // 'unauthenticated' | 'authenticated' | 'denied'

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

        // Upload modal
        this.setupUploadModal();
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

        // Re-render file list
        UI.renderFileList(this.files);
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

        if (!bunkerUrl) {
            UI.toast('Please enter a bunker URL', 'error');
            return;
        }

        try {
            UI.hideModal('nip46-modal');
            UI.toast('Connecting to remote signer...', 'info');

            // TODO: Implement NIP-46 connection
            // For now, show a placeholder message
            UI.toast('NIP-46 support coming soon', 'info');

        } catch (err) {
            UI.toast(err.message, 'error');
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
            const response = await API.listFiles(pubkey);
            this.files = response.files || [];
            UI.renderFileList(this.files);
        } catch (err) {
            console.error('Failed to load files:', err);
        }
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
        const name = prompt('Folder name:');
        if (name && name.trim()) {
            // TODO: Implement folder creation
            UI.toast('Folders coming soon', 'info');
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
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
