// Cryptographic operations module - XChaCha20-Poly1305 encryption with libsodium
// This is the core zero-knowledge encryption layer for Cloistr Drive

const Crypto = {
    // Sodium library reference (set after initialization)
    sodium: null,
    initialized: false,

    // Constants
    KEY_LENGTH: 32,           // 256 bits for XChaCha20
    NONCE_LENGTH: 24,         // 192 bits for XChaCha20
    TAG_LENGTH: 16,           // Poly1305 authentication tag
    CHUNK_SIZE: 64 * 1024,    // 64KB chunks for streaming encryption

    // Initialize libsodium
    async init() {
        if (this.initialized) return true;

        try {
            // Wait for sodium to be ready
            await sodium.ready;
            this.sodium = sodium;
            this.initialized = true;
            console.log('Crypto: libsodium initialized');
            return true;
        } catch (err) {
            console.error('Crypto: Failed to initialize libsodium:', err);
            throw new Error('Failed to initialize encryption library');
        }
    },

    // Ensure initialized before any operation
    ensureInit() {
        if (!this.initialized || !this.sodium) {
            throw new Error('Crypto not initialized. Call Crypto.init() first.');
        }
    },

    // Generate a random 256-bit key
    generateKey() {
        this.ensureInit();
        return this.sodium.randombytes_buf(this.KEY_LENGTH);
    },

    // Generate a random nonce for XChaCha20
    generateNonce() {
        this.ensureInit();
        return this.sodium.randombytes_buf(this.NONCE_LENGTH);
    },

    // Generate a random file ID (32 bytes hex = 64 chars)
    generateFileId() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return this.bytesToHex(bytes);
    },

    // Encrypt data with XChaCha20-Poly1305
    // Returns: nonce (24 bytes) || ciphertext || tag (16 bytes)
    encrypt(plaintext, key) {
        this.ensureInit();

        // Ensure plaintext is Uint8Array
        const data = plaintext instanceof Uint8Array
            ? plaintext
            : new Uint8Array(plaintext);

        // Ensure key is Uint8Array
        const keyBytes = key instanceof Uint8Array
            ? key
            : this.hexToBytes(key);

        if (keyBytes.length !== this.KEY_LENGTH) {
            throw new Error(`Invalid key length: ${keyBytes.length}, expected ${this.KEY_LENGTH}`);
        }

        // Generate random nonce
        const nonce = this.generateNonce();

        // Encrypt with XChaCha20-Poly1305
        const ciphertext = this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            data,
            null,  // additional data (AAD)
            null,  // secret nonce (unused)
            nonce,
            keyBytes
        );

        // Prepend nonce to ciphertext
        const result = new Uint8Array(nonce.length + ciphertext.length);
        result.set(nonce, 0);
        result.set(ciphertext, nonce.length);

        return result;
    },

    // Decrypt data with XChaCha20-Poly1305
    // Input: nonce (24 bytes) || ciphertext || tag (16 bytes)
    decrypt(ciphertextWithNonce, key) {
        this.ensureInit();

        // Ensure input is Uint8Array
        const data = ciphertextWithNonce instanceof Uint8Array
            ? ciphertextWithNonce
            : new Uint8Array(ciphertextWithNonce);

        // Ensure key is Uint8Array
        const keyBytes = key instanceof Uint8Array
            ? key
            : this.hexToBytes(key);

        if (keyBytes.length !== this.KEY_LENGTH) {
            throw new Error(`Invalid key length: ${keyBytes.length}, expected ${this.KEY_LENGTH}`);
        }

        if (data.length < this.NONCE_LENGTH + this.TAG_LENGTH) {
            throw new Error('Ciphertext too short');
        }

        // Extract nonce and ciphertext
        const nonce = data.slice(0, this.NONCE_LENGTH);
        const ciphertext = data.slice(this.NONCE_LENGTH);

        // Decrypt with XChaCha20-Poly1305
        try {
            return this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,  // secret nonce (unused)
                ciphertext,
                null,  // additional data (AAD)
                nonce,
                keyBytes
            );
        } catch (err) {
            throw new Error('Decryption failed: invalid key or corrupted data');
        }
    },

    // Encrypt a file (ArrayBuffer or Uint8Array)
    // Returns encrypted blob ready for upload
    async encryptFile(fileData, key) {
        this.ensureInit();

        // Convert ArrayBuffer to Uint8Array if needed
        const data = fileData instanceof Uint8Array
            ? fileData
            : new Uint8Array(fileData);

        // For large files, we could implement streaming encryption
        // For now, encrypt in one shot (works well up to ~100MB)
        return this.encrypt(data, key);
    },

    // Decrypt a file
    async decryptFile(encryptedData, key) {
        this.ensureInit();

        const data = encryptedData instanceof Uint8Array
            ? encryptedData
            : new Uint8Array(encryptedData);

        return this.decrypt(data, key);
    },

    // Encrypt a string (UTF-8)
    encryptString(plaintext, key) {
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);
        return this.encrypt(data, key);
    },

    // Decrypt to string (UTF-8)
    decryptString(ciphertext, key) {
        const data = this.decrypt(ciphertext, key);
        const decoder = new TextDecoder();
        return decoder.decode(data);
    },

    // Encrypt JSON object
    encryptJSON(obj, key) {
        const json = JSON.stringify(obj);
        return this.encryptString(json, key);
    },

    // Decrypt to JSON object
    decryptJSON(ciphertext, key) {
        const json = this.decryptString(ciphertext, key);
        return JSON.parse(json);
    },

    // Calculate SHA-256 hash of data
    async hash(data) {
        const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        return this.bytesToHex(new Uint8Array(hashBuffer));
    },

    // Hash a file and return hex string
    async hashFile(file) {
        const buffer = await file.arrayBuffer();
        return this.hash(buffer);
    },

    // Utility: bytes to hex string
    bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    // Utility: hex string to bytes
    hexToBytes(hex) {
        if (hex.length % 2 !== 0) {
            throw new Error('Invalid hex string');
        }
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    },

    // Utility: bytes to base64
    bytesToBase64(bytes) {
        const binary = String.fromCharCode.apply(null, bytes);
        return btoa(binary);
    },

    // Utility: base64 to bytes
    base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    },

    // Utility: bytes to base64url (URL-safe, no padding)
    bytesToBase64url(bytes) {
        return this.bytesToBase64(bytes)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    },

    // Utility: base64url to bytes
    base64urlToBytes(base64url) {
        let base64 = base64url
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        // Add padding if needed
        while (base64.length % 4) {
            base64 += '=';
        }
        return this.base64ToBytes(base64);
    },

    // Compare two byte arrays in constant time (for key comparison)
    constantTimeEqual(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff === 0;
    },

    // Securely wipe a key from memory (best effort in JS)
    wipeKey(key) {
        if (key instanceof Uint8Array) {
            this.sodium?.memzero(key);
        }
    },
};

// Auto-initialize when script loads (non-blocking)
(async () => {
    // Check if sodium is loaded
    if (typeof sodium !== 'undefined') {
        try {
            await Crypto.init();
        } catch (err) {
            console.warn('Crypto: Deferred initialization - sodium not ready');
        }
    }
})();
