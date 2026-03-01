// Authentication module for NIP-07 and NIP-46 integration

const Auth = {
    pubkey: null,
    isConnected: false,
    connectionType: null, // 'nip07' | 'nip46'

    // Check if NIP-07 extension is available
    hasExtension() {
        return typeof window.nostr !== 'undefined';
    },

    // Connect to NIP-07 extension
    async connect() {
        if (!this.hasExtension()) {
            throw new Error('No Nostr extension found. Please install a NIP-07 compatible extension like nos2x or Alby.');
        }

        try {
            this.pubkey = await window.nostr.getPublicKey();
            this.isConnected = true;
            this.connectionType = 'nip07';
            return this.pubkey;
        } catch (err) {
            throw new Error(`Failed to connect: ${err.message}`);
        }
    },

    // Connect via NIP-46 remote signer (bunker)
    async connectNIP46(bunkerUrl) {
        if (typeof NIP46 === 'undefined') {
            throw new Error('NIP-46 module not loaded');
        }

        try {
            this.pubkey = await NIP46.connect(bunkerUrl);
            this.isConnected = true;
            this.connectionType = 'nip46';
            return this.pubkey;
        } catch (err) {
            throw new Error(`Failed to connect to bunker: ${err.message}`);
        }
    },

    // Check if there's a saved NIP-46 session
    hasSavedSession() {
        return typeof NIP46 !== 'undefined' && NIP46.hasSavedSession();
    },

    // Restore a saved NIP-46 session
    async restoreSession() {
        if (typeof NIP46 === 'undefined') {
            return false;
        }

        try {
            const pubkey = await NIP46.restoreSession();
            if (pubkey) {
                this.pubkey = pubkey;
                this.isConnected = true;
                this.connectionType = 'nip46';
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to restore session:', err);
            return false;
        }
    },

    // Sign a Nostr event (works with both NIP-07 and NIP-46)
    async signEvent(event) {
        if (!this.isConnected) {
            throw new Error('Not connected. Call connect() first.');
        }

        if (this.connectionType === 'nip46') {
            return NIP46.signEvent(event);
        }

        if (!this.hasExtension()) {
            throw new Error('No Nostr extension found.');
        }

        return window.nostr.signEvent(event);
    },

    // Create a Blossom upload auth event (kind 24242)
    async createUploadAuth(fileHash, fileSize, contentType) {
        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 300; // 5 minutes

        const event = {
            kind: 24242,
            created_at: now,
            tags: [
                ['t', 'upload'],
                ['x', fileHash],
                ['expiration', expiration.toString()],
            ],
            content: `Upload ${fileHash}`,
        };

        // Add optional size tag
        if (fileSize) {
            event.tags.push(['size', fileSize.toString()]);
        }

        const signed = await this.signEvent(event);
        return this.encodeAuthHeader(signed);
    },

    // Create a Blossom delete auth event (kind 24242)
    async createDeleteAuth(fileHash) {
        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 300; // 5 minutes

        const event = {
            kind: 24242,
            created_at: now,
            tags: [
                ['t', 'delete'],
                ['x', fileHash],
                ['expiration', expiration.toString()],
            ],
            content: `Delete ${fileHash}`,
        };

        const signed = await this.signEvent(event);
        return this.encodeAuthHeader(signed);
    },

    // Create auth event for status check (kind 24242)
    async createStatusAuth() {
        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 300; // 5 minutes

        const event = {
            kind: 24242,
            created_at: now,
            tags: [
                ['t', 'list'],
                ['expiration', expiration.toString()],
            ],
            content: 'Auth status check',
        };

        const signed = await this.signEvent(event);
        return this.encodeAuthHeader(signed);
    },

    // Encode signed event as Authorization header value
    encodeAuthHeader(signedEvent) {
        const json = JSON.stringify(signedEvent);
        const base64 = btoa(json);
        return `Nostr ${base64}`;
    },

    // Calculate SHA-256 hash of a file
    async hashFile(file) {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Create a file metadata event (kind 30078) - for unencrypted files (legacy)
    async createFileMetadataEvent(fileInfo) {
        const now = Math.floor(Date.now() / 1000);

        const content = JSON.stringify({
            name: fileInfo.name,
            size: fileInfo.size,
            mime_type: fileInfo.mimeType,
        });

        const event = {
            kind: 30078,  // File metadata kind
            created_at: now,
            tags: [
                ['d', fileInfo.sha256],                    // Identifier (makes it replaceable)
                ['x', fileInfo.sha256],                    // File hash
                ['m', fileInfo.mimeType || 'application/octet-stream'],
                ['size', fileInfo.size.toString()],
            ],
            content: content,
        };

        // Add URL tag if provided
        if (fileInfo.url) {
            event.tags.push(['url', fileInfo.url]);
        }

        // Add folder tag if provided
        if (fileInfo.folderId) {
            event.tags.push(['folder', fileInfo.folderId]);
        }

        return this.signEvent(event);
    },

    // Create an encrypted file metadata event (kind 30078)
    // Contains all info needed to decrypt and identify the file
    async createEncryptedFileMetadataEvent(fileInfo) {
        const now = Math.floor(Date.now() / 1000);

        // Content includes encrypted file details
        // Note: name is stored in plaintext for search (can be encrypted later)
        const content = JSON.stringify({
            name: fileInfo.name,                    // Original filename
            size: fileInfo.size,                    // Original size (plaintext)
            encrypted_size: fileInfo.encryptedSize, // Encrypted blob size
            mime_type: fileInfo.mimeType,           // Original MIME type
            encrypted: true,                        // Flag indicating encryption
        });

        const event = {
            kind: 30078,  // File metadata kind
            created_at: now,
            tags: [
                ['d', fileInfo.fileId],                    // File ID (for key derivation)
                ['x', fileInfo.sha256],                    // Hash of encrypted blob (Blossom hash)
                ['ox', fileInfo.plaintextHash],            // Original (plaintext) hash
                ['m', fileInfo.mimeType || 'application/octet-stream'],
                ['size', fileInfo.size.toString()],        // Original size
                ['encrypted', 'xchacha20-poly1305'],       // Encryption algorithm
            ],
            content: content,
        };

        // Add folder tag if provided
        if (fileInfo.folderId) {
            event.tags.push(['folder', fileInfo.folderId]);
        }

        // Add version tags if this is a version update
        if (fileInfo.version) {
            event.tags.push(['v', fileInfo.sha256, fileInfo.version.toString(), now.toString(), this.pubkey]);
            event.tags.push(['current', fileInfo.sha256]);
        }

        return this.signEvent(event);
    },

    // Create a folder metadata event (kind 30079)
    async createFolderEvent(folderInfo) {
        const now = Math.floor(Date.now() / 1000);

        const content = JSON.stringify({
            name: folderInfo.name,
            description: folderInfo.description || '',
        });

        const event = {
            kind: 30079,  // Folder metadata kind
            created_at: now,
            tags: [
                ['d', folderInfo.id],  // Identifier (makes it replaceable)
            ],
            content: content,
        };

        // Add parent folder tag if specified
        if (folderInfo.parentId) {
            event.tags.push(['parent', folderInfo.parentId]);
        }

        return this.signEvent(event);
    },

    // Create an encrypted folder metadata event (kind 30079)
    // The folder_key is encrypted with our own pubkey for storage
    async createEncryptedFolderEvent(folderInfo) {
        const now = Math.floor(Date.now() / 1000);

        // Content includes folder details (name can be encrypted for privacy)
        const content = JSON.stringify({
            name: folderInfo.name,
            description: folderInfo.description || '',
            encrypted: true,
        });

        const event = {
            kind: 30079,  // Folder metadata kind
            created_at: now,
            tags: [
                ['d', folderInfo.id],           // Identifier (makes it replaceable)
                ['encrypted', 'true'],           // Flag indicating encrypted folder
            ],
            content: content,
        };

        // Add parent folder tag if specified
        if (folderInfo.parentId) {
            event.tags.push(['parent', folderInfo.parentId]);
        }

        // Add encrypted folder key (encrypted with owner's pubkey)
        // This allows us to recover the folder key from the event
        if (folderInfo.encryptedFolderKey) {
            event.tags.push(['key', folderInfo.encryptedFolderKey]);
        }

        return this.signEvent(event);
    },

    // Create a folder deletion event (kind 5 - NIP-09)
    async createFolderDeleteEvent(folderId) {
        if (!this.isConnected || !this.pubkey) {
            throw new Error('Not connected');
        }

        const now = Math.floor(Date.now() / 1000);

        const event = {
            kind: 5,  // Deletion event
            created_at: now,
            tags: [
                ['a', `30079:${this.pubkey}:${folderId}`],
            ],
            content: 'deleted',
        };

        return this.signEvent(event);
    },

    // Generate a random folder ID
    generateFolderId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Generate a random share ID
    generateShareId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // NIP-04 encrypt content for a recipient
    // Note: This uses the browser extension's nip04.encrypt if available
    async nip04Encrypt(recipientPubkey, content) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }

        // Try using browser extension's NIP-04 if available
        if (this.connectionType === 'nip07' && window.nostr?.nip04?.encrypt) {
            return window.nostr.nip04.encrypt(recipientPubkey, content);
        }

        // For NIP-46 or fallback, use our NIP46 module's encryption
        if (typeof NIP46 !== 'undefined' && NIP46.nip04Encrypt) {
            return NIP46.nip04Encrypt(content, recipientPubkey);
        }

        throw new Error('NIP-04 encryption not available');
    },

    // NIP-04 decrypt content from a sender
    async nip04Decrypt(senderPubkey, encryptedContent) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }

        // Try using browser extension's NIP-04 if available
        if (this.connectionType === 'nip07' && window.nostr?.nip04?.decrypt) {
            return window.nostr.nip04.decrypt(senderPubkey, encryptedContent);
        }

        // For NIP-46 or fallback, use our NIP46 module's decryption
        if (typeof NIP46 !== 'undefined' && NIP46.nip04Decrypt) {
            return NIP46.nip04Decrypt(encryptedContent, senderPubkey);
        }

        throw new Error('NIP-04 decryption not available');
    },

    // Create a file share event (kind 30080)
    // For encrypted files, includes the file key so recipient can decrypt
    async createShareEvent(shareInfo) {
        const now = Math.floor(Date.now() / 1000);

        // Create the share content to encrypt
        // Includes the file key for zero-knowledge sharing
        const shareContent = JSON.stringify({
            fileName: shareInfo.fileName,
            fileSize: shareInfo.fileSize,
            fileMimeType: shareInfo.fileMimeType,
            fileSHA256: shareInfo.fileSHA256,
            fileURL: shareInfo.fileURL,
            fileKey: shareInfo.fileKey || null,     // File decryption key (hex)
            fileId: shareInfo.fileId || null,       // File ID for key reference
            encrypted: shareInfo.encrypted || false, // Whether file is encrypted
            message: shareInfo.message || '',
        });

        // Encrypt content for recipient using NIP-04
        const encryptedContent = await this.nip04Encrypt(shareInfo.recipientPubkey, shareContent);

        const event = {
            kind: 30080,  // File share kind
            created_at: now,
            tags: [
                ['d', shareInfo.id],
                ['p', shareInfo.recipientPubkey],
                ['file', `30078:${this.pubkey}:${shareInfo.fileId}`],
            ],
            content: encryptedContent,
        };

        // Add optional tags
        if (shareInfo.permission) {
            event.tags.push(['permission', shareInfo.permission]);
        }

        if (shareInfo.expiresAt) {
            event.tags.push(['expiration', shareInfo.expiresAt.toString()]);
        }

        // Add encrypted flag if file is encrypted
        if (shareInfo.encrypted) {
            event.tags.push(['encrypted', 'true']);
        }

        return this.signEvent(event);
    },

    // Create a share revocation event (kind 5 - NIP-09)
    async createShareRevokeEvent(shareId) {
        if (!this.isConnected || !this.pubkey) {
            throw new Error('Not connected');
        }

        const now = Math.floor(Date.now() / 1000);

        const event = {
            kind: 5,  // Deletion event
            created_at: now,
            tags: [
                ['a', `30080:${this.pubkey}:${shareId}`],
            ],
            content: 'revoked',
        };

        return this.signEvent(event);
    },

    // Publish a signed event to user's preferred relays (client-side publishing)
    // Uses RelayPrefs to determine where user wants their data published
    // See: ~/claude/coldforge/cloistr/architecture/relay-preferences.md
    async publishEvent(signedEvent) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }

        // Get user's relay preferences
        let prefs;
        if (typeof RelayPrefs !== 'undefined') {
            prefs = await RelayPrefs.getRelayPrefs(this.pubkey);
            console.log('Auth: Using relay preferences:', prefs.source, prefs.writeRelays);
        } else {
            // Fallback if RelayPrefs not loaded
            prefs = { writeRelays: ['wss://relay.cloistr.xyz'], source: 'fallback' };
        }

        // Collect all unique relay URLs to publish to
        const relayUrls = new Set(prefs.writeRelays);

        // For NIP-46, also include signer's relays (operational, but good to have data there too)
        if (this.connectionType === 'nip46' && typeof NIP46 !== 'undefined' && NIP46.relayUrls) {
            for (const url of NIP46.relayUrls) {
                relayUrls.add(url);
            }
        }

        // Publish to all relays in parallel
        const publishPromises = [];
        const results = new Map();

        for (const url of relayUrls) {
            publishPromises.push(
                this.publishToSingleRelay(url, signedEvent)
                    .then(r => { results.set(url, { success: true, result: r }); })
                    .catch(err => { results.set(url, { success: false, error: err.message }); })
            );
        }

        await Promise.all(publishPromises);

        // Count successes
        let successCount = 0;
        const successRelays = [];
        const failedRelays = [];

        for (const [url, result] of results) {
            if (result.success) {
                successCount++;
                successRelays.push(url);
            } else {
                failedRelays.push(url);
            }
        }

        if (successCount > 0) {
            console.log(`Auth: Event published to ${successCount}/${relayUrls.size} relays:`, successRelays);
            if (failedRelays.length > 0) {
                console.warn('Auth: Failed relays:', failedRelays);
            }
            return { success: true, published: successRelays, failed: failedRelays };
        }

        // All failed
        throw new Error('Failed to publish to any relay');
    },

    // Publish to a single relay
    async publishToSingleRelay(url, signedEvent) {
        // Use existing Relay module connection for relay.cloistr.xyz
        if (typeof Relay !== 'undefined' && url === Relay.defaultUrl) {
            return Relay.publish(signedEvent);
        }

        // For NIP-46 session relays, use NIP46.publishEvent
        if (typeof NIP46 !== 'undefined' && NIP46.relayUrls && NIP46.relayUrls.includes(url)) {
            // NIP46 publishes to all its relays, so just call once
            return NIP46.publishEvent(signedEvent);
        }

        // For other relays, open direct connection
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Timeout'));
            }, 10000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['EVENT', signedEvent]));
            };

            ws.onmessage = (msg) => {
                try {
                    const message = JSON.parse(msg.data);
                    if (message[0] === 'OK' && message[1] === signedEvent.id) {
                        clearTimeout(timeout);
                        ws.close();
                        if (message[2]) {
                            resolve({ success: true });
                        } else {
                            reject(new Error(message[3] || 'Rejected'));
                        }
                    }
                } catch (err) {
                    // Ignore parse errors
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Connection failed'));
            };
        });
    },

    // Disconnect
    disconnect() {
        // Disconnect NIP-46 if connected
        if (this.connectionType === 'nip46' && typeof NIP46 !== 'undefined') {
            NIP46.disconnect();
        }

        this.pubkey = null;
        this.isConnected = false;
        this.connectionType = null;
    },

    // Format pubkey for display (shortened)
    formatPubkey(pubkey) {
        if (!pubkey) return '';
        return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
    },
};
