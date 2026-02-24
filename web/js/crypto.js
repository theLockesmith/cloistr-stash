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
    CHUNK_SIZE: 5 * 1024 * 1024,    // 5MB chunks for large file processing
    CHUNKED_THRESHOLD: 10 * 1024 * 1024, // Use chunked mode for files > 10MB

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
    async encryptFile(fileData, key, onProgress = null) {
        this.ensureInit();

        // Convert ArrayBuffer to Uint8Array if needed
        const data = fileData instanceof Uint8Array
            ? fileData
            : new Uint8Array(fileData);

        // Use chunked encryption for large files
        if (data.length > this.CHUNKED_THRESHOLD) {
            console.log(`Crypto: Using chunked encryption for ${this.formatSize(data.length)} file`);
            return this.encryptChunked(data, key, onProgress);
        }

        // Small files: encrypt in one shot
        return this.encrypt(data, key);
    },

    // Format file size for logging
    formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    },

    // Decrypt a file
    async decryptFile(encryptedData, key) {
        this.ensureInit();

        const data = encryptedData instanceof Uint8Array
            ? encryptedData
            : new Uint8Array(encryptedData);

        // Check if this is chunked data (starts with magic header)
        if (this.isChunkedData(data)) {
            return this.decryptChunked(data, key);
        }

        return this.decrypt(data, key);
    },

    // Check if data is chunked format
    isChunkedData(data) {
        // Magic header: "CLCH" (Cloistr Chunked)
        return data.length >= 4 &&
               data[0] === 0x43 && data[1] === 0x4C &&
               data[2] === 0x43 && data[3] === 0x48;
    },

    // Encrypt large file in chunks
    // Format: CLCH (4) | version (1) | chunk_size (4) | chunk_count (4) | base_nonce (24) | [chunk_data...]
    // Each chunk: encrypted_chunk (chunk_size + TAG_LENGTH)
    async encryptChunked(fileData, key, onProgress = null) {
        this.ensureInit();

        const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
        const chunkSize = this.CHUNK_SIZE;
        const chunkCount = Math.ceil(data.length / chunkSize);

        // Generate base nonce
        const baseNonce = this.generateNonce();

        // Calculate total output size
        // Header: 4 + 1 + 4 + 4 + 24 = 37 bytes
        // Each chunk: data + TAG_LENGTH
        const headerSize = 37;
        const totalChunksSize = data.length + (chunkCount * this.TAG_LENGTH);
        const totalSize = headerSize + totalChunksSize;

        const output = new Uint8Array(totalSize);
        let offset = 0;

        // Write header
        // Magic: CLCH
        output[offset++] = 0x43; // C
        output[offset++] = 0x4C; // L
        output[offset++] = 0x43; // C
        output[offset++] = 0x48; // H

        // Version: 1
        output[offset++] = 0x01;

        // Chunk size (4 bytes, big-endian)
        output[offset++] = (chunkSize >> 24) & 0xFF;
        output[offset++] = (chunkSize >> 16) & 0xFF;
        output[offset++] = (chunkSize >> 8) & 0xFF;
        output[offset++] = chunkSize & 0xFF;

        // Chunk count (4 bytes, big-endian)
        output[offset++] = (chunkCount >> 24) & 0xFF;
        output[offset++] = (chunkCount >> 16) & 0xFF;
        output[offset++] = (chunkCount >> 8) & 0xFF;
        output[offset++] = chunkCount & 0xFF;

        // Base nonce
        output.set(baseNonce, offset);
        offset += this.NONCE_LENGTH;

        // Encrypt each chunk
        for (let i = 0; i < chunkCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, data.length);
            const chunk = data.slice(start, end);

            // Derive nonce for this chunk (XOR base_nonce with chunk index)
            const chunkNonce = this.deriveChunkNonce(baseNonce, i);

            // Encrypt chunk
            const encrypted = this.sodium.crypto_secretbox_easy(chunk, chunkNonce, key);
            output.set(encrypted, offset);
            offset += encrypted.length;

            // Report progress
            if (onProgress) {
                onProgress((i + 1) / chunkCount);
            }

            // Yield to prevent blocking UI
            if (i % 10 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        return output;
    },

    // Decrypt chunked file
    async decryptChunked(encryptedData, key, onProgress = null) {
        this.ensureInit();

        let offset = 4; // Skip magic header

        // Read version
        const version = encryptedData[offset++];
        if (version !== 1) {
            throw new Error(`Unsupported chunk version: ${version}`);
        }

        // Read chunk size
        const chunkSize = (encryptedData[offset] << 24) |
                         (encryptedData[offset + 1] << 16) |
                         (encryptedData[offset + 2] << 8) |
                         encryptedData[offset + 3];
        offset += 4;

        // Read chunk count
        const chunkCount = (encryptedData[offset] << 24) |
                          (encryptedData[offset + 1] << 16) |
                          (encryptedData[offset + 2] << 8) |
                          encryptedData[offset + 3];
        offset += 4;

        // Read base nonce
        const baseNonce = encryptedData.slice(offset, offset + this.NONCE_LENGTH);
        offset += this.NONCE_LENGTH;

        // Calculate output size
        const encryptedChunkSize = chunkSize + this.TAG_LENGTH;
        const lastChunkEncryptedSize = encryptedData.length - offset - (chunkCount - 1) * encryptedChunkSize;
        const lastChunkPlainSize = lastChunkEncryptedSize - this.TAG_LENGTH;
        const totalPlainSize = (chunkCount - 1) * chunkSize + lastChunkPlainSize;

        const output = new Uint8Array(totalPlainSize);
        let outputOffset = 0;

        // Decrypt each chunk
        for (let i = 0; i < chunkCount; i++) {
            const isLastChunk = i === chunkCount - 1;
            const thisEncryptedSize = isLastChunk ? lastChunkEncryptedSize : encryptedChunkSize;
            const encryptedChunk = encryptedData.slice(offset, offset + thisEncryptedSize);
            offset += thisEncryptedSize;

            // Derive nonce for this chunk
            const chunkNonce = this.deriveChunkNonce(baseNonce, i);

            // Decrypt chunk
            const decrypted = this.sodium.crypto_secretbox_open_easy(encryptedChunk, chunkNonce, key);
            output.set(decrypted, outputOffset);
            outputOffset += decrypted.length;

            // Report progress
            if (onProgress) {
                onProgress((i + 1) / chunkCount);
            }

            // Yield to prevent blocking UI
            if (i % 10 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        return output;
    },

    // Derive nonce for a specific chunk (XOR base nonce with chunk index)
    deriveChunkNonce(baseNonce, chunkIndex) {
        const nonce = new Uint8Array(baseNonce);
        // XOR the last 4 bytes with chunk index
        const indexBytes = new Uint8Array(4);
        indexBytes[0] = (chunkIndex >> 24) & 0xFF;
        indexBytes[1] = (chunkIndex >> 16) & 0xFF;
        indexBytes[2] = (chunkIndex >> 8) & 0xFF;
        indexBytes[3] = chunkIndex & 0xFF;

        nonce[20] ^= indexBytes[0];
        nonce[21] ^= indexBytes[1];
        nonce[22] ^= indexBytes[2];
        nonce[23] ^= indexBytes[3];

        return nonce;
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
