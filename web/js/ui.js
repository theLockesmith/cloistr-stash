// UI helper functions

const UI = {
    // Show a toast notification
    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.remove();
        }, 4000);
    },

    // Show/hide modal
    showModal(id) {
        document.getElementById(id).classList.remove('hidden');
    },

    hideModal(id) {
        document.getElementById(id).classList.add('hidden');
    },

    // Render file list
    renderFileList(files) {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        if (files.length === 0) {
            body.innerHTML = '';
            body.appendChild(emptyState);
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        body.innerHTML = files.map(file => this.renderFileItem(file)).join('');

        // Add event listeners
        body.querySelectorAll('.file-item').forEach(item => {
            const sha256 = item.dataset.sha256;

            item.querySelector('.download-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(API.getDownloadURL(sha256), '_blank');
            });

            item.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this file?')) {
                    App.deleteFile(sha256);
                }
            });
        });
    },

    // Render a single file item
    renderFileItem(file) {
        const icon = Upload.getFileIcon(file.mime_type);
        const size = Upload.formatSize(file.size);
        const date = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString() : '-';

        return `
            <div class="file-item" data-sha256="${file.sha256}">
                <div class="file-col file-name">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name-text">${this.escapeHtml(file.name || file.sha256.slice(0, 16) + '...')}</span>
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn download-btn">Download</button>
                    <button class="action-btn delete delete-btn">Delete</button>
                </div>
            </div>
        `;
    },

    // Render upload list in modal
    renderUploadList(items) {
        const list = document.getElementById('upload-list');

        if (items.length === 0) {
            list.innerHTML = '';
            return;
        }

        list.innerHTML = items.map(item => this.renderUploadItem(item)).join('');

        // Add remove buttons
        list.querySelectorAll('.upload-item-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                Upload.removeFile(id);
                this.renderUploadList(Upload.files);
                this.updateUploadButton();
            });
        });
    },

    // Render a single upload item
    renderUploadItem(item) {
        const statusClass = item.status;
        let statusText = '';

        switch (item.status) {
            case 'pending':
                statusText = 'Pending';
                break;
            case 'hashing':
                statusText = 'Hashing...';
                break;
            case 'uploading':
                statusText = 'Uploading...';
                break;
            case 'success':
                statusText = 'Done';
                break;
            case 'error':
                statusText = item.error || 'Failed';
                break;
        }

        const removeBtn = item.status === 'pending' || item.status === 'error'
            ? `<button class="upload-item-remove" data-id="${item.id}">&times;</button>`
            : '';

        return `
            <div class="upload-item" data-id="${item.id}">
                <span class="upload-item-name">${this.escapeHtml(item.file.name)}</span>
                <span class="upload-item-size">${Upload.formatSize(item.file.size)}</span>
                <span class="upload-item-status ${statusClass}">${statusText}</span>
                ${removeBtn}
            </div>
        `;
    },

    // Update upload button state
    updateUploadButton() {
        const btn = document.getElementById('upload-start');
        const hasPending = Upload.files.some(f => f.status === 'pending');
        btn.disabled = !hasPending || Upload.isUploading;
    },

    // Set connected state
    setConnectedState(pubkey) {
        const loginBtn = document.getElementById('login-btn');
        const pubkeySpan = document.getElementById('user-pubkey');
        const uploadBtn = document.getElementById('upload-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');

        if (pubkey) {
            loginBtn.textContent = 'Disconnect';
            pubkeySpan.textContent = Auth.formatPubkey(pubkey);
            uploadBtn.disabled = false;
            newFolderBtn.disabled = false;
        } else {
            loginBtn.textContent = 'Connect';
            pubkeySpan.textContent = '';
            uploadBtn.disabled = true;
            newFolderBtn.disabled = true;
        }
    },

    // Escape HTML to prevent XSS
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
