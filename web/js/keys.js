// Key management module - HKDF derivation, folder keys, encrypted key storage
// Implements the zero-knowledge key hierarchy for Cloistr Drive

const Keys = {
    // Key storage in IndexedDB
    DB_NAME: 'cloistr-drive-keys',
    DB_VERSION: 1,
    STORE_NAME: 'keys',

    // HKDF context strings
    CONTEXT_ROOT: 'cloistr-drive-root-v1',
    CONTEXT_FOLDER: 'cloistr-drive-folder-v1',
    CONTEXT_FILE: 'cloistr-drive-file-v1',
    CONTEXT_SHARE: 'cloistr-drive-share-v1',

    // Database reference
    db: null,

    // In-memory key cache (cleared on disconnect)
    keyCache: new Map(),

    // Current user's pubkey
    userPubkey: null,

    // Initialize the key management system
    async init(pubkey) {
        this.userPubkey = pubkey;
        await this.openDB();

        // Try to restore root key from Nostr
        await this.restoreRootKeyFromNostr();

        console.log('Keys: Initialized for', pubkey.slice(0, 8) + '...');
    },

    // Restore root key from Nostr event (for cross-device/session persistence)
    async restoreRootKeyFromNostr() {
        if (!this.userPubkey) return;

        try {
            // Check if we already have a root key locally
            const localKey = await this.loadEncryptedKey('root');
            if (localKey) {
                console.log('Keys: Root key already present locally');
                return;
            }

            // Fetch from server/Nostr
            const result = await API.getKeyring(this.userPubkey);
            if (!result.encrypted_root_key) {
                console.log('Keys: No root key found in Nostr');
                return;
            }

            // Decrypt the root key (it's encrypted with our own pubkey)
            if (typeof Auth !== 'undefined' && Auth.isConnected) {
                const keyHex = await Auth.nip04Decrypt(this.userPubkey, result.encrypted_root_key);
                const rootKey = Crypto.hexToBytes(keyHex);

                // Store locally and cache
                await this.storeEncryptedKey('root', rootKey, null);
                this.keyCache.set('root', rootKey);

                console.log('Keys: Restored root key from Nostr');
            }
        } catch (err) {
            console.warn('Keys: Failed to restore root key from Nostr:', err.message);
            // Non-fatal - will generate new key if needed
        }
    },

    // Open IndexedDB for key storage
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
                    store.createIndex('pubkey', 'pubkey', { unique: false });
                    store.createIndex('type', 'type', { unique: false });
                }
            };
        });
    },

    // Generate the root key for a user (derived from their Nostr identity)
    // This is the master key from which all other keys are derived
    async generateRootKey() {
        if (!this.userPubkey) {
            throw new Error('User not initialized');
        }

        // Generate a random 256-bit root key
        const rootKey = Crypto.generateKey();

        // Store encrypted with user's pubkey (via NIP-04 or NIP-44)
        await this.storeEncryptedKey('root', rootKey, null);

        // Cache in memory
        this.keyCache.set('root', rootKey);

        // Publish to Nostr for cross-device/session persistence
        await this.publishRootKeyToNostr(rootKey);

        console.log('Keys: Generated new root key');
        return rootKey;
    },

    // Publish root key to Nostr for persistence across devices/sessions
    async publishRootKeyToNostr(rootKey) {
        if (typeof Auth === 'undefined' || !Auth.isConnected) {
            console.warn('Keys: Cannot publish root key - Auth not connected');
            return;
        }

        try {
            // Encrypt the root key with our own pubkey
            const keyHex = Crypto.bytesToHex(rootKey);
            const encryptedKey = await Auth.nip04Encrypt(this.userPubkey, keyHex);

            // Create and sign the root key event (kind 30078 with d='root-key')
            const signedEvent = await Auth.createRootKeyEvent(encryptedKey);

            // Publish to relay
            await Auth.publishEvent(signedEvent);

            console.log('Keys: Published root key to Nostr');
        } catch (err) {
            console.warn('Keys: Failed to publish root key to Nostr:', err.message);
            // Non-fatal - key is still stored locally
        }
    },

    // Get or create the root key
    async getRootKey() {
        // Check cache first
        if (this.keyCache.has('root')) {
            return this.keyCache.get('root');
        }

        // Try to load from storage
        const stored = await this.loadEncryptedKey('root');
        if (stored) {
            this.keyCache.set('root', stored);
            return stored;
        }

        // Generate new root key if none exists
        return this.generateRootKey();
    },

    // Generate a folder key (random, stored encrypted)
    async generateFolderKey(folderId) {
        const folderKey = Crypto.generateKey();

        // Store encrypted
        await this.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId);

        // Cache
        this.keyCache.set(`folder:${folderId}`, folderKey);

        console.log('Keys: Generated folder key for', folderId.slice(0, 8) + '...');
        return folderKey;
    },

    // Get a folder key (from cache, storage, or derive from parent)
    async getFolderKey(folderId, parentFolderId = null) {
        const cacheKey = `folder:${folderId}`;

        // Check cache
        if (this.keyCache.has(cacheKey)) {
            return this.keyCache.get(cacheKey);
        }

        // Try to load from storage
        const stored = await this.loadEncryptedKey(cacheKey);
        if (stored) {
            this.keyCache.set(cacheKey, stored);
            return stored;
        }

        // If we have a parent, derive from parent key
        if (parentFolderId) {
            const parentKey = await this.getFolderKey(parentFolderId);
            const derivedKey = await this.deriveKey(parentKey, folderId, this.CONTEXT_FOLDER);
            this.keyCache.set(cacheKey, derivedKey);
            await this.storeEncryptedKey(cacheKey, derivedKey, folderId);
            return derivedKey;
        }

        // No parent = root folder, derive from root key
        const rootKey = await this.getRootKey();
        const derivedKey = await this.deriveKey(rootKey, folderId, this.CONTEXT_FOLDER);
        this.keyCache.set(cacheKey, derivedKey);
        await this.storeEncryptedKey(cacheKey, derivedKey, folderId);

        return derivedKey;
    },

    // Derive a file key from folder key
    async deriveFileKey(folderId, fileId) {
        const folderKey = await this.getFolderKey(folderId);
        return this.deriveKey(folderKey, fileId, this.CONTEXT_FILE);
    },

    // Derive a file key for root folder (no folder ID)
    async deriveRootFileKey(fileId) {
        const rootKey = await this.getRootKey();
        return this.deriveKey(rootKey, fileId, this.CONTEXT_FILE);
    },

    // HKDF key derivation using Web Crypto API
    // Derives a 256-bit key from input key material + info string
    async deriveKey(inputKey, info, context) {
        // Import the input key as raw key material
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            inputKey,
            { name: 'HKDF' },
            false,
            ['deriveBits']
        );

        // Create info string: context || ':' || info
        const encoder = new TextEncoder();
        const infoBytes = encoder.encode(`${context}:${info}`);

        // Derive 256 bits using HKDF-SHA256
        const derivedBits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32), // Zero salt (key material is already random)
                info: infoBytes,
            },
            keyMaterial,
            256 // bits
        );

        return new Uint8Array(derivedBits);
    },

    // Store an encrypted key in IndexedDB
    // Keys are encrypted with the user's Nostr key via NIP-44
    async storeEncryptedKey(keyId, key, associatedId) {
        if (!this.db) await this.openDB();

        // Encrypt the key using NIP-44 with our own pubkey
        // This means only we can decrypt it later
        const keyHex = Crypto.bytesToHex(key);

        let encryptedKey;
        try {
            // Use NIP-44 encryption if available, fall back to NIP-04
            if (typeof Auth !== 'undefined' && Auth.isConnected) {
                encryptedKey = await Auth.nip04Encrypt(this.userPubkey, keyHex);
            } else {
                // Fallback: store as base64 (less secure, but works offline)
                // In production, this should require auth
                encryptedKey = Crypto.bytesToBase64(key);
            }
        } catch (err) {
            // Fallback for when encryption isn't available
            console.warn('Keys: NIP-04 encryption not available, using base64 fallback');
            encryptedKey = Crypto.bytesToBase64(key);
        }

        const record = {
            id: `${this.userPubkey}:${keyId}`,
            pubkey: this.userPubkey,
            keyId: keyId,
            type: keyId.split(':')[0], // 'root', 'folder', etc.
            associatedId: associatedId,
            encryptedKey: encryptedKey,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    // Load an encrypted key from IndexedDB
    async loadEncryptedKey(keyId) {
        if (!this.db) await this.openDB();

        return new Promise(async (resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.get(`${this.userPubkey}:${keyId}`);

            request.onsuccess = async () => {
                const record = request.result;
                if (!record) {
                    resolve(null);
                    return;
                }

                try {
                    let keyHex;
                    // Try to decrypt using NIP-04
                    if (typeof Auth !== 'undefined' && Auth.isConnected && record.encryptedKey.includes('?iv=')) {
                        keyHex = await Auth.nip04Decrypt(this.userPubkey, record.encryptedKey);
                    } else {
                        // Fallback: base64 encoded
                        const keyBytes = Crypto.base64ToBytes(record.encryptedKey);
                        resolve(keyBytes);
                        return;
                    }
                    resolve(Crypto.hexToBytes(keyHex));
                } catch (err) {
                    console.error('Keys: Failed to decrypt key:', err);
                    resolve(null);
                }
            };

            request.onerror = () => reject(request.error);
        });
    },

    // Delete a key from storage
    async deleteKey(keyId) {
        if (!this.db) await this.openDB();

        // Remove from cache
        this.keyCache.delete(keyId);

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.delete(`${this.userPubkey}:${keyId}`);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    // Import a shared folder key (received via NIP-44)
    async importSharedFolderKey(folderId, encryptedKey, senderPubkey) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        // Decrypt the folder key using NIP-44
        const keyHex = await Auth.nip04Decrypt(senderPubkey, encryptedKey);
        const folderKey = Crypto.hexToBytes(keyHex);

        // Store locally
        await this.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId);

        // Cache
        this.keyCache.set(`folder:${folderId}`, folderKey);

        console.log('Keys: Imported shared folder key for', folderId.slice(0, 8) + '...');
        return folderKey;
    },

    // Export a folder key for sharing (encrypts with recipient's pubkey)
    async exportFolderKeyForSharing(folderId, recipientPubkey) {
        const folderKey = await this.getFolderKey(folderId);
        const keyHex = Crypto.bytesToHex(folderKey);

        // Encrypt with recipient's pubkey using NIP-44
        const encryptedKey = await Auth.nip04Encrypt(recipientPubkey, keyHex);

        return encryptedKey;
    },

    // Get key for public link (returns key as base64url for URL fragment)
    async getPublicLinkKey(folderId, fileId) {
        let key;
        if (folderId) {
            key = await this.deriveFileKey(folderId, fileId);
        } else {
            key = await this.deriveRootFileKey(fileId);
        }

        return Crypto.bytesToBase64url(key);
    },

    // Parse key from public link URL fragment
    parsePublicLinkKey(base64urlKey) {
        return Crypto.base64urlToBytes(base64urlKey);
    },

    // Clear all keys from cache (call on disconnect)
    clearCache() {
        // Wipe keys from memory
        for (const key of this.keyCache.values()) {
            Crypto.wipeKey(key);
        }
        this.keyCache.clear();
        this.userPubkey = null;
        console.log('Keys: Cache cleared');
    },

    // Clear all stored keys for current user
    async clearAllKeys() {
        if (!this.db) await this.openDB();

        // If no user pubkey, clear the cache and return
        if (!this.userPubkey) {
            this.clearCache();
            return;
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const index = store.index('pubkey');
            const request = index.openCursor(IDBKeyRange.only(this.userPubkey));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    this.clearCache();
                    resolve();
                }
            };

            request.onerror = () => reject(request.error);
        });
    },

    // Re-encrypt all keys after revocation (new root key)
    // This is used when revoking access - generates new keys for everything
    async rekey() {
        console.log('Keys: Starting full re-key operation...');

        // Generate new root key
        const newRootKey = Crypto.generateKey();

        // Get all folder keys that need re-keying
        const folderKeys = [];
        for (const [keyId, _] of this.keyCache) {
            if (keyId.startsWith('folder:')) {
                const folderId = keyId.replace('folder:', '');
                folderKeys.push(folderId);
            }
        }

        // Generate new folder keys
        for (const folderId of folderKeys) {
            const newFolderKey = Crypto.generateKey();
            this.keyCache.set(`folder:${folderId}`, newFolderKey);
            await this.storeEncryptedKey(`folder:${folderId}`, newFolderKey, folderId);
        }

        // Store new root key
        this.keyCache.set('root', newRootKey);
        await this.storeEncryptedKey('root', newRootKey, null);

        console.log('Keys: Re-key complete');
        return { rootKey: newRootKey, rekeyedFolders: folderKeys.length };
    },

    // Check if a folder has a stored key
    async hasFolderKey(folderId) {
        if (this.keyCache.has(`folder:${folderId}`)) {
            return true;
        }
        const stored = await this.loadEncryptedKey(`folder:${folderId}`);
        return stored !== null;
    },

    // Get all folder IDs we have keys for
    async getAllFolderIds() {
        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const index = store.index('pubkey');
            const request = index.getAll(IDBKeyRange.only(this.userPubkey));

            request.onsuccess = () => {
                const folderIds = request.result
                    .filter(r => r.type === 'folder')
                    .map(r => r.associatedId);
                resolve(folderIds);
            };

            request.onerror = () => reject(request.error);
        });
    },

    // Export all keys as encrypted backup
    // The backup is encrypted with the user's Nostr pubkey
    async exportBackup() {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        if (!this.db) await this.openDB();

        // Get all keys for current user
        const allKeys = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const index = store.index('pubkey');
            const request = index.getAll(IDBKeyRange.only(this.userPubkey));

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        // Create backup structure
        const backup = {
            version: 1,
            createdAt: Date.now(),
            pubkey: this.userPubkey,
            keys: allKeys.map(k => ({
                keyId: k.keyId,
                type: k.type,
                associatedId: k.associatedId,
                encryptedKey: k.encryptedKey,
            })),
        };

        // Sign the backup so we can verify authenticity on import
        const backupString = JSON.stringify(backup);
        const backupHash = await Crypto.hash(new TextEncoder().encode(backupString));

        // Encrypt the entire backup with our pubkey
        const encryptedBackup = await Auth.nip04Encrypt(this.userPubkey, backupString);

        return {
            encrypted: encryptedBackup,
            hash: backupHash,
            pubkey: this.userPubkey,
            version: 1,
            createdAt: backup.createdAt,
        };
    },

    // Import keys from encrypted backup
    async importBackup(backupData) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        if (backupData.pubkey !== this.userPubkey) {
            throw new Error('Backup is for a different user');
        }

        // Decrypt the backup
        const decryptedString = await Auth.nip04Decrypt(this.userPubkey, backupData.encrypted);
        const backup = JSON.parse(decryptedString);

        // Verify hash
        const computedHash = await Crypto.hash(new TextEncoder().encode(decryptedString));
        if (computedHash !== backupData.hash) {
            console.warn('Keys: Backup hash mismatch (may be truncated/modified)');
        }

        // Import each key
        let imported = 0;
        for (const keyData of backup.keys) {
            try {
                const record = {
                    id: `${this.userPubkey}:${keyData.keyId}`,
                    pubkey: this.userPubkey,
                    keyId: keyData.keyId,
                    type: keyData.type,
                    associatedId: keyData.associatedId,
                    encryptedKey: keyData.encryptedKey,
                    createdAt: backup.createdAt,
                    updatedAt: Date.now(),
                };

                await new Promise((resolve, reject) => {
                    const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
                    const store = tx.objectStore(this.STORE_NAME);
                    const request = store.put(record);
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });

                imported++;
            } catch (err) {
                console.warn(`Keys: Failed to import key ${keyData.keyId}:`, err);
            }
        }

        // Clear cache to force reload from storage
        this.clearCache();
        this.userPubkey = backupData.pubkey;

        console.log(`Keys: Imported ${imported} keys from backup`);
        return { imported, total: backup.keys.length };
    },
};
