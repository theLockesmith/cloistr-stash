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

    // Render file list (supports grid and list views)
    renderFileList(files, folders = []) {
        const fileList = document.getElementById('file-list');
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');
        const header = document.querySelector('.file-list-header');

        // Toggle class for view mode
        fileList.classList.toggle('view-grid', this.viewMode === 'grid');
        fileList.classList.toggle('view-list', this.viewMode === 'list');

        // Show/hide header based on view mode
        if (header) {
            header.style.display = this.viewMode === 'list' ? '' : 'none';
        }

        const hasContent = files.length > 0 || folders.length > 0;

        if (!hasContent) {
            body.innerHTML = '';
            body.appendChild(emptyState);
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        if (this.viewMode === 'grid') {
            const folderHtml = folders.map(folder => this.renderFolderGridItem(folder)).join('');
            const fileHtml = files.map(file => this.renderFileGridItem(file)).join('');
            body.innerHTML = folderHtml + fileHtml;
        } else {
            const folderHtml = folders.map(folder => this.renderFolderListItem(folder)).join('');
            const fileHtml = files.map(file => this.renderFileListItem(file)).join('');
            body.innerHTML = folderHtml + fileHtml;
        }

        // Add event listeners
        this.attachFileEventListeners(body);
        this.attachFolderEventListeners(body);
    },

    // Attach event listeners to file items
    attachFileEventListeners(container) {
        container.querySelectorAll('.file-item:not(.folder-item), .grid-item:not(.folder-grid-item)').forEach(item => {
            const sha256 = item.dataset.sha256;
            const fileName = item.dataset.name;
            const fileSize = parseInt(item.dataset.size) || 0;
            const fileMime = item.dataset.mime || '';
            if (!sha256) return;

            item.querySelector('.share-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.showShareModal({
                    sha256,
                    name: fileName,
                    size: fileSize,
                    mimeType: fileMime,
                });
            });

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

            // Context menu on right-click
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showContextMenu(e.clientX, e.clientY, [
                    { label: 'Share', action: () => App.showShareModal({ sha256, name: fileName, size: fileSize, mimeType: fileMime }) },
                    { label: 'Download', action: () => window.open(API.getDownloadURL(sha256), '_blank') },
                    { label: 'Delete', action: () => { if (confirm('Delete this file?')) App.deleteFile(sha256); } },
                ]);
            });
        });
    },

    // Attach event listeners to folder items
    attachFolderEventListeners(container) {
        container.querySelectorAll('.folder-item, .folder-grid-item').forEach(item => {
            const folderId = item.dataset.folderId;
            const folderName = item.dataset.folderName;
            if (!folderId) return;

            // Double-click to open folder
            item.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                App.openFolder(folderId, folderName);
            });

            // Single click also opens (for usability)
            item.addEventListener('click', (e) => {
                if (e.target.closest('.action-btn')) return; // Ignore if clicking action button
                App.openFolder(folderId, folderName);
            });

            item.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.deleteFolder(folderId, folderName);
            });

            // Context menu on right-click
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showContextMenu(e.clientX, e.clientY, [
                    { label: 'Open', action: () => App.openFolder(folderId, folderName) },
                    { label: 'Delete', action: () => App.deleteFolder(folderId, folderName) },
                ]);
            });
        });
    },

    // Render folder as list item
    renderFolderListItem(folder) {
        const date = folder.created_at ? new Date(folder.created_at * 1000).toLocaleDateString() : '-';

        return `
            <div class="file-item folder-item" data-folder-id="${folder.id}" data-folder-name="${this.escapeHtml(folder.name)}">
                <div class="file-col file-name">
                    <span class="file-icon folder-icon">&#128193;</span>
                    <span class="file-name-text">${this.escapeHtml(folder.name)}</span>
                </div>
                <div class="file-col file-size">-</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn delete delete-btn">Delete</button>
                </div>
            </div>
        `;
    },

    // Render folder as grid item
    renderFolderGridItem(folder) {
        return `
            <div class="grid-item folder-grid-item" data-folder-id="${folder.id}" data-folder-name="${this.escapeHtml(folder.name)}">
                <div class="grid-item-icon folder-icon">&#128193;</div>
                <div class="grid-item-name">${this.escapeHtml(folder.name)}</div>
                <div class="grid-item-actions">
                    <button class="action-btn delete delete-btn" title="Delete">✕</button>
                </div>
            </div>
        `;
    },

    // Render file as list item
    renderFileListItem(file) {
        const icon = Upload.getFileIcon(file.mime_type);
        const size = Upload.formatSize(file.size);
        const date = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString() : '-';
        const fileName = file.name || file.sha256.slice(0, 16) + '...';

        return `
            <div class="file-item" data-sha256="${file.sha256}" data-name="${this.escapeHtml(fileName)}" data-size="${file.size}" data-mime="${file.mime_type || ''}">
                <div class="file-col file-name">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name-text">${this.escapeHtml(fileName)}</span>
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn share-btn share-btn" title="Share">Share</button>
                    <button class="action-btn download-btn">Download</button>
                    <button class="action-btn delete delete-btn">Delete</button>
                </div>
            </div>
        `;
    },

    // Render file as grid item
    renderFileGridItem(file) {
        const icon = Upload.getFileIcon(file.mime_type);
        const name = file.name || file.sha256.slice(0, 12) + '...';

        return `
            <div class="grid-item" data-sha256="${file.sha256}" data-name="${this.escapeHtml(name)}" data-size="${file.size}" data-mime="${file.mime_type || ''}">
                <div class="grid-item-icon">${icon}</div>
                <div class="grid-item-name">${this.escapeHtml(name)}</div>
                <div class="grid-item-actions">
                    <button class="action-btn share-btn" title="Share">&#8599;</button>
                    <button class="action-btn download-btn" title="Download">↓</button>
                    <button class="action-btn delete delete-btn" title="Delete">✕</button>
                </div>
            </div>
        `;
    },

    // Show context menu
    showContextMenu(x, y, items) {
        const menu = document.getElementById('context-menu');
        menu.innerHTML = items.map(item =>
            `<div class="context-menu-item">${item.label}</div>`
        ).join('');

        // Position menu
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.remove('hidden');

        // Attach click handlers
        menu.querySelectorAll('.context-menu-item').forEach((el, i) => {
            el.addEventListener('click', () => {
                items[i].action();
                this.hideContextMenu();
            });
        });

        // Hide on click outside
        const hideOnClick = (e) => {
            if (!menu.contains(e.target)) {
                this.hideContextMenu();
                document.removeEventListener('click', hideOnClick);
            }
        };
        setTimeout(() => document.addEventListener('click', hideOnClick), 0);
    },

    // Hide context menu
    hideContextMenu() {
        document.getElementById('context-menu').classList.add('hidden');
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

    // View mode (list or grid)
    viewMode: 'list',

    // Set connected state in file explorer header
    setConnectedState(pubkey) {
        const pubkeySpan = document.getElementById('user-pubkey');
        const uploadBtn = document.getElementById('upload-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');

        if (pubkey) {
            pubkeySpan.textContent = Auth.formatPubkey(pubkey);
            if (uploadBtn) uploadBtn.disabled = false;
            if (newFolderBtn) newFolderBtn.disabled = false;
        } else {
            pubkeySpan.textContent = '';
            if (uploadBtn) uploadBtn.disabled = true;
            if (newFolderBtn) newFolderBtn.disabled = true;
        }
    },

    // Escape HTML to prevent XSS
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    // Render shared files list
    renderSharedFiles(files) {
        const fileList = document.getElementById('file-list');
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');
        const header = document.querySelector('.file-list-header');

        // Toggle class for view mode
        fileList.classList.toggle('view-grid', this.viewMode === 'grid');
        fileList.classList.toggle('view-list', this.viewMode === 'list');

        // Show/hide header based on view mode
        if (header) {
            header.style.display = this.viewMode === 'list' ? '' : 'none';
        }

        if (files.length === 0) {
            body.innerHTML = '';
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-state';
            emptyDiv.innerHTML = '<p>No shared files</p><p class="empty-state-subtext">Files shared with you will appear here</p>';
            body.appendChild(emptyDiv);
            return;
        }

        if (this.viewMode === 'grid') {
            body.innerHTML = files.map(file => this.renderSharedFileGridItem(file)).join('');
        } else {
            body.innerHTML = files.map(file => this.renderSharedFileListItem(file)).join('');
        }

        // Add event listeners
        this.attachSharedFileEventListeners(body);
    },

    // Render shared file as list item
    renderSharedFileListItem(file) {
        const icon = file.encrypted ? '&#128274;' : Upload.getFileIcon(file.mime_type);
        const size = file.size ? Upload.formatSize(file.size) : '-';
        const date = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString() : '-';
        const ownerShort = file.owner_pubkey ? file.owner_pubkey.slice(0, 8) + '...' : '';

        return `
            <div class="file-item shared-item" data-sha256="${file.sha256 || ''}" data-url="${file.url || ''}" data-encrypted="${file.encrypted || false}">
                <div class="file-col file-name">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name-text">${this.escapeHtml(file.name)}</span>
                    <span class="shared-by">from ${ownerShort}</span>
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn download-btn" ${file.encrypted ? 'disabled' : ''}>Download</button>
                </div>
            </div>
        `;
    },

    // Render shared file as grid item
    renderSharedFileGridItem(file) {
        const icon = file.encrypted ? '&#128274;' : Upload.getFileIcon(file.mime_type);
        const name = file.name || '(Encrypted)';

        return `
            <div class="grid-item shared-item" data-sha256="${file.sha256 || ''}" data-url="${file.url || ''}" data-encrypted="${file.encrypted || false}">
                <div class="grid-item-icon">${icon}</div>
                <div class="grid-item-name">${this.escapeHtml(name)}</div>
                <div class="grid-item-actions">
                    <button class="action-btn download-btn" title="Download" ${file.encrypted ? 'disabled' : ''}>↓</button>
                </div>
            </div>
        `;
    },

    // Attach event listeners to shared file items
    attachSharedFileEventListeners(container) {
        container.querySelectorAll('.shared-item').forEach(item => {
            const url = item.dataset.url;
            const encrypted = item.dataset.encrypted === 'true';

            if (!encrypted && url) {
                item.querySelector('.download-btn')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.open(url, '_blank');
                });
            }
        });
    },
};
