// Authentication module for NIP-07 browser extension integration

const Auth = {
    pubkey: null,
    isConnected: false,

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
            return this.pubkey;
        } catch (err) {
            throw new Error(`Failed to connect: ${err.message}`);
        }
    },

    // Sign a Nostr event
    async signEvent(event) {
        if (!this.isConnected) {
            throw new Error('Not connected. Call connect() first.');
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

    // Create a file metadata event (kind 30078)
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

    // Disconnect
    disconnect() {
        this.pubkey = null;
        this.isConnected = false;
    },

    // Format pubkey for display (shortened)
    formatPubkey(pubkey) {
        if (!pubkey) return '';
        return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
    },
};
