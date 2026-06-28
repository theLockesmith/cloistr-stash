/**
 * Desktop app integration via Tauri
 * This module provides desktop-specific features when running in Tauri
 */

class DesktopIntegration {
    constructor() {
        this.isTauri = this.detectTauri();
        this.syncStatus = null;
        this.pollInterval = null;
    }

    /**
     * Detect if running inside Tauri
     */
    detectTauri() {
        return typeof window.__TAURI__ !== 'undefined';
    }

    /**
     * Initialize desktop features
     */
    async init() {
        if (!this.isTauri) {
            console.log('Running in browser mode');
            return;
        }

        console.log('Running in Tauri desktop mode');

        // Show desktop-only UI elements
        this.showDesktopUI();

        // Start polling sync status
        this.startStatusPolling();

        // Listen for app events
        this.setupEventListeners();
    }

    /**
     * Show desktop-specific UI elements
     */
    showDesktopUI() {
        const syncSection = document.getElementById('sync-status-section');
        if (syncSection) {
            syncSection.classList.remove('hidden');
        }
    }

    /**
     * Start polling sync status from backend
     */
    startStatusPolling() {
        this.updateSyncStatus();
        this.pollInterval = setInterval(() => this.updateSyncStatus(), 2000);
    }

    /**
     * Stop polling
     */
    stopStatusPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Update sync status from backend
     */
    async updateSyncStatus() {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            this.syncStatus = await invoke('get_sync_status');
            this.renderSyncStatus();
        } catch (err) {
            console.error('Failed to get sync status:', err);
        }
    }

    /**
     * Render sync status in UI
     */
    renderSyncStatus() {
        const statusEl = document.getElementById('sync-status');
        const progressEl = document.getElementById('sync-progress');
        const pauseBtn = document.getElementById('sync-pause-btn');
        const syncNowBtn = document.getElementById('sync-now-btn');

        if (!statusEl || !this.syncStatus) return;

        // Update status text
        let statusText = 'Synced';
        let statusClass = 'synced';

        if (this.syncStatus.is_paused) {
            statusText = 'Paused';
            statusClass = 'paused';
        } else if (this.syncStatus.is_syncing) {
            statusText = this.syncStatus.current_item
                ? `Syncing: ${this.truncatePath(this.syncStatus.current_item)}`
                : 'Syncing...';
            statusClass = 'syncing';
        } else if (this.syncStatus.pending_uploads > 0 || this.syncStatus.pending_downloads > 0) {
            statusText = `Pending: ${this.syncStatus.pending_uploads} up, ${this.syncStatus.pending_downloads} down`;
            statusClass = 'pending';
        }

        statusEl.textContent = statusText;
        statusEl.className = `sync-status-text ${statusClass}`;

        // Update progress bar
        if (progressEl && this.syncStatus.total_bytes > 0) {
            const percent = Math.round((this.syncStatus.progress_bytes / this.syncStatus.total_bytes) * 100);
            progressEl.style.width = `${percent}%`;
            progressEl.parentElement.classList.remove('hidden');
        } else if (progressEl) {
            progressEl.parentElement.classList.add('hidden');
        }

        // Update pause button
        if (pauseBtn) {
            pauseBtn.textContent = this.syncStatus.is_paused ? 'Resume' : 'Pause';
            pauseBtn.title = this.syncStatus.is_paused ? 'Resume sync' : 'Pause sync';
        }

        // Update sync now button
        if (syncNowBtn) {
            syncNowBtn.disabled = this.syncStatus.is_syncing;
        }
    }

    /**
     * Truncate long file paths for display
     */
    truncatePath(path) {
        const maxLen = 30;
        if (path.length <= maxLen) return path;
        const parts = path.split(/[/\\]/);
        const filename = parts[parts.length - 1];
        if (filename.length > maxLen) {
            return '...' + filename.slice(-maxLen + 3);
        }
        return '.../' + filename;
    }

    /**
     * Toggle sync pause state
     */
    async togglePause() {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            const newPausedState = !this.syncStatus?.is_paused;
            await invoke('set_sync_paused', { paused: newPausedState });
            this.updateSyncStatus();
        } catch (err) {
            console.error('Failed to toggle pause:', err);
        }
    }

    /**
     * Trigger immediate sync
     */
    async triggerSync() {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            await invoke('trigger_sync');
            this.updateSyncStatus();
        } catch (err) {
            console.error('Failed to trigger sync:', err);
        }
    }

    /**
     * Open sync folder picker
     */
    async chooseSyncFolder() {
        if (!this.isTauri) return;

        try {
            const { open } = window.__TAURI__.dialog;
            const selected = await open({
                directory: true,
                title: 'Choose Sync Folder'
            });

            if (selected) {
                const { invoke } = window.__TAURI__.core;
                await invoke('set_sync_folder', { path: selected });
                this.showToast('Sync folder updated');
            }
        } catch (err) {
            console.error('Failed to choose folder:', err);
        }
    }

    /**
     * Get current sync folder
     */
    async getSyncFolder() {
        if (!this.isTauri) return null;

        try {
            const { invoke } = window.__TAURI__.core;
            return await invoke('get_sync_folder');
        } catch (err) {
            console.error('Failed to get sync folder:', err);
            return null;
        }
    }

    /**
     * Set API authentication from web auth
     */
    async setApiAuth(authHeader) {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            await invoke('set_api_auth', { authHeader });
            console.log('Desktop API auth set');
        } catch (err) {
            console.error('Failed to set API auth:', err);
        }
    }

    /**
     * Clear API authentication
     */
    async clearApiAuth() {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            await invoke('clear_api_auth');
            console.log('Desktop API auth cleared');
        } catch (err) {
            console.error('Failed to clear API auth:', err);
        }
    }

    /**
     * Upload file with encryption via desktop backend
     */
    async uploadFile(path, key, blossomAuth) {
        if (!this.isTauri) return null;

        try {
            const { invoke } = window.__TAURI__.core;
            return await invoke('api_upload_file', {
                path,
                key: Array.from(key),
                blossomAuth
            });
        } catch (err) {
            console.error('Failed to upload file:', err);
            throw err;
        }
    }

    /**
     * Download and decrypt file via desktop backend
     */
    async downloadFile(sha256, key, savePath) {
        if (!this.isTauri) return;

        try {
            const { invoke } = window.__TAURI__.core;
            await invoke('api_download_file', {
                sha256,
                key: Array.from(key),
                savePath
            });
        } catch (err) {
            console.error('Failed to download file:', err);
            throw err;
        }
    }

    /**
     * Show toast notification
     */
    showToast(message) {
        if (typeof showToast === 'function') {
            showToast(message);
        } else {
            console.log(message);
        }
    }

    /**
     * Setup event listeners for desktop UI
     */
    setupEventListeners() {
        // Sync pause button
        const pauseBtn = document.getElementById('sync-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => this.togglePause());
        }

        // Sync now button
        const syncNowBtn = document.getElementById('sync-now-btn');
        if (syncNowBtn) {
            syncNowBtn.addEventListener('click', () => this.triggerSync());
        }

        // Sync folder button
        const folderBtn = document.getElementById('sync-folder-btn');
        if (folderBtn) {
            folderBtn.addEventListener('click', () => this.chooseSyncFolder());
        }

        // Settings button
        const settingsBtn = document.getElementById('sync-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.showSyncSettings());
        }
    }

    /**
     * Show sync settings modal
     */
    async showSyncSettings() {
        const modal = document.getElementById('sync-settings-modal');
        if (!modal) return;

        // Load current settings
        const syncFolder = await this.getSyncFolder();
        const folderInput = document.getElementById('sync-folder-path');
        if (folderInput && syncFolder) {
            folderInput.value = syncFolder;
        }

        modal.classList.remove('hidden');
    }
}

// Global instance
const desktopIntegration = new DesktopIntegration();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    desktopIntegration.init();
});

// Export for use by other modules
window.desktopIntegration = desktopIntegration;
