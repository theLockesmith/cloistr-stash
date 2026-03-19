// UI helper functions

const UI = {
    // Thumbnail cache
    thumbnailCache: new Map(),
    thumbnailDB: null,
    THUMBNAIL_SIZE: 48,
    THUMBNAIL_DB_NAME: 'cloistr-thumbnails',

    // Folder customization storage
    folderCustomizations: {},
    FOLDER_STORAGE_KEY: 'cloistr-folder-customizations',

    // Available folder colors
    folderColors: [
        { name: 'Default', value: null },
        { name: 'Red', value: '#ef4444' },
        { name: 'Orange', value: '#f97316' },
        { name: 'Yellow', value: '#eab308' },
        { name: 'Green', value: '#22c55e' },
        { name: 'Teal', value: '#14b8a6' },
        { name: 'Blue', value: '#3b82f6' },
        { name: 'Purple', value: '#8b5cf6' },
        { name: 'Pink', value: '#ec4899' },
    ],

    // Available folder icons
    folderIcons: [
        { name: 'Default', value: '📁', code: '&#128193;' },
        { name: 'Open', value: '📂', code: '&#128194;' },
        { name: 'Star', value: '⭐', code: '&#11088;' },
        { name: 'Heart', value: '❤️', code: '&#10084;' },
        { name: 'Work', value: '💼', code: '&#128188;' },
        { name: 'Music', value: '🎵', code: '&#127925;' },
        { name: 'Camera', value: '📷', code: '&#128247;' },
        { name: 'Video', value: '🎬', code: '&#127916;' },
        { name: 'Book', value: '📚', code: '&#128218;' },
        { name: 'Code', value: '💻', code: '&#128187;' },
        { name: 'Game', value: '🎮', code: '&#127918;' },
        { name: 'Lock', value: '🔒', code: '&#128274;' },
    ],

    // Load folder customizations from localStorage
    loadFolderCustomizations() {
        try {
            const stored = localStorage.getItem(this.FOLDER_STORAGE_KEY);
            this.folderCustomizations = stored ? JSON.parse(stored) : {};
        } catch (e) {
            this.folderCustomizations = {};
        }
    },

    // Save folder customizations to localStorage
    saveFolderCustomizations() {
        try {
            localStorage.setItem(this.FOLDER_STORAGE_KEY, JSON.stringify(this.folderCustomizations));
        } catch (e) {
            console.error('Failed to save folder customizations:', e);
        }
    },

    // Get customization for a specific folder
    getFolderCustomization(folderId) {
        return this.folderCustomizations[folderId] || { color: null, icon: null };
    },

    // Set customization for a folder
    setFolderCustomization(folderId, color, icon) {
        if (color === null && icon === null) {
            delete this.folderCustomizations[folderId];
        } else {
            this.folderCustomizations[folderId] = { color, icon };
        }
        this.saveFolderCustomizations();
    },

    // Virtual scrolling configuration
    virtualScroll: {
        enabled: false,
        items: [],
        itemHeight: 48,  // Height of each row
        bufferSize: 10,  // Extra items above/below viewport
        scrollTop: 0,
        containerHeight: 0,
        threshold: 100,  // Enable virtual scroll when > 100 items
    },

    // Initialize virtual scrolling for a container
    initVirtualScroll(container, items, renderItem) {
        const vs = this.virtualScroll;
        vs.items = items;
        vs.enabled = items.length > vs.threshold;

        if (!vs.enabled) return false;

        vs.containerHeight = container.clientHeight;

        // Create wrapper elements
        const wrapper = document.createElement('div');
        wrapper.className = 'virtual-scroll-wrapper';
        wrapper.style.height = `${items.length * vs.itemHeight}px`;
        wrapper.style.position = 'relative';

        const viewport = document.createElement('div');
        viewport.className = 'virtual-scroll-viewport';
        viewport.style.position = 'absolute';
        viewport.style.left = '0';
        viewport.style.right = '0';

        wrapper.appendChild(viewport);
        container.innerHTML = '';
        container.appendChild(wrapper);

        // Render visible items
        this.updateVirtualScroll(container, renderItem);

        // Add scroll listener
        container.addEventListener('scroll', () => {
            vs.scrollTop = container.scrollTop;
            this.updateVirtualScroll(container, renderItem);
        });

        return true;
    },

    // Update visible items in virtual scroll
    updateVirtualScroll(container, renderItem) {
        const vs = this.virtualScroll;
        if (!vs.enabled) return;

        const viewport = container.querySelector('.virtual-scroll-viewport');
        if (!viewport) return;

        const startIndex = Math.max(0, Math.floor(vs.scrollTop / vs.itemHeight) - vs.bufferSize);
        const endIndex = Math.min(
            vs.items.length,
            Math.ceil((vs.scrollTop + vs.containerHeight) / vs.itemHeight) + vs.bufferSize
        );

        // Position viewport
        viewport.style.top = `${startIndex * vs.itemHeight}px`;

        // Render only visible items
        const visibleItems = vs.items.slice(startIndex, endIndex);
        const html = visibleItems.map((item, i) => renderItem(item, startIndex + i)).join('');
        viewport.innerHTML = html;

        // Reattach event listeners
        this.attachFileEventListeners(viewport);
        this.attachFolderEventListeners(viewport);
    },

    // Initialize thumbnail cache
    async initThumbnails() {
        try {
            const request = indexedDB.open(this.THUMBNAIL_DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('thumbnails')) {
                    db.createObjectStore('thumbnails', { keyPath: 'sha256' });
                }
            };
            request.onsuccess = (e) => {
                this.thumbnailDB = e.target.result;
            };
        } catch (err) {
            console.warn('Thumbnail DB init failed:', err);
        }
    },

    // Get cached thumbnail
    async getThumbnail(sha256) {
        // Check memory cache
        if (this.thumbnailCache.has(sha256)) {
            return this.thumbnailCache.get(sha256);
        }

        // Check IndexedDB
        if (this.thumbnailDB) {
            try {
                const tx = this.thumbnailDB.transaction('thumbnails', 'readonly');
                const store = tx.objectStore('thumbnails');
                const result = await new Promise((resolve, reject) => {
                    const req = store.get(sha256);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                if (result?.dataUrl) {
                    this.thumbnailCache.set(sha256, result.dataUrl);
                    return result.dataUrl;
                }
            } catch (err) {
                // Ignore cache errors
            }
        }
        return null;
    },

    // Store thumbnail
    async storeThumbnail(sha256, dataUrl) {
        this.thumbnailCache.set(sha256, dataUrl);

        if (this.thumbnailDB) {
            try {
                const tx = this.thumbnailDB.transaction('thumbnails', 'readwrite');
                const store = tx.objectStore('thumbnails');
                store.put({ sha256, dataUrl, createdAt: Date.now() });
            } catch (err) {
                // Ignore storage errors
            }
        }
    },

    // Generate thumbnail from image data
    async generateThumbnail(imageData, mimeType) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([imageData], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const img = new Image();

            img.onload = () => {
                // Calculate thumbnail dimensions
                let width = this.THUMBNAIL_SIZE;
                let height = this.THUMBNAIL_SIZE;

                if (img.width > img.height) {
                    height = (img.height / img.width) * width;
                } else {
                    width = (img.width / img.height) * height;
                }

                // Draw to canvas
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Convert to data URL
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

                URL.revokeObjectURL(url);
                resolve(dataUrl);
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image'));
            };

            img.src = url;
        });
    },

    // Load thumbnail for a file (async, updates DOM when ready)
    async loadThumbnail(file, imgElement) {
        const mimeType = file.mime_type || '';
        if (!mimeType.startsWith('image/')) return;

        const sha256 = file.sha256;

        // Check cache first
        const cached = await this.getThumbnail(sha256);
        if (cached) {
            imgElement.src = cached;
            imgElement.classList.add('loaded');
            return;
        }

        // Download and decrypt the image
        try {
            const data = await App.downloadFileData(file);
            if (data) {
                const dataUrl = await this.generateThumbnail(data, mimeType);
                await this.storeThumbnail(sha256, dataUrl);
                imgElement.src = dataUrl;
                imgElement.classList.add('loaded');
            }
        } catch (err) {
            console.warn('Thumbnail generation failed:', err);
        }
    },

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

    // Show login progress indicator on landing page
    showLoginProgress(message) {
        let indicator = document.getElementById('login-progress');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'login-progress';
            indicator.className = 'login-progress';
            const landingPage = document.getElementById('landing-page');
            if (landingPage) {
                landingPage.appendChild(indicator);
            }
        }
        indicator.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
        indicator.classList.remove('hidden');
    },

    hideLoginProgress() {
        const indicator = document.getElementById('login-progress');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    },

    // Show/hide modal
    showModal(id) {
        document.getElementById(id).classList.remove('hidden');
    },

    hideModal(id) {
        document.getElementById(id).classList.add('hidden');
    },

    // Hide all open modals
    hideAllModals() {
        document.querySelectorAll('.modal:not(.hidden)').forEach(modal => {
            modal.classList.add('hidden');
        });
        this.hideContextMenu();
    },

    // Show loading skeleton in file list
    showLoadingSkeleton(count = 5) {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        if (emptyState) emptyState.classList.add('hidden');

        const skeletons = [];
        for (let i = 0; i < count; i++) {
            skeletons.push(`
                <div class="skeleton-row">
                    <div class="skeleton skeleton-icon"></div>
                    <div class="skeleton skeleton-text"></div>
                    <div class="skeleton skeleton-text-short"></div>
                    <div class="skeleton skeleton-text-short"></div>
                </div>
            `);
        }

        body.innerHTML = skeletons.join('');
    },

    // Show error state in file list
    showErrorState(message, onRetry = null) {
        const body = document.getElementById('file-list-body');
        const emptyState = document.getElementById('empty-state');

        if (emptyState) emptyState.classList.add('hidden');

        body.innerHTML = `
            <div class="error-state">
                <div class="error-state-icon">&#9888;</div>
                <p>${this.escapeHtml(message)}</p>
                ${onRetry ? '<button class="btn retry-btn">Retry</button>' : ''}
            </div>
        `;

        if (onRetry) {
            body.querySelector('.retry-btn')?.addEventListener('click', onRetry);
        }
    },

    // Render file list (supports grid and list views)
    renderFileList(files, folders = [], searchQuery = '') {
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

        // Build content
        let html = '';

        // Show search results info if searching
        if (searchQuery) {
            const totalResults = files.length + folders.length;
            html += `<div class="search-results-info">Found ${totalResults} result${totalResults !== 1 ? 's' : ''} for "${this.escapeHtml(searchQuery)}"</div>`;
        }

        if (!hasContent) {
            body.innerHTML = html;
            if (searchQuery) {
                body.innerHTML += '<div class="empty-state"><p>No matches found</p></div>';
            } else if (emptyState) {
                body.appendChild(emptyState);
                emptyState.style.display = 'block';
            } else {
                body.innerHTML += '<div class="empty-state"><p>No files yet</p><p class="empty-state-subtext">Drag files here or click Upload to get started</p></div>';
            }
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        // Combine folders and files for rendering
        const allItems = [
            ...folders.map(f => ({ ...f, _type: 'folder' })),
            ...files.map(f => ({ ...f, _type: 'file' }))
        ];

        if (this.viewMode === 'grid') {
            const folderHtml = folders.map(folder => this.renderFolderGridItem(folder)).join('');
            const fileHtml = files.map(file => this.renderFileGridItem(file)).join('');
            html += '<div class="grid-container">' + folderHtml + fileHtml + '</div>';
            body.innerHTML = html;
            this.attachFileEventListeners(body);
            this.attachFolderEventListeners(body);
            return;
        }

        // List view - use virtual scrolling if many items
        if (allItems.length > this.virtualScroll.threshold) {
            body.innerHTML = html; // Add search info if present

            const renderItem = (item) => {
                if (item._type === 'folder') {
                    return this.renderFolderListItem(item);
                } else {
                    return this.renderFileListItem(item);
                }
            };

            this.initVirtualScroll(body, allItems, renderItem);
            return;
        }

        // Normal rendering for small lists
        const folderHtml = folders.map(folder => this.renderFolderListItem(folder)).join('');
        const fileHtml = files.map(file => this.renderFileListItem(file)).join('');
        html += folderHtml + fileHtml;

        body.innerHTML = html;

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
            const fileId = item.dataset.fileId || '';
            const folderId = item.dataset.folderId || '';
            const isEncrypted = item.dataset.encrypted === 'true';
            if (!sha256) return;

            // Build file object for download
            const fileObj = {
                sha256,
                name: fileName,
                size: fileSize,
                mime_type: fileMime,
                file_id: fileId,
                folder_id: folderId,
                encrypted: isEncrypted,
            };

            // Checkbox for batch selection
            const checkbox = item.querySelector('.file-checkbox');
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    App.toggleFileSelection(sha256);
                });

                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent row click
                });
            }

            // Drag and drop for moving files
            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', sha256);
                e.dataTransfer.setData('application/x-cloistr-file', JSON.stringify(fileObj));
                e.dataTransfer.effectAllowed = 'move';
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

            // Load thumbnail for images
            const thumbnail = item.querySelector('.file-thumbnail');
            if (thumbnail && fileMime.startsWith('image/')) {
                this.loadThumbnail(fileObj, thumbnail);
            }

            // Star button
            item.querySelector('.star-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.toggleStar(sha256);
            });

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
                App.downloadFile(fileObj);
            });

            item.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this file?')) {
                    App.deleteFile(sha256);
                }
            });

            // History button
            item.querySelector('.history-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.showVersionHistory(fileObj);
            });

            // Public link button
            item.querySelector('.link-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.showPublicLinkModal(fileObj);
            });

            // Edit button (for text files)
            item.querySelector('.edit-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.openEditor(fileObj);
            });

            // Preview button
            item.querySelector('.preview-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.showPreview(fileObj);
            });

            // Context menu on right-click
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showFileContextMenu(e.clientX, e.clientY, fileObj, fileMime);
            });

            // Touch: Long press for context menu
            let longPressTimer = null;
            let touchStartX = 0;
            let touchStartY = 0;

            item.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;

                longPressTimer = setTimeout(() => {
                    // Vibrate for haptic feedback if available
                    if (navigator.vibrate) navigator.vibrate(50);
                    this.showFileContextMenu(touch.clientX, touch.clientY, fileObj, fileMime);
                }, 500);

                item.classList.add('touch-active');
            }, { passive: true });

            item.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const dx = touch.clientX - touchStartX;
                const dy = touch.clientY - touchStartY;

                // Cancel long press if moved too much
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }

                // Swipe gesture detection
                if (Math.abs(dx) > 50 && Math.abs(dy) < 30) {
                    clearTimeout(longPressTimer);
                    if (dx < -50) {
                        // Swipe left - show quick actions
                        item.classList.add('swipe-left');
                    } else if (dx > 50) {
                        // Swipe right - close quick actions
                        item.classList.remove('swipe-left');
                    }
                }
            }, { passive: true });

            item.addEventListener('touchend', () => {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                item.classList.remove('touch-active');
            }, { passive: true });

            item.addEventListener('touchcancel', () => {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                item.classList.remove('touch-active');
                item.classList.remove('swipe-left');
            }, { passive: true });
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

            // Customize button
            item.querySelector('.customize-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                App.showFolderCustomizeModal(folderId, folderName);
            });

            // Drop target for moving files into folder
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                item.classList.add('drag-target');
            });
            item.addEventListener('dragleave', (e) => {
                if (!item.contains(e.relatedTarget)) {
                    item.classList.remove('drag-target');
                }
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-target');
                const fileData = e.dataTransfer.getData('application/x-cloistr-file');
                if (fileData) {
                    try {
                        const file = JSON.parse(fileData);
                        App.moveFileToFolder(file, folderId, folderName);
                    } catch (err) {
                        console.error('Drop failed:', err);
                    }
                }
            });

            // Context menu on right-click
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const folder = App.folders.find(f => f.id === folderId) || { id: folderId, name: folderName };
                this.showContextMenu(e.clientX, e.clientY, [
                    { label: 'Open', action: () => App.openFolder(folderId, folderName) },
                    { label: 'Rename', action: () => App.renameFolder(folderId, folderName) },
                    { label: 'Customize', action: () => App.showFolderCustomizeModal(folderId, folderName) },
                    { label: 'Share', action: () => App.showShareFolderModal(folder) },
                    { label: 'Delete', action: () => App.deleteFolder(folderId, folderName), className: 'danger' },
                ]);
            });
        });
    },

    // Render folder as list item
    renderFolderListItem(folder) {
        const date = folder.created_at ? new Date(folder.created_at * 1000).toLocaleDateString() : '-';
        const custom = this.getFolderCustomization(folder.id);
        const icon = custom.icon || '&#128193;';
        const colorStyle = custom.color ? `style="color: ${custom.color}"` : '';

        return `
            <div class="file-item folder-item" data-folder-id="${folder.id}" data-folder-name="${this.escapeHtml(folder.name)}" role="listitem" tabindex="0" aria-label="Folder: ${this.escapeHtml(folder.name)}">
                <div class="file-col file-name">
                    <span class="file-icon folder-icon" ${colorStyle} aria-hidden="true">${icon}</span>
                    <span class="file-name-text">${this.escapeHtml(folder.name)}</span>
                </div>
                <div class="file-col file-size" aria-hidden="true">-</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn customize customize-btn" aria-label="Customize folder ${this.escapeHtml(folder.name)}">&#127912;</button>
                    <button class="action-btn delete delete-btn" aria-label="Delete folder ${this.escapeHtml(folder.name)}">Delete</button>
                </div>
            </div>
        `;
    },

    // Render folder as grid item
    renderFolderGridItem(folder) {
        const custom = this.getFolderCustomization(folder.id);
        const icon = custom.icon || '&#128193;';
        const colorStyle = custom.color ? `style="color: ${custom.color}"` : '';

        return `
            <div class="grid-item folder-grid-item" data-folder-id="${folder.id}" data-folder-name="${this.escapeHtml(folder.name)}" role="listitem" tabindex="0" aria-label="Folder: ${this.escapeHtml(folder.name)}">
                <div class="grid-item-icon folder-icon" ${colorStyle} aria-hidden="true">${icon}</div>
                <div class="grid-item-name">${this.escapeHtml(folder.name)}</div>
                <div class="grid-item-actions">
                    <button class="action-btn customize customize-btn" title="Customize" aria-label="Customize folder ${this.escapeHtml(folder.name)}">&#127912;</button>
                    <button class="action-btn delete delete-btn" title="Delete" aria-label="Delete folder ${this.escapeHtml(folder.name)}">✕</button>
                </div>
            </div>
        `;
    },

    // Render file as list item
    renderFileListItem(file) {
        const isEncrypted = file.encrypted || file.encryption;
        const mimeType = file.mime_type || '';
        const isImage = mimeType.startsWith('image/');
        const icon = isEncrypted ? '&#128274;' : Upload.getFileIcon(mimeType);
        const size = Upload.formatSize(file.size);
        const date = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString() : '-';
        const fileName = file.name || file.sha256.slice(0, 16) + '...';
        const fileId = file.file_id || file.fileId || file.d || '';
        const folderId = file.folder_id || file.folderId || file.folder || '';
        const encryptedClass = isEncrypted ? 'encrypted-file' : '';
        const isEditable = Collaboration.isCollaborativeFileType(mimeType);
        const isPreviewable = typeof App !== 'undefined' && App.isPreviewable ? App.isPreviewable(mimeType) : false;

        const isSelected = typeof App !== 'undefined' && App.selectedFiles?.has(file.sha256);
        const isStarred = typeof App !== 'undefined' && App.starredFiles?.has(file.sha256);

        // For images, use a thumbnail placeholder
        const iconHtml = isImage
            ? `<img class="file-thumbnail" data-sha256="${file.sha256}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect fill='%23333' width='24' height='24'/%3E%3C/svg%3E" alt="${this.escapeHtml(fileName)} thumbnail">`
            : `<span class="file-icon" aria-hidden="true">${icon}</span>`;

        const encryptedLabel = isEncrypted ? ', encrypted' : '';
        const starredLabel = isStarred ? ', starred' : '';

        return `
            <div class="file-item ${encryptedClass} ${isSelected ? 'selected' : ''}" data-sha256="${file.sha256}" data-name="${this.escapeHtml(fileName)}" data-size="${file.size}" data-mime="${mimeType}" data-file-id="${fileId}" data-folder-id="${folderId}" data-encrypted="${isEncrypted || false}" role="listitem" tabindex="0" aria-label="${this.escapeHtml(fileName)}, ${size}${encryptedLabel}${starredLabel}" aria-selected="${isSelected}">
                <div class="file-col file-select">
                    <input type="checkbox" class="file-checkbox" data-sha256="${file.sha256}" ${isSelected ? 'checked' : ''} aria-label="Select ${this.escapeHtml(fileName)}">
                </div>
                <div class="file-col file-name">
                    <button class="star-btn ${isStarred ? 'starred' : ''}" title="${isStarred ? 'Remove from starred' : 'Add to starred'}" aria-label="${isStarred ? 'Remove from starred' : 'Add to starred'}" aria-pressed="${isStarred}">${isStarred ? '&#9733;' : '&#9734;'}</button>
                    ${iconHtml}
                    <span class="file-name-text">${this.escapeHtml(fileName)}</span>
                    ${isEncrypted ? '<span class="encrypted-badge" title="End-to-end encrypted with XChaCha20-Poly1305. Only you can decrypt this file." aria-label="End-to-end encrypted">E2E</span>' : ''}
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions" role="group" aria-label="File actions">
                    ${isPreviewable ? `<button class="action-btn preview-btn" title="Preview" aria-label="Preview ${this.escapeHtml(fileName)}">Preview</button>` : ''}
                    ${isEditable ? `<button class="action-btn edit-btn" title="Edit" aria-label="Edit ${this.escapeHtml(fileName)}">Edit</button>` : ''}
                    <button class="action-btn history-btn" title="Version History" aria-label="View version history">History</button>
                    <button class="action-btn link-btn" title="Public Link" aria-label="Create public link">Link</button>
                    <button class="action-btn share-btn" title="Share" aria-label="Share file">Share</button>
                    <button class="action-btn download-btn" aria-label="Download ${this.escapeHtml(fileName)}">Download</button>
                    <button class="action-btn delete delete-btn" aria-label="Move ${this.escapeHtml(fileName)} to trash">Delete</button>
                </div>
            </div>
        `;
    },

    // Render file as grid item
    renderFileGridItem(file) {
        const isEncrypted = file.encrypted || file.encryption;
        const icon = isEncrypted ? '&#128274;' : Upload.getFileIcon(file.mime_type);
        const name = file.name || file.sha256.slice(0, 12) + '...';
        const fileId = file.file_id || file.fileId || file.d || '';
        const folderId = file.folder_id || file.folderId || file.folder || '';
        const encryptedClass = isEncrypted ? 'encrypted-file' : '';
        const mimeType = file.mime_type || '';
        const isEditable = Collaboration.isCollaborativeFileType(mimeType);
        const isPreviewable = typeof App !== 'undefined' && App.isPreviewable ? App.isPreviewable(mimeType) : false;

        return `
            <div class="grid-item ${encryptedClass}" data-sha256="${file.sha256}" data-name="${this.escapeHtml(name)}" data-size="${file.size}" data-mime="${mimeType}" data-file-id="${fileId}" data-folder-id="${folderId}" data-encrypted="${isEncrypted || false}">
                <div class="grid-item-icon">${icon}</div>
                <div class="grid-item-name">${this.escapeHtml(name)}</div>
                ${isEncrypted ? '<span class="encrypted-badge" title="End-to-end encrypted with XChaCha20-Poly1305. Only you can decrypt this file.">E2E</span>' : ''}
                <div class="grid-item-actions">
                    ${isPreviewable ? '<button class="action-btn preview-btn" title="Preview">&#128065;</button>' : ''}
                    ${isEditable ? '<button class="action-btn edit-btn" title="Edit">&#9998;</button>' : ''}
                    <button class="action-btn history-btn" title="History">&#128337;</button>
                    <button class="action-btn link-btn" title="Link">&#128279;</button>
                    <button class="action-btn share-btn" title="Share">&#8599;</button>
                    <button class="action-btn download-btn" title="Download">↓</button>
                    <button class="action-btn delete delete-btn" title="Delete">✕</button>
                </div>
            </div>
        `;
    },

    // Show context menu
    // Show context menu for a file
    showFileContextMenu(x, y, fileObj, fileMime) {
        const menuItems = [];
        const isStarred = App.starredFiles?.has(fileObj.sha256);

        // Star/unstar option
        menuItems.push({
            label: isStarred ? 'Remove from Starred' : 'Add to Starred',
            action: () => App.toggleStar(fileObj.sha256)
        });

        // Rename option
        menuItems.push({ label: 'Rename', action: () => App.renameFile(fileObj) });

        // Tags option
        menuItems.push({ label: 'Tags...', action: () => App.showTagsModal(fileObj) });

        // Comments option
        const commentCount = App.getCommentCount(fileObj.sha256);
        const commentsLabel = commentCount > 0 ? `Comments (${commentCount})` : 'Comments...';
        menuItems.push({ label: commentsLabel, action: () => App.showCommentsModal(fileObj) });

        // Add preview option for previewable files
        if (App.isPreviewable(fileMime)) {
            menuItems.push({ label: 'Preview', action: () => App.showPreview(fileObj) });
        }

        menuItems.push({ label: 'Download', action: () => App.downloadFile(fileObj) });
        menuItems.push({ label: 'Share', action: () => App.showShareModal({ sha256: fileObj.sha256, name: fileObj.name, size: fileObj.size, mimeType: fileMime }) });
        menuItems.push({ label: 'Public Link', action: () => App.showPublicLinkModal(fileObj) });
        menuItems.push({ label: 'Manage Shares', action: () => App.showManageSharesModal(fileObj) });
        menuItems.push({ label: 'Version History', action: () => App.showVersionHistory(fileObj) });

        // Add encryption info option for encrypted files
        const isEncrypted = fileObj.encrypted || fileObj.encryption || fileObj.encryption_mode === 'e2e';
        if (isEncrypted) {
            menuItems.push({ label: 'Encryption Info', action: () => App.showEncryptionInfo(fileObj) });
        }

        // Add edit option for text files
        if (Collaboration.isCollaborativeFileType(fileMime)) {
            menuItems.push({ label: 'Edit', action: () => App.openEditor(fileObj) });
        }

        menuItems.push({ label: 'Move to Trash', action: () => App.deleteFile(fileObj.sha256), className: 'danger' });

        this.showContextMenu(x, y, menuItems);
    },

    showContextMenu(x, y, items) {
        const menu = document.getElementById('context-menu');
        menu.innerHTML = items.map(item =>
            `<div class="context-menu-item ${item.className || ''}">${item.label}</div>`
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
            case 'encrypting':
                statusText = 'Encrypting...';
                break;
            case 'hashing':
                statusText = 'Hashing...';
                break;
            case 'uploading':
                statusText = 'Uploading...';
                break;
            case 'publishing':
                statusText = 'Publishing...';
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
    renderSharedFiles(files, searchQuery = '') {
        const fileList = document.getElementById('file-list');
        const body = document.getElementById('file-list-body');
        const header = document.querySelector('.file-list-header');

        // Toggle class for view mode
        fileList.classList.toggle('view-grid', this.viewMode === 'grid');
        fileList.classList.toggle('view-list', this.viewMode === 'list');

        // Show/hide header based on view mode
        if (header) {
            header.style.display = this.viewMode === 'list' ? '' : 'none';
        }

        let html = '';

        // Show search results info if searching
        if (searchQuery) {
            html += `<div class="search-results-info">Found ${files.length} result${files.length !== 1 ? 's' : ''} for "${this.escapeHtml(searchQuery)}"</div>`;
        }

        if (files.length === 0) {
            if (searchQuery) {
                body.innerHTML = html + '<div class="empty-state"><p>No matches found</p></div>';
            } else {
                body.innerHTML = '<div class="empty-state"><p>No shared files</p><p class="empty-state-subtext">Files shared with you will appear here</p></div>';
            }
            return;
        }

        if (this.viewMode === 'grid') {
            html += files.map(file => this.renderSharedFileGridItem(file)).join('');
        } else {
            html += files.map(file => this.renderSharedFileListItem(file)).join('');
        }

        body.innerHTML = html;

        // Add event listeners - pass files for key access
        this.attachSharedFileEventListeners(body, files);
    },

    // Render shared file as list item
    renderSharedFileListItem(file) {
        const icon = file.encrypted ? '&#128274;' : Upload.getFileIcon(file.mime_type);
        const size = file.size ? Upload.formatSize(file.size) : '-';
        const date = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString() : '-';
        const ownerShort = file.owner_pubkey ? file.owner_pubkey.slice(0, 8) + '...' : '';
        const expiration = file.expires_at ? Sharing.formatExpiration(file.expires_at) : '';
        const isExpired = file.expires_at && Sharing.isShareExpired(file);
        // Can download if not expired and either not encrypted or has key
        const canDownload = !isExpired && (!file.encrypted || file.fileKey);

        return `
            <div class="file-item shared-item ${isExpired ? 'expired' : ''}" data-id="${file.id || ''}" data-sha256="${file.sha256 || ''}" data-encrypted="${file.encrypted || false}">
                <div class="file-col file-name">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name-text">${this.escapeHtml(file.name)}</span>
                    <span class="shared-by">from ${ownerShort}</span>
                    ${expiration ? `<span class="share-expires ${isExpired ? 'expired' : ''}">${expiration}</span>` : ''}
                </div>
                <div class="file-col file-size">${size}</div>
                <div class="file-col file-date">${date}</div>
                <div class="file-col file-actions">
                    <button class="action-btn download-btn" ${canDownload ? '' : 'disabled'}>Download</button>
                </div>
            </div>
        `;
    },

    // Render shared file as grid item
    renderSharedFileGridItem(file) {
        const icon = file.encrypted ? '&#128274;' : Upload.getFileIcon(file.mime_type);
        const name = file.name || '(Encrypted)';
        const isExpired = file.expires_at && Sharing.isShareExpired(file);
        const canDownload = !isExpired && (!file.encrypted || file.fileKey);

        return `
            <div class="grid-item shared-item ${isExpired ? 'expired' : ''}" data-id="${file.id || ''}" data-sha256="${file.sha256 || ''}" data-encrypted="${file.encrypted || false}">
                <div class="grid-item-icon">${icon}</div>
                <div class="grid-item-name">${this.escapeHtml(name)}</div>
                <div class="grid-item-actions">
                    <button class="action-btn download-btn" title="Download" ${canDownload ? '' : 'disabled'}>↓</button>
                </div>
            </div>
        `;
    },

    // Attach event listeners to shared file items
    attachSharedFileEventListeners(container, sharedFiles) {
        container.querySelectorAll('.shared-item').forEach(item => {
            const shareId = item.dataset.id;
            const sha256 = item.dataset.sha256;

            // Find the file object to get all properties including fileKey
            const file = sharedFiles.find(f => f.id === shareId || f.sha256 === sha256);

            if (file) {
                item.querySelector('.download-btn')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    App.downloadSharedFile(file);
                });
            }
        });
    },

    // Show floating upload progress indicator
    showUploadProgress(current, total) {
        let indicator = document.getElementById('upload-progress-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'upload-progress-indicator';
            indicator.className = 'upload-progress-indicator';
            indicator.innerHTML = `
                <div class="upload-progress-content">
                    <div class="upload-progress-spinner"></div>
                    <div class="upload-progress-text">
                        <span class="upload-progress-status">Preparing upload...</span>
                        <span class="upload-progress-count">${current} / ${total}</span>
                    </div>
                </div>
                <div class="upload-progress-bar-container">
                    <div class="upload-progress-bar" style="width: 0%"></div>
                </div>
            `;
            document.body.appendChild(indicator);
        }

        indicator.classList.remove('hidden');
        this.updateUploadProgress(current, total);
    },

    // Update floating upload progress
    updateUploadProgress(current, total, statusText) {
        const indicator = document.getElementById('upload-progress-indicator');
        if (!indicator) return;

        const status = indicator.querySelector('.upload-progress-status');
        const count = indicator.querySelector('.upload-progress-count');
        const bar = indicator.querySelector('.upload-progress-bar');

        if (statusText && status) {
            status.textContent = statusText;
        }
        if (count) {
            count.textContent = `${current} / ${total}`;
        }
        if (bar && total > 0) {
            const percent = Math.round((current / total) * 100);
            bar.style.width = `${percent}%`;
        }
    },

    // Hide floating upload progress
    hideUploadProgress() {
        const indicator = document.getElementById('upload-progress-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    },

    // Show crypto progress indicator
    showCryptoProgress(operation, fileName) {
        let indicator = document.getElementById('crypto-progress-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'crypto-progress-indicator';
            indicator.className = 'crypto-progress-indicator';
            indicator.innerHTML = `
                <div class="crypto-progress-content">
                    <div class="crypto-progress-spinner"></div>
                    <div class="crypto-progress-text">
                        <span class="crypto-progress-operation">Encrypting...</span>
                        <span class="crypto-progress-file"></span>
                    </div>
                </div>
                <div class="crypto-progress-bar-container">
                    <div class="crypto-progress-bar" style="width: 0%"></div>
                </div>
            `;
            document.body.appendChild(indicator);
        }

        indicator.querySelector('.crypto-progress-operation').textContent = operation;
        indicator.querySelector('.crypto-progress-file').textContent = fileName || '';
        indicator.querySelector('.crypto-progress-bar').style.width = '0%';
        indicator.classList.remove('hidden');
    },

    // Update crypto progress
    updateCryptoProgress(percent, statusText) {
        const indicator = document.getElementById('crypto-progress-indicator');
        if (!indicator) return;

        if (statusText) {
            indicator.querySelector('.crypto-progress-operation').textContent = statusText;
        }
        indicator.querySelector('.crypto-progress-bar').style.width = `${percent}%`;
    },

    // Hide crypto progress indicator
    hideCryptoProgress() {
        const indicator = document.getElementById('crypto-progress-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    },
};

// Relay Settings UI Module
const RelaySettingsUI = {
    relays: [],           // Current relay list being edited
    originalPrefs: null,  // Original prefs for comparison

    async open() {
        if (!Auth.isConnected) {
            UI.toast('Please connect first', 'warning');
            return;
        }

        // Load current preferences
        try {
            this.originalPrefs = await RelayPrefs.getRelayPrefs(Auth.pubkey);
            this.relays = this.prefsToRelayList(this.originalPrefs);
            this.render();
            this.renderSourceInfo();
            UI.showModal('relay-settings-modal');
        } catch (err) {
            UI.toast('Failed to load relay preferences', 'error');
            console.error('Failed to load relay prefs:', err);
        }
    },

    prefsToRelayList(prefs) {
        // Convert read/write arrays to unified list
        const relayMap = new Map();
        for (const url of prefs.readRelays || []) {
            relayMap.set(url, { url, read: true, write: false });
        }
        for (const url of prefs.writeRelays || []) {
            const existing = relayMap.get(url);
            if (existing) {
                existing.write = true;
            } else {
                relayMap.set(url, { url, read: false, write: true });
            }
        }
        return Array.from(relayMap.values());
    },

    render() {
        const container = document.getElementById('relay-list');
        if (this.relays.length === 0) {
            container.innerHTML = '<div class="relay-list-empty">No relays configured</div>';
            return;
        }

        container.innerHTML = this.relays.map((relay, idx) => `
            <div class="relay-item" data-index="${idx}">
                <span class="relay-url" title="${UI.escapeHtml(relay.url)}">${UI.escapeHtml(relay.url)}</span>
                <span class="relay-badge ${relay.read ? 'active' : 'inactive'}" data-action="toggle-read">R</span>
                <span class="relay-badge ${relay.write ? 'active' : 'inactive'}" data-action="toggle-write">W</span>
                <button class="relay-remove" data-action="remove" title="Remove">&times;</button>
            </div>
        `).join('');
    },

    renderSourceInfo() {
        const info = document.getElementById('relay-source-info');
        const source = this.originalPrefs?.source || 'default';
        const cachedAt = this.originalPrefs?.cachedAt;

        let sourceText = 'Source: ';
        if (source === 'cloistr-relays') sourceText += 'Cloistr preferences';
        else if (source === 'nip65') sourceText += 'NIP-65 relay list';
        else sourceText += 'Default relay';

        let cacheText = '';
        if (cachedAt) {
            const ago = Math.round((Date.now() - cachedAt) / 60000);
            cacheText = `<br>Cached ${ago < 1 ? 'just now' : ago + ' minute' + (ago === 1 ? '' : 's') + ' ago'}`;
        }

        info.innerHTML = sourceText + cacheText;
    },

    addRelay() {
        const urlInput = document.getElementById('relay-add-url');
        let url = urlInput.value.trim();

        if (!url) {
            UI.toast('Please enter a relay URL', 'error');
            return;
        }

        // Add wss:// prefix if missing
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
            url = 'wss://' + url;
        }

        // Validate URL format
        try {
            new URL(url);
        } catch {
            UI.toast('Invalid relay URL format', 'error');
            return;
        }

        if (this.relays.some(r => r.url === url)) {
            UI.toast('Relay already in list', 'warning');
            return;
        }

        const read = document.getElementById('relay-add-read').checked;
        const write = document.getElementById('relay-add-write').checked;

        if (!read && !write) {
            UI.toast('Select at least read or write', 'warning');
            return;
        }

        this.relays.push({ url, read, write });
        this.render();
        urlInput.value = '';
        document.getElementById('relay-add-read').checked = true;
        document.getElementById('relay-add-write').checked = true;
        UI.toast('Relay added', 'success');
    },

    handleListClick(e) {
        const item = e.target.closest('.relay-item');
        if (!item) return;

        const idx = parseInt(item.dataset.index);
        const action = e.target.dataset.action;

        if (action === 'toggle-read') {
            this.relays[idx].read = !this.relays[idx].read;
            if (!this.relays[idx].read && !this.relays[idx].write) {
                this.relays[idx].write = true; // Must have at least one
            }
            this.render();
        } else if (action === 'toggle-write') {
            this.relays[idx].write = !this.relays[idx].write;
            if (!this.relays[idx].read && !this.relays[idx].write) {
                this.relays[idx].read = true; // Must have at least one
            }
            this.render();
        } else if (action === 'remove') {
            this.relays.splice(idx, 1);
            this.render();
        }
    },

    async save() {
        if (this.relays.length === 0) {
            UI.toast('Add at least one relay', 'warning');
            return;
        }

        try {
            await RelayPrefs.publishRelayPrefs(this.relays);
            UI.toast('Relay preferences saved', 'success');
            UI.hideModal('relay-settings-modal');
        } catch (err) {
            UI.toast(`Failed to save: ${err.message}`, 'error');
            console.error('Failed to save relay prefs:', err);
        }
    },

    setupEventListeners() {
        // Header button
        document.getElementById('relay-settings-btn').addEventListener('click', () => this.open());
        // Sidebar nav item
        document.getElementById('nav-relay-settings').addEventListener('click', () => this.open());
        // Modal controls
        document.getElementById('relay-settings-close').addEventListener('click', () => UI.hideModal('relay-settings-modal'));
        document.getElementById('relay-settings-cancel').addEventListener('click', () => UI.hideModal('relay-settings-modal'));
        document.getElementById('relay-settings-save').addEventListener('click', () => this.save());
        document.getElementById('relay-add-btn').addEventListener('click', () => this.addRelay());
        document.getElementById('relay-add-url').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addRelay();
        });
        document.getElementById('relay-list').addEventListener('click', (e) => this.handleListClick(e));
    }
};
