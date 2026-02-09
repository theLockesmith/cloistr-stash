// Main application

const App = {
    files: [],

    async init() {
        this.setupEventListeners();
        this.setupDragAndDrop();

        // Check server health
        try {
            await API.health();
        } catch (err) {
            UI.toast('Cannot connect to server', 'error');
        }

        // Load files (will be empty until connected)
        await this.loadFiles();
    },

    setupEventListeners() {
        // Login/logout button
        document.getElementById('login-btn').addEventListener('click', () => {
            if (Auth.isConnected) {
                this.disconnect();
            } else {
                this.connect();
            }
        });

        // Upload button
        document.getElementById('upload-btn').addEventListener('click', () => {
            Upload.clear();
            UI.renderUploadList([]);
            UI.showModal('upload-modal');
        });

        // Upload modal close
        document.getElementById('upload-modal-close').addEventListener('click', () => {
            UI.hideModal('upload-modal');
        });

        document.getElementById('upload-cancel').addEventListener('click', () => {
            UI.hideModal('upload-modal');
        });

        // Upload modal drop zone
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

        // Start upload
        document.getElementById('upload-start').addEventListener('click', () => {
            this.startUpload();
        });

        // New folder button (placeholder for now)
        document.getElementById('new-folder-btn').addEventListener('click', () => {
            UI.toast('Folders coming soon', 'info');
        });
    },

    setupDragAndDrop() {
        const dropZone = document.getElementById('drop-zone');

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (Auth.isConnected) {
                dropZone.classList.add('drag-over');
            }
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');

            if (!Auth.isConnected) {
                UI.toast('Please connect first', 'error');
                return;
            }

            Upload.clear();
            Upload.addFiles(e.dataTransfer.files);
            UI.renderUploadList(Upload.files);
            UI.updateUploadButton();
            UI.showModal('upload-modal');
        });
    },

    async connect() {
        try {
            const pubkey = await Auth.connect();
            UI.setConnectedState(pubkey);
            UI.toast('Connected', 'success');
            await this.loadFiles();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    disconnect() {
        Auth.disconnect();
        UI.setConnectedState(null);
        this.files = [];
        UI.renderFileList([]);
        UI.toast('Disconnected', 'info');
    },

    async loadFiles() {
        try {
            const response = await API.listFiles();
            this.files = response.files || [];
            UI.renderFileList(this.files);
        } catch (err) {
            console.error('Failed to load files:', err);
            // Don't show error toast - files will be empty for unauthenticated users
        }
    },

    async startUpload() {
        const startBtn = document.getElementById('upload-start');
        startBtn.disabled = true;
        startBtn.textContent = 'Uploading...';

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
                startBtn.textContent = 'Upload';
                UI.updateUploadButton();

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

    async deleteFile(sha256) {
        try {
            // Create delete auth if connected
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
