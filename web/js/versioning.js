// Versioning module - File version tracking, history, and restore
// Implements zero-knowledge file versioning for Cloistr Drive

const Versioning = {
    // Version storage in IndexedDB
    DB_NAME: 'cloistr-drive-versions',
    DB_VERSION: 1,
    STORE_NAME: 'versions',

    // Database reference
    db: null,

    // Version metadata cache
    versionCache: new Map(),

    // Initialize versioning module
    async init() {
        await this.openDB();
        console.log('Versioning: Initialized');
    },

    // Open IndexedDB for version tracking
    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                    store.createIndex('fileId', 'fileId', { unique: false });
                    store.createIndex('pubkey', 'pubkey', { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    },

    // Create a new version of a file
    // Returns the version metadata
    async createVersion(file, newFileData, options = {}) {
        const {
            versionNote = '',
            autoSave = false,
        } = options;

        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        if (!fileId) {
            throw new Error('Cannot version: missing file ID');
        }

        // Get the current version number
        const currentVersions = await this.getVersionHistory(fileId);
        const newVersionNumber = currentVersions.length + 1;

        // Encrypt the new version
        let fileKey;
        if (folderId) {
            fileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            fileKey = await Keys.deriveRootFileKey(fileId);
        }

        const encryptedData = await Crypto.encryptFile(newFileData, fileKey);
        const encryptedHash = await Crypto.hash(encryptedData);
        const plaintextHash = await Crypto.hash(newFileData);

        // Upload the new version
        const authHeader = await Auth.createUploadAuth(encryptedHash, encryptedData.length, 'application/octet-stream');
        const encryptedFile = new File([encryptedData], `${file.name}.v${newVersionNumber}.encrypted`, {
            type: 'application/octet-stream',
        });
        const uploadResult = await API.uploadFile(encryptedFile, authHeader);

        // Create version metadata
        const versionMeta = {
            id: `${fileId}:v${newVersionNumber}`,
            fileId: fileId,
            version: newVersionNumber,
            sha256: uploadResult.sha256,
            plaintextHash: plaintextHash,
            size: newFileData.byteLength || newFileData.length,
            encryptedSize: encryptedData.length,
            timestamp: Math.floor(Date.now() / 1000),
            pubkey: Auth.pubkey,
            note: versionNote,
            autoSave: autoSave,
            previousVersion: currentVersions.length > 0 ? currentVersions[0].sha256 : null,
        };

        // Store version metadata locally
        await this.storeVersionMeta(versionMeta);

        // Publish updated file metadata with version tags
        const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
            fileId: fileId,
            sha256: uploadResult.sha256,
            plaintextHash: plaintextHash,
            name: file.name,
            size: versionMeta.size,
            encryptedSize: versionMeta.encryptedSize,
            mimeType: file.mime_type || file.mimeType || 'application/octet-stream',
            folderId: folderId,
            encrypted: true,
            version: newVersionNumber,
        });

        await Auth.publishEvent(metadataEvent);

        // Wipe key from memory
        Crypto.wipeKey(fileKey);

        console.log(`Versioning: Created version ${newVersionNumber} for file ${fileId.slice(0, 8)}...`);

        return versionMeta;
    },

    // Store version metadata in IndexedDB
    async storeVersionMeta(versionMeta) {
        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.put(versionMeta);
            request.onsuccess = () => {
                // Update cache
                const cacheKey = versionMeta.fileId;
                if (!this.versionCache.has(cacheKey)) {
                    this.versionCache.set(cacheKey, []);
                }
                const versions = this.versionCache.get(cacheKey);
                versions.unshift(versionMeta);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    },

    // Get version history for a file (newest first)
    async getVersionHistory(fileId) {
        // Check cache first
        if (this.versionCache.has(fileId)) {
            return this.versionCache.get(fileId);
        }

        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const index = store.index('fileId');
            const request = index.getAll(IDBKeyRange.only(fileId));

            request.onsuccess = () => {
                const versions = request.result || [];
                // Sort by version number (newest first)
                versions.sort((a, b) => b.version - a.version);
                // Cache the result
                this.versionCache.set(fileId, versions);
                resolve(versions);
            };

            request.onerror = () => reject(request.error);
        });
    },

    // Get a specific version
    async getVersion(fileId, versionNumber) {
        const versions = await this.getVersionHistory(fileId);
        return versions.find(v => v.version === versionNumber);
    },

    // Download a specific version
    async downloadVersion(file, versionNumber) {
        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        const versionMeta = await this.getVersion(fileId, versionNumber);
        if (!versionMeta) {
            throw new Error(`Version ${versionNumber} not found`);
        }

        // Fetch the encrypted version
        const downloadUrl = API.getDownloadURL(versionMeta.sha256);
        const response = await fetch(downloadUrl);

        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }

        const encryptedData = await response.arrayBuffer();

        // Decrypt with the file key (same key for all versions)
        let fileKey;
        if (folderId) {
            fileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            fileKey = await Keys.deriveRootFileKey(fileId);
        }

        const decryptedData = await Crypto.decryptFile(encryptedData, fileKey);

        // Wipe key
        Crypto.wipeKey(fileKey);

        return decryptedData;
    },

    // Restore a previous version (creates a new version from old data)
    async restoreVersion(file, versionNumber) {
        const fileId = file.file_id || file.fileId || file.d;

        // Download the old version
        const oldVersionData = await this.downloadVersion(file, versionNumber);

        // Create a new version with the old data
        const newVersion = await this.createVersion(file, oldVersionData, {
            versionNote: `Restored from version ${versionNumber}`,
            autoSave: false,
        });

        console.log(`Versioning: Restored version ${versionNumber} as version ${newVersion.version}`);

        return newVersion;
    },

    // Compare two versions (returns metadata diff, not content diff)
    async compareVersions(fileId, versionA, versionB) {
        const versions = await this.getVersionHistory(fileId);
        const a = versions.find(v => v.version === versionA);
        const b = versions.find(v => v.version === versionB);

        if (!a || !b) {
            throw new Error('Version not found');
        }

        return {
            versionA: a,
            versionB: b,
            sizeDiff: b.size - a.size,
            timeDiff: b.timestamp - a.timestamp,
            sameContent: a.plaintextHash === b.plaintextHash,
        };
    },

    // Delete old versions (keep N most recent)
    async pruneVersions(fileId, keepCount = 10) {
        const versions = await this.getVersionHistory(fileId);

        if (versions.length <= keepCount) {
            return 0;
        }

        const toDelete = versions.slice(keepCount);
        let deleted = 0;

        for (const version of toDelete) {
            try {
                // Delete from storage (optional - Blossom might auto-expire)
                // For now, just delete metadata
                await this.deleteVersionMeta(version.id);
                deleted++;
            } catch (err) {
                console.warn(`Versioning: Failed to delete version ${version.version}:`, err);
            }
        }

        // Update cache
        this.versionCache.set(fileId, versions.slice(0, keepCount));

        console.log(`Versioning: Pruned ${deleted} old versions for file ${fileId.slice(0, 8)}...`);

        return deleted;
    },

    // Delete version metadata
    async deleteVersionMeta(versionId) {
        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.delete(versionId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    // Clear version cache
    clearCache() {
        this.versionCache.clear();
    },

    // Format version timestamp for display
    formatTimestamp(timestamp) {
        const date = new Date(timestamp * 1000);
        return date.toLocaleString();
    },

    // Format time ago for display
    formatTimeAgo(timestamp) {
        const now = Math.floor(Date.now() / 1000);
        const diff = now - timestamp;

        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
        return this.formatTimestamp(timestamp);
    },

    // Auto-save version (for collaborative editing)
    async autoSaveVersion(file, newFileData) {
        return this.createVersion(file, newFileData, {
            versionNote: 'Auto-save',
            autoSave: true,
        });
    },

    // Check if a file has version history
    async hasVersionHistory(fileId) {
        const versions = await this.getVersionHistory(fileId);
        return versions.length > 1;
    },

    // Get the current (latest) version
    async getCurrentVersion(fileId) {
        const versions = await this.getVersionHistory(fileId);
        return versions.length > 0 ? versions[0] : null;
    },

    // Get version diff for text files (basic line diff)
    async getTextDiff(file, versionA, versionB) {
        const dataA = await this.downloadVersion(file, versionA);
        const dataB = await this.downloadVersion(file, versionB);

        const decoder = new TextDecoder();
        const textA = decoder.decode(dataA);
        const textB = decoder.decode(dataB);

        const linesA = textA.split('\n');
        const linesB = textB.split('\n');

        // Simple line-based diff
        const diff = [];
        const maxLines = Math.max(linesA.length, linesB.length);

        for (let i = 0; i < maxLines; i++) {
            const lineA = linesA[i];
            const lineB = linesB[i];

            if (lineA === lineB) {
                diff.push({ type: 'unchanged', line: lineA, lineNum: i + 1 });
            } else if (lineA === undefined) {
                diff.push({ type: 'added', line: lineB, lineNum: i + 1 });
            } else if (lineB === undefined) {
                diff.push({ type: 'removed', line: lineA, lineNum: i + 1 });
            } else {
                diff.push({ type: 'removed', line: lineA, lineNum: i + 1 });
                diff.push({ type: 'added', line: lineB, lineNum: i + 1 });
            }
        }

        return diff;
    },
};
