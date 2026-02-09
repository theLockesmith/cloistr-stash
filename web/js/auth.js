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
